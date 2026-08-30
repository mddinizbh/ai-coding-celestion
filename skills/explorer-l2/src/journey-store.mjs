/**
 * SQLite store for L2 journey specs + bind results.
 * Shares the same DB file as L0/L1; does not modify L0 packages or L1 edges.
 *
 * ADR 0009 (id_version=2): bind_id is `l2:bind:<32-hex>` derived from the
 * journey identity. specRevisionOf folds ID_VERSION into the spec hash so a
 * version bump invalidates the spec revision too.
 *
 * ADR 0009 (Todo 8b): component-scoped schema versioning via
 * `explorer_schema_versions(component='explorer-l2')`. Never the global
 * `PRAGMA user_version`. Forward-only; opening a DB that records a future
 * version throws `UnsupportedSchemaVersionError` before any write.
 */

import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  ID_VERSION,
  makeL2BindId,
  makeL2JourneyId,
} from "../../explorer-l0/src/layered-id.mjs";
import {
  assertComponentSchemaVersionSupported,
  migrateLayerTableNames,
  migrateComponentSchema,
  UnsupportedSchemaVersionError,
} from "../../explorer-l0/src/schema-versions.mjs";
import { stablePretty, stableStringify, sha256Text } from "../../explorer-l0/src/stable-json.mjs";

export class JourneyStoreError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "JourneyStoreError";
  }
}

/** Component key in the shared `explorer_schema_versions` table. */
export const L2_COMPONENT = "explorer-l2";
/** Highest L2 schema version this module produces. v2 = layered ids. */
export const L2_SCHEMA_SUPPORTED_VERSION = 2;

/** Re-export so callers can catch by type without knowing the source module. */
export { UnsupportedSchemaVersionError };

const SCHEMA_V1_DDL = `
CREATE TABLE IF NOT EXISTS l2_journey_specs (
  system_namespace TEXT NOT NULL,
  journey_id TEXT NOT NULL,
  spec_revision TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (system_namespace, journey_id, spec_revision)
);

CREATE TABLE IF NOT EXISTS l2_journey_binds (
  bind_id TEXT PRIMARY KEY,
  system_namespace TEXT NOT NULL,
  journey_id TEXT NOT NULL,
  spec_revision TEXT NOT NULL,
  journey_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  steps_bound INTEGER NOT NULL,
  steps_gap INTEGER NOT NULL,
  members_json TEXT NOT NULL,
  bind_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_l2_journey_binds_ns_id
  ON l2_journey_binds(system_namespace, journey_id, created_at DESC);

CREATE TABLE IF NOT EXISTS l2_journey_step_edges (
  bind_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  step_status TEXT NOT NULL,
  PRIMARY KEY (bind_id, step_id, edge_id)
);
CREATE INDEX IF NOT EXISTS idx_l2_journey_step_edges_edge
  ON l2_journey_step_edges(edge_id);

CREATE TABLE IF NOT EXISTS l2_journey_current (
  system_namespace TEXT NOT NULL,
  journey_id TEXT NOT NULL,
  bind_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (system_namespace, journey_id)
);
`;

/**
 * v2 DDL: id_version column on l2_journey_binds so persisted rows carry the
 * layered identity version. Forward-only; existing v1 rows keep default 1
 * until they are re-derived (via slice-migrate rebuild phase).
 */
const SCHEMA_V2_DDL = `ALTER TABLE l2_journey_binds ADD COLUMN id_version INTEGER NOT NULL DEFAULT 1;`;

/** @internal Step list used by migrateComponentSchema. */
export const L2_MIGRATION_STEPS = [
  { fromVersion: 0, ddl: SCHEMA_V1_DDL },
  { fromVersion: 1, ddl: SCHEMA_V2_DDL },
];

/**
 * @param {string} dbPath
 */
export function openJourneyStore(dbPath) {
  if (typeof dbPath !== "string" || dbPath === "") {
    throw new JourneyStoreError("dbPath required");
  }
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  try {
    assertComponentSchemaVersionSupported(
      db,
      L2_COMPONENT,
      L2_SCHEMA_SUPPORTED_VERSION,
    );
    migrateLayerTableNames(db, JourneyStoreError);
    migrateComponentSchema({
      db,
      component: L2_COMPONENT,
      supportedVersion: L2_SCHEMA_SUPPORTED_VERSION,
      steps: L2_MIGRATION_STEPS,
      errorCtor: JourneyStoreError,
    });
  } catch (err) {
    db.close();
    throw err;
  }
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    // best-effort
  }
  return {
    _db: db,
    dbPath,
    close() {
      db.close();
    },
  };
}

