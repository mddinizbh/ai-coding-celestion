/**
 * SQLite store for L1 system edges. Does not modify l0_candidate_packages.
 *
 * ADR 0009 (Todo 8b): component-scoped schema versioning via
 * `explorer_schema_versions(component='explorer-l1')`. Never the global
 * `PRAGMA user_version`. Forward-only; opening a DB that records a future
 * version throws `UnsupportedSchemaVersionError` before any write.
 */

import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SystemStoreError } from "./errors.mjs";
import {
  assertComponentSchemaVersionSupported,
  migrateLayerTableNames,
  migrateComponentSchema,
  UnsupportedSchemaVersionError,
} from "../../explorer-l0/src/schema-versions.mjs";
import { stablePretty } from "../../explorer-l0/src/stable-json.mjs";

/** Component key in the shared `explorer_schema_versions` table. */
export const L1_COMPONENT = "explorer-l1";
/**
 * Highest L1 schema version this module produces.
 * v2 = layered ids. v3 = composite PK (system_namespace, edge_id) so two
 * system namespaces can own the same edge_id without silent drops.
 */
export const L1_SCHEMA_SUPPORTED_VERSION = 3;

/** Re-export so callers can catch by type without knowing the source module. */
export { UnsupportedSchemaVersionError };

const SCHEMA_V1_DDL = `
CREATE TABLE IF NOT EXISTS l1_system_edges (
  edge_id TEXT PRIMARY KEY,
  system_namespace TEXT NOT NULL,
  from_namespace TEXT NOT NULL,
  from_logical_repo TEXT NOT NULL,
  from_fact_id TEXT NOT NULL,
  to_namespace TEXT NOT NULL,
  to_logical_repo TEXT NOT NULL,
  to_fact_id TEXT NOT NULL,
  contract_key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  evidence_class TEXT NOT NULL,
  match_kind TEXT NOT NULL,
  score REAL NOT NULL,
  config_key TEXT,
  edge_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_l1_system_edges_ns ON l1_system_edges(system_namespace);
CREATE INDEX IF NOT EXISTS idx_l1_system_edges_from ON l1_system_edges(system_namespace, from_logical_repo);
CREATE INDEX IF NOT EXISTS idx_l1_system_edges_to ON l1_system_edges(system_namespace, to_logical_repo);
CREATE INDEX IF NOT EXISTS idx_l1_system_edges_contract ON l1_system_edges(system_namespace, contract_key);

CREATE TABLE IF NOT EXISTS l1_system_stitch_runs (
  run_id TEXT PRIMARY KEY,
  system_namespace TEXT NOT NULL,
  repos_json TEXT NOT NULL,
  edge_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`;

/**
 * v2 DDL: id_version column on l1_system_edges so persisted rows carry the
 * layered identity version. Forward-only; existing v1 rows keep default 1
 * until they are re-derived (via slice-migrate rebuild phase).
 */
const SCHEMA_V2_DDL = `ALTER TABLE l1_system_edges ADD COLUMN id_version INTEGER NOT NULL DEFAULT 1;`;

/**
 * v3 DDL: rebuild l1_system_edges with composite PRIMARY KEY
 * (system_namespace, edge_id).
 *
 * The v1/v2 sole `edge_id` PK silently dropped legitimate edges when two
 * system namespaces stitched the same pair of facts (INSERT OR IGNORE counted
 * the second as `skipped`). Lossless migration: the old PK guarantees no
 * duplicate edge_id rows exist, so the composite-PK copy cannot collide.
 * Runs inside the migrateComponentSchema transaction (BEGIN IMMEDIATE).
 */
const SCHEMA_V3_DDL = `
CREATE TABLE l1_system_edges_v3 (
  system_namespace TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  from_namespace TEXT NOT NULL,
  from_logical_repo TEXT NOT NULL,
  from_fact_id TEXT NOT NULL,
  to_namespace TEXT NOT NULL,
  to_logical_repo TEXT NOT NULL,
  to_fact_id TEXT NOT NULL,
  contract_key TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  evidence_class TEXT NOT NULL,
  match_kind TEXT NOT NULL,
  score REAL NOT NULL,
  config_key TEXT,
  edge_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  id_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (system_namespace, edge_id)
);
INSERT INTO l1_system_edges_v3 (
  system_namespace, edge_id,
  from_namespace, from_logical_repo, from_fact_id,
  to_namespace, to_logical_repo, to_fact_id,
  contract_key, method, path, evidence_class, match_kind, score, config_key,
  edge_json, created_at, id_version
) SELECT
  system_namespace, edge_id,
  from_namespace, from_logical_repo, from_fact_id,
  to_namespace, to_logical_repo, to_fact_id,
  contract_key, method, path, evidence_class, match_kind, score, config_key,
  edge_json, created_at, id_version
FROM l1_system_edges;
DROP TABLE l1_system_edges;
ALTER TABLE l1_system_edges_v3 RENAME TO l1_system_edges;
CREATE INDEX IF NOT EXISTS idx_l1_system_edges_ns ON l1_system_edges(system_namespace);
CREATE INDEX IF NOT EXISTS idx_l1_system_edges_from ON l1_system_edges(system_namespace, from_logical_repo);
CREATE INDEX IF NOT EXISTS idx_l1_system_edges_to ON l1_system_edges(system_namespace, to_logical_repo);
CREATE INDEX IF NOT EXISTS idx_l1_system_edges_contract ON l1_system_edges(system_namespace, contract_key);
`;

