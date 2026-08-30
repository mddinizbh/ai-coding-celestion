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
/** Highest L1 schema version this module produces. v2 = layered ids. */
export const L1_SCHEMA_SUPPORTED_VERSION = 2;

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

/** @internal Step list used by migrateComponentSchema. */
export const L1_MIGRATION_STEPS = [
  { fromVersion: 0, ddl: SCHEMA_V1_DDL },
  { fromVersion: 1, ddl: SCHEMA_V2_DDL },
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

  // `edge_id` is the table's sole PRIMARY KEY and does not encode the system
  // namespace, so an edge already owned by ANOTHER namespace is silently
  // dropped by INSERT OR IGNORE. That is a real gap (a namespace can end up
  // missing edges it legitimately has); until the key is migrated to
  // (system_namespace, edge_id) we at least refuse to hide it.
  const owner = store._db.prepare(
    "SELECT system_namespace FROM l1_system_edges WHERE edge_id = ?",
  );

  let inserted = 0;
  let skipped = 0;
  /** @type {{edge_id: string, contract_key: string, owned_by: string}[]} */
  const conflicts = [];
  const now = new Date().toISOString();
  const tx = store._db.prepare("BEGIN");
  const commit = store._db.prepare("COMMIT");
  const rollback = store._db.prepare("ROLLBACK");
  tx.run();
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
      if (r.changes === 1) {
        inserted += 1;
      } else {
        skipped += 1;
        const existing = owner.get(e.edge_id);
        if (existing && existing.system_namespace !== systemNamespace) {
          conflicts.push({
            edge_id: e.edge_id,
            contract_key: e.contract_key,
            owned_by: existing.system_namespace,
          });
        }
      }
    }
    commit.run();
  } catch (err) {
    rollback.run();
    throw new SystemStoreError("persist failed", { cause: err });
  }
  return { inserted, skipped, conflicts };
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