/**
 * Content hash of the journey spec (stable JSON). Folds ID_VERSION into the
 * material so a version bump invalidates the spec revision.
 * @param {object} spec
 */
export function specRevisionOf(spec) {
  const material = {
    id_version: ID_VERSION,
    id: spec.id,
    system_namespace: spec.system_namespace,
    members: spec.members ?? [],
    description: spec.description ?? "",
    steps: (spec.steps ?? []).map((s) => ({
      id: s.id,
      trigger: s.trigger,
      from: s.from ?? null,
      to: s.to ?? null,
      contract_prefix: s.contract_prefix ?? null,
      contract_key: s.contract_key ?? null,
      description: s.description ?? null,
    })),
    read_plan: (spec.read_plan ?? []).map((item) => ({
      id: item.id,
      step_id: item.step_id,
      repo: item.repo ?? null,
      trigger: item.trigger ?? null,
      reason: item.reason ?? null,
      read_kind: item.read_kind ?? null,
      file: item.file,
      line: item.line ?? null,
      symbol_id: item.symbol_id ?? null,
      relation_type: item.relation_type ?? null,
      status: item.status,
    })),
  };
  return sha256Text(stableStringify(material)).slice(0, 32);
}

/**
 * Bind id (id_version=2): `l2:bind:<32-hex>` derived from journey identity.
 * @param {string} systemNamespace
 * @param {string} journeyId  raw spec id (without l2:journey: prefix)
 * @param {string} journeyHash
 */
export function makeBindId(systemNamespace, journeyId, journeyHash) {
  const material = `${systemNamespace}|${journeyId}|${journeyHash}`;
  return makeL2BindId(material);
}

/**
 * Persist spec + bind result; upsert l2_journey_current to this bind.
 *
 * @param {ReturnType<typeof openJourneyStore>} store
 * @param {{
 *   spec: object,
 *   bind: object,
 *   set_current?: boolean,
 * }} input
 */
export function persistJourneyBind(store, input) {
  const spec = input?.spec;
  const bind = input?.bind;
  if (!spec?.id || !spec.system_namespace) {
    throw new JourneyStoreError("spec.id and spec.system_namespace required");
  }
  if (!bind?.journey_id || !bind.journey_hash || !bind.system_namespace) {
    throw new JourneyStoreError("bind.journey_id, journey_hash, system_namespace required");
  }
  // bind.journey_id is the prefixed v2 form (l2:journey:<spec.id>); compare
  // against the prefixed spec.id so the invariant still holds (ADR 0009).
  if (makeL2JourneyId(spec.id) !== bind.journey_id) {
    throw new JourneyStoreError("bind.journey_id must be the v2 form of spec.id");
  }
  if (spec.system_namespace !== bind.system_namespace) {
    throw new JourneyStoreError("spec.system_namespace must match bind.system_namespace");
  }

  const specRevision = specRevisionOf(spec);
  // Bind id derives from the RAW spec.id (not the prefixed journey_id) so the
  // bind material is stable across read-back paths.
  const bindId = makeBindId(bind.system_namespace, spec.id, bind.journey_hash);
  const now = new Date().toISOString();
  const setCurrent = input.set_current !== false;

  const insertSpec = store._db.prepare(`
    INSERT OR IGNORE INTO l2_journey_specs (
      system_namespace, journey_id, spec_revision, spec_json, created_at
    ) VALUES (?,?,?,?,?)
  `);
  const insertBind = store._db.prepare(`
    INSERT OR IGNORE INTO l2_journey_binds (
      bind_id, system_namespace, journey_id, spec_revision, journey_hash,
      status, steps_bound, steps_gap, members_json, bind_json, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `);
  const deleteSteps = store._db.prepare(
    `DELETE FROM l2_journey_step_edges WHERE bind_id = ?`,
  );
  const insertStep = store._db.prepare(`
    INSERT INTO l2_journey_step_edges (bind_id, step_id, edge_id, step_status)
    VALUES (?,?,?,?)
  `);
  const upsertCurrent = store._db.prepare(`
    INSERT INTO l2_journey_current (system_namespace, journey_id, bind_id, updated_at)
    VALUES (?,?,?,?)
    ON CONFLICT(system_namespace, journey_id) DO UPDATE SET
      bind_id = excluded.bind_id,
      updated_at = excluded.updated_at
  `);

  const begin = store._db.prepare("BEGIN");
  const commit = store._db.prepare("COMMIT");
  const rollback = store._db.prepare("ROLLBACK");

  begin.run();
  try {
    const specIns = insertSpec.run(
      spec.system_namespace,
      // Store the prefixed v2 journey_id so all persisted rows share the
      // canonical layer-prefixed identity (ADR 0009 grep guard).
      bind.journey_id,
      specRevision,
      stablePretty(spec),
      now,
    );
    const bindIns = insertBind.run(
      bindId,
      bind.system_namespace,
      bind.journey_id,
      specRevision,
      bind.journey_hash,
      bind.status ?? "partial",
      bind.steps_bound ?? 0,
      bind.steps_gap ?? 0,
      stablePretty(bind.members ?? spec.members ?? []),
      stablePretty(bind),
      now,
    );

    // Always refresh step index for this bind_id (idempotent re-persist).
    deleteSteps.run(bindId);
    let stepEdges = 0;
    for (const step of bind.bound ?? []) {
      const status = step.status === "bound" ? "bound" : "gap";
      const edgeIds =
        status === "bound" && Array.isArray(step.edge_ids) && step.edge_ids.length > 0
          ? step.edge_ids
          : ["__gap__"];
      for (const edgeId of edgeIds) {
        insertStep.run(bindId, step.step_id, edgeId, status);
        stepEdges += 1;
      }
    }

    if (setCurrent) {
      upsertCurrent.run(bind.system_namespace, bind.journey_id, bindId, now);
    }

    commit.run();
    return {
      bind_id: bindId,
      journey_id: bind.journey_id,
      system_namespace: bind.system_namespace,
      spec_revision: specRevision,
      journey_hash: bind.journey_hash,
      status: bind.status,
      steps_bound: bind.steps_bound,
      steps_gap: bind.steps_gap,
      step_edge_rows: stepEdges,
      spec_created: specIns.changes === 1,
      bind_created: bindIns.changes === 1,
      set_current: setCurrent,
      created_at: now,
    };
  } catch (err) {
    rollback.run();
    throw new JourneyStoreError("persistJourneyBind failed", { cause: err });
  }
}