/** @internal Step list used by migrateComponentSchema. */
export const L1_MIGRATION_STEPS = [
  { fromVersion: 0, ddl: SCHEMA_V1_DDL },
  { fromVersion: 1, ddl: SCHEMA_V2_DDL },
  { fromVersion: 2, ddl: SCHEMA_V3_DDL },
];

/**
 * @param {string} dbPath
 */
export function openSystemStore(dbPath) {
  if (typeof dbPath !== "string" || dbPath === "") {
    throw new SystemStoreError("dbPath required");
  }
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  try {
    assertComponentSchemaVersionSupported(
      db,
      L1_COMPONENT,
      L1_SCHEMA_SUPPORTED_VERSION,
    );
    migrateLayerTableNames(db, SystemStoreError);
    migrateComponentSchema({
      db,
      component: L1_COMPONENT,
      supportedVersion: L1_SCHEMA_SUPPORTED_VERSION,
      steps: L1_MIGRATION_STEPS,
      errorCtor: SystemStoreError,
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
 * Persist edges idempotently. Since schema v3 the PRIMARY KEY is
 * (system_namespace, edge_id): re-persisting the same edge in the same
 * namespace is a no-op, and two namespaces owning the same edge_id no longer
 * collide.
 *
 * @param {ReturnType<typeof openSystemStore>} store
 * @param {string} systemNamespace
 * @param {import("./matcher.mjs").SystemEdge[]} edges
 * @returns {{ inserted: number, skipped: number }}
 */
export function persistSystemEdges(store, systemNamespace, edges) {
  if (!systemNamespace || typeof systemNamespace !== "string") {
    throw new SystemStoreError("systemNamespace required");
  }
  if (!Array.isArray(edges)) throw new SystemStoreError("edges must be array");

  const insert = store._db.prepare(`
    INSERT OR IGNORE INTO l1_system_edges (
      edge_id, system_namespace,
      from_namespace, from_logical_repo, from_fact_id,
      to_namespace, to_logical_repo, to_fact_id,
      contract_key, method, path, evidence_class, match_kind, score, config_key,
      edge_json, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  let inserted = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  store._db.prepare("BEGIN").run();
  try {
    for (const e of edges) {
      const r = insert.run(
        e.edge_id,
        systemNamespace,
        e.from.namespace,
        e.from.logical_repo,
        e.from.fact_id,
        e.to.namespace,
        e.to.logical_repo,
        e.to.fact_id,
        e.contract_key,
        e.method,
        e.path,
        e.evidence_class,
        e.match_kind,
        e.score,
        e.config_key ?? null,
        stablePretty(e),
        now,
      );
      if (r.changes === 1) inserted += 1;
      else skipped += 1;
    }
    store._db.prepare("COMMIT").run();
  } catch (err) {
    store._db.prepare("ROLLBACK").run();
    throw new SystemStoreError("persist failed", { cause: err });
  }
  return { inserted, skipped };
}

/**
 * Replace the edges of a stitch scope atomically: delete the edges the run is
 * responsible for, then insert the fresh set — one transaction, so a crash
 * mid-run never leaves the namespace partially empty.
 *
 * The wipe is scoped to `scopeRepos` (edges whose from AND to are both in the
 * run's repo set), NOT to the whole namespace: a partial stitch (`--pair a->b`
 * with a subset of repos) must not destroy edges that involve repos outside
 * the run. A full-system restitch passes all repos, which wipes and replaces
 * the entire system's edges — superseding duplicates from previous extractor
 * runs instead of accumulating them.
 *
 * @param {ReturnType<typeof openSystemStore>} store
 * @param {string} systemNamespace
 * @param {import("./matcher.mjs").SystemEdge[]} edges
 * @param {string[]} scopeRepos logical repos covered by this stitch run
 * @returns {{ removed: number, inserted: number, skipped: number }}
 */
export function replaceSystemEdges(store, systemNamespace, edges, scopeRepos) {
  if (!systemNamespace || typeof systemNamespace !== "string") {
    throw new SystemStoreError("systemNamespace required");
  }
  if (!Array.isArray(edges)) throw new SystemStoreError("edges must be array");
  if (
    !Array.isArray(scopeRepos) ||
    scopeRepos.length === 0 ||
    scopeRepos.some((r) => !r || typeof r !== "string")
  ) {
    throw new SystemStoreError("scopeRepos must be a non-empty string array");
  }

  const scopePlaceholders = scopeRepos.map(() => "?").join(",");
  const wipe = store._db.prepare(
    `DELETE FROM l1_system_edges
     WHERE system_namespace = ?
       AND from_logical_repo IN (${scopePlaceholders})
       AND to_logical_repo IN (${scopePlaceholders})`,
  );
  const wipeParams = [systemNamespace, ...scopeRepos, ...scopeRepos];

  const insert = store._db.prepare(`
    INSERT OR IGNORE INTO l1_system_edges (
      edge_id, system_namespace,
      from_namespace, from_logical_repo, from_fact_id,
      to_namespace, to_logical_repo, to_fact_id,
      contract_key, method, path, evidence_class, match_kind, score, config_key,
      edge_json, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  let removed = 0;
  let inserted = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  store._db.prepare("BEGIN IMMEDIATE").run();
  try {
    removed = wipe.run(...wipeParams).changes;
    for (const e of edges) {
      const r = insert.run(
        e.edge_id,
        systemNamespace,
        e.from.namespace,
        e.from.logical_repo,
        e.from.fact_id,
        e.to.namespace,
        e.to.logical_repo,
        e.to.fact_id,
        e.contract_key,
        e.method,
        e.path,
        e.evidence_class,
        e.match_kind,
        e.score,
        e.config_key ?? null,
        stablePretty(e),
        now,
      );
      if (r.changes === 1) inserted += 1;
      else skipped += 1;
    }
    store._db.prepare("COMMIT").run();
  } catch (err) {
    store._db.prepare("ROLLBACK").run();
    throw new SystemStoreError("replace failed", { cause: err });
  }
  return { removed, inserted, skipped };
}

/**
 * @param {ReturnType<typeof openSystemStore>} store
 * @param {{ system_namespace: string, from_repo?: string, to_repo?: string, contract_key?: string }} q
 */
export function listSystemEdges(store, q) {
  let sql = `SELECT edge_json FROM l1_system_edges WHERE system_namespace = ?`;
  /** @type {unknown[]} */
  const params = [q.system_namespace];
  if (q.from_repo) {
    sql += ` AND from_logical_repo = ?`;
    params.push(q.from_repo);
  }
  if (q.to_repo) {
    sql += ` AND to_logical_repo = ?`;
    params.push(q.to_repo);
  }
  if (q.contract_key) {
    sql += ` AND contract_key = ?`;
    params.push(q.contract_key);
  }
  sql += ` ORDER BY score DESC, edge_id ASC`;
  return store._db
    .prepare(sql)
    .all(...params)
    .map((row) => JSON.parse(/** @type {string} */ (row.edge_json)));
}

/**
 * @param {ReturnType<typeof openSystemStore>} store
 * @param {string} systemNamespace
 * @param {string} logicalRepo
 * @param {"from"|"to"|"both"} [side]
 */
export function edgesForRepo(store, systemNamespace, logicalRepo, side = "both") {
  if (side === "from") {
    return listSystemEdges(store, { system_namespace: systemNamespace, from_repo: logicalRepo });
  }
  if (side === "to") {
    return listSystemEdges(store, { system_namespace: systemNamespace, to_repo: logicalRepo });
  }
  const a = listSystemEdges(store, { system_namespace: systemNamespace, from_repo: logicalRepo });
  const b = listSystemEdges(store, { system_namespace: systemNamespace, to_repo: logicalRepo });
  const byId = new Map();
  for (const e of [...a, ...b]) byId.set(e.edge_id, e);
  return [...byId.values()];
}

/**
 * @param {ReturnType<typeof openSystemStore>} store
 * @param {string} systemNamespace
 */
export function systemStats(store, systemNamespace) {
  const row = store._db
    .prepare(
      `SELECT COUNT(*) AS n,
              COUNT(DISTINCT from_logical_repo) AS from_repos,
              COUNT(DISTINCT to_logical_repo) AS to_repos
       FROM l1_system_edges WHERE system_namespace = ?`,
    )
    .get(systemNamespace);
  return {
    system_namespace: systemNamespace,
    edge_count: row?.n ?? 0,
    from_repos: row?.from_repos ?? 0,
    to_repos: row?.to_repos ?? 0,
  };
}