/**
 * @param {ReturnType<typeof openJourneyStore>} store
 * @param {string} systemNamespace
 */
export function listJourneys(store, systemNamespace) {
  if (!systemNamespace) throw new JourneyStoreError("systemNamespace required");
  const rows = store._db
    .prepare(
      `
      SELECT c.journey_id, c.bind_id, c.updated_at,
              b.status, b.steps_bound, b.steps_gap, b.journey_hash, b.spec_revision,
              b.bind_json, b.created_at
      FROM l2_journey_current c
      JOIN l2_journey_binds b ON b.bind_id = c.bind_id
      WHERE c.system_namespace = ?
      ORDER BY c.journey_id ASC
    `,
    )
    .all(systemNamespace);
  return rows.map((r) => {
    const bind = JSON.parse(r.bind_json);
    return {
      journey_id: r.journey_id,
      bind_id: r.bind_id,
      status: r.status,
      structural_status: bind.structural_status || r.status,
      understanding_status: bind.understanding_status || "unverified",
      code_reads_total: bind.code_reads_total || 0,
      code_reads_pending: bind.code_reads_pending || 0,
      steps_bound: r.steps_bound,
      steps_gap: r.steps_gap,
      journey_hash: r.journey_hash,
      spec_revision: r.spec_revision,
      bind_created_at: r.created_at,
      current_updated_at: r.updated_at,
    };
  });
}

/**
 * Accept either the raw spec.id or the v2 prefixed `l2:journey:<id>` form
 * when looking up journey rows. Returns the prefixed form for SQL params.
 * @param {string} journeyId
 */
function normalizeJourneyIdLookup(journeyId) {
  if (typeof journeyId !== "string" || journeyId === "") {
    throw new JourneyStoreError("journey_id required");
  }
  return journeyId.startsWith("l2:journey:") ? journeyId : makeL2JourneyId(journeyId);
}

/**
 * @param {ReturnType<typeof openJourneyStore>} store
 * @param {{ system_namespace: string, journey_id: string, bind_id?: string }} q
 */
export function showJourney(store, q) {
  if (!q.system_namespace || !q.journey_id) {
    throw new JourneyStoreError("system_namespace and journey_id required");
  }
  const journeyId = normalizeJourneyIdLookup(q.journey_id);
  let bindId = q.bind_id;
  if (!bindId) {
    const cur = store._db
      .prepare(
        `SELECT bind_id FROM l2_journey_current
         WHERE system_namespace = ? AND journey_id = ?`,
      )
      .get(q.system_namespace, journeyId);
    bindId = cur?.bind_id;
  }
  if (!bindId) {
    return null;
  }
  const row = store._db
    .prepare(`SELECT * FROM l2_journey_binds WHERE bind_id = ?`)
    .get(bindId);
  if (!row) return null;
  const spec = store._db
    .prepare(
      `SELECT spec_json FROM l2_journey_specs
       WHERE system_namespace = ? AND journey_id = ? AND spec_revision = ?`,
    )
    .get(row.system_namespace, row.journey_id, row.spec_revision);
  const steps = store._db
    .prepare(
      `SELECT step_id, edge_id, step_status FROM l2_journey_step_edges
       WHERE bind_id = ? ORDER BY step_id, edge_id`,
    )
    .all(bindId);
  return {
    bind_id: row.bind_id,
    system_namespace: row.system_namespace,
    journey_id: row.journey_id,
    spec_revision: row.spec_revision,
    journey_hash: row.journey_hash,
    status: row.status,
    steps_bound: row.steps_bound,
    steps_gap: row.steps_gap,
    members: JSON.parse(row.members_json),
    bind: JSON.parse(row.bind_json),
    spec: spec ? JSON.parse(spec.spec_json) : null,
    step_edges: steps,
    created_at: row.created_at,
  };
}

/**
 * Journeys (current bind) that include this L1 edge_id.
 * @param {ReturnType<typeof openJourneyStore>} store
 * @param {{ system_namespace?: string, edge_id: string }} q
 */
export function journeysForEdge(store, q) {
  if (!q.edge_id) throw new JourneyStoreError("edge_id required");
  let sql = `
    SELECT se.step_id, se.edge_id, se.step_status,
           b.bind_id, b.journey_id, b.system_namespace, b.status,
            b.steps_bound, b.steps_gap, b.journey_hash, b.bind_json,
           CASE WHEN c.bind_id IS NOT NULL THEN 1 ELSE 0 END AS is_current
    FROM l2_journey_step_edges se
    JOIN l2_journey_binds b ON b.bind_id = se.bind_id
    LEFT JOIN l2_journey_current c
      ON c.bind_id = b.bind_id
     AND c.system_namespace = b.system_namespace
     AND c.journey_id = b.journey_id
    WHERE se.edge_id = ? AND se.step_status = 'bound'
  `;
  /** @type {unknown[]} */
  const params = [q.edge_id];
  if (q.system_namespace) {
    sql += ` AND b.system_namespace = ?`;
    params.push(q.system_namespace);
  }
  sql += ` ORDER BY is_current DESC, b.journey_id ASC`;
  return store._db.prepare(sql).all(...params).map((r) => {
    const bind = JSON.parse(r.bind_json);
    return {
      journey_id: r.journey_id,
      bind_id: r.bind_id,
      system_namespace: r.system_namespace,
      step_id: r.step_id,
      edge_id: r.edge_id,
      status: r.status,
      structural_status: bind.structural_status || r.status,
      understanding_status: bind.understanding_status || "unverified",
      code_reads_pending: bind.code_reads_pending || 0,
      steps_bound: r.steps_bound,
      steps_gap: r.steps_gap,
      journey_hash: r.journey_hash,
      is_current: r.is_current === 1,
    };
  });
}

/**
 * @param {ReturnType<typeof openJourneyStore>} store
 * @param {string} systemNamespace
 */
export function journeyStats(store, systemNamespace) {
  const specs = store._db
    .prepare(
      `SELECT COUNT(*) AS n FROM l2_journey_specs WHERE system_namespace = ?`,
    )
    .get(systemNamespace);
  const binds = store._db
    .prepare(
      `SELECT COUNT(*) AS n FROM l2_journey_binds WHERE system_namespace = ?`,
    )
    .get(systemNamespace);
  const current = store._db
    .prepare(
      `SELECT COUNT(*) AS n FROM l2_journey_current WHERE system_namespace = ?`,
    )
    .get(systemNamespace);
  return {
    system_namespace: systemNamespace,
    specs: specs?.n ?? 0,
    binds: binds?.n ?? 0,
    current: current?.n ?? 0,
  };
}
