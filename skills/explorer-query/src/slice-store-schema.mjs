/**
 * Versioned schema + forward-only migration for the persistent Context Slice store.
 *
 * The Slice store shares the system SQLite DB with L1/L2. Schema versioning is
 * component-scoped via `explorer_schema_versions(component='context-slice')` —
 * NEVER the global `PRAGMA user_version` (which is shared and would collide).
 *
 * Locked decisions (plan persistent-context-slice-engine-v2.md Scope #4):
 *  - Forward-only migration; fail-closed for version > supported.
 *  - Every multi-statement migration runs inside `BEGIN IMMEDIATE ... COMMIT`.
 *  - No `INSERT OR IGNORE` on Slice root tables; the version row uses an explicit
 *    SELECT-then-INSERT inside the same transaction.
 *
 * @see skills/explorer-l0/src/store-fs.mjs — runTransaction pattern.
 * @see skills/explorer-l1/src/system-store.mjs — openSystemStore shape.
 */

import { SliceMigrationError, SliceStoreError } from "./slice-errors.mjs";

/** Component key in the shared `explorer_schema_versions` table. */
export const SLICE_COMPONENT = "context-slice";

/**
 * Highest schema version this module knows how to produce.
 *
 * v1 → v2 (ADR 0009): every persisted row now carries `id_version=2` and the
 * derivation key/slice_hash fold in the layered identity version. v1 cache
 * entries miss safely because the derivation key changes; the schema bump
 * is forward-only and the DDL is additive (a new column on context_slices).
 */
export const SLICE_SCHEMA_SUPPORTED_VERSION = 2;

/**
 * Shared infrastructure table — may already exist if L1/L2 created it.
 * `CREATE TABLE IF NOT EXISTS` is mandatory; never recreate.
 */
export const SHARED_SCHEMA_VERSIONS_DDL = `
CREATE TABLE IF NOT EXISTS explorer_schema_versions (
  component TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);
`;

/**
 * v1 DDL: six Slice-owned tables + indices. The shared `explorer_schema_versions`
 * table is NOT included here (it is applied separately and idempotently before
 * the version read). All child tables FK `ON DELETE CASCADE` to context_slices.
 *
 * Note: `id_version` is NOT in v1 — it is added by SLICE_DDL_V2. A fresh DB
 * runs v1 then v2 in one migration so the column always exists by the time
 * the schema version row is written.
 */
export const SLICE_DDL_V1 = `
CREATE TABLE IF NOT EXISTS context_slices (
  slice_id TEXT PRIMARY KEY,
  derivation_key TEXT NOT NULL UNIQUE,
  slice_hash TEXT NOT NULL,
  canonical_payload_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  policy_name TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('cache_hit','materialized')),
  system_namespace TEXT NOT NULL,
  seed_set_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  materialization_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_context_slices_slice_hash
  ON context_slices(slice_hash);
CREATE INDEX IF NOT EXISTS idx_context_slices_ns_policy_seeds
  ON context_slices(system_namespace, policy_name, seed_set_hash);

CREATE TABLE IF NOT EXISTS context_slice_seeds (
  slice_id TEXT NOT NULL REFERENCES context_slices(slice_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  seed_json TEXT NOT NULL,
  PRIMARY KEY (slice_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_context_slice_seeds_slice
  ON context_slice_seeds(slice_id);

CREATE TABLE IF NOT EXISTS context_slice_nodes (
  slice_id TEXT NOT NULL REFERENCES context_slices(slice_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  node_json TEXT NOT NULL,
  PRIMARY KEY (slice_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_context_slice_nodes_slice
  ON context_slice_nodes(slice_id);

CREATE TABLE IF NOT EXISTS context_slice_edges (
  slice_id TEXT NOT NULL REFERENCES context_slices(slice_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  edge_json TEXT NOT NULL,
  PRIMARY KEY (slice_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_context_slice_edges_slice
  ON context_slice_edges(slice_id);

CREATE TABLE IF NOT EXISTS context_slice_misses (
  slice_id TEXT NOT NULL REFERENCES context_slices(slice_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  miss_json TEXT NOT NULL,
  PRIMARY KEY (slice_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_context_slice_misses_slice
  ON context_slice_misses(slice_id);

CREATE TABLE IF NOT EXISTS context_slice_current (
  system_namespace TEXT NOT NULL,
  policy_name TEXT NOT NULL,
  seed_set_hash TEXT NOT NULL,
  slice_id TEXT NOT NULL REFERENCES context_slices(slice_id) ON DELETE CASCADE,
  PRIMARY KEY (system_namespace, policy_name, seed_set_hash)
);
`;

/**
 * v2 DDL: bump applied to an already-v1 schema. The new `id_version` column
 * captures the layered identity version on every persisted row. Migration is
 * forward-only and additive; existing v1 rows are NOT rewritten (they keep
 * their cached derivation_key/slice_hash; the derivation key for v2 inputs is
 * different anyway, so v1 entries simply stop matching new requests).
 */
export const SLICE_DDL_V2 = `
ALTER TABLE context_slices ADD COLUMN id_version INTEGER NOT NULL DEFAULT 1;
`;

/**
 * Read the recorded schema version for the Slice component.
 * Precondition: `explorer_schema_versions` must exist (callers bootstrap it first).
 * Returns 0 when no row exists yet (fresh DB).
 *
 * @param {{ prepare: (sql: string) => { get: (...args: unknown[]) => unknown } }} db
 * @returns {number}
 */
export function getSliceSchemaVersion(db) {
  const row = /** @type {{ version?: number } | undefined} */ (
    db
      .prepare(`SELECT version FROM explorer_schema_versions WHERE component = ?`)
      .get(SLICE_COMPONENT)
  );
  return row?.version ?? 0;
}

/**
 * Forward-only migration for the Slice schema.
 *
 * Contract:
 *  - current > supported  → throw `SliceMigrationError` (fail-closed; no DDL touched).
 *  - current === supported → no-op.
 *  - current < supported  → apply each step's DDL inside `BEGIN IMMEDIATE ...
 *    COMMIT`; on any SQL error `ROLLBACK` and throw `SliceStoreError`.
 *
 * The shared `explorer_schema_versions` table is created idempotently BEFORE the
 * version read (it may already exist if L1/L2 created it). Each Slice DDL step
 * + the version-row UPDATE are committed atomically.
 *
 * @param {{ exec: (sql: string) => void, prepare: (sql: string) => { get: (...a: unknown[]) => unknown, run: (...a: unknown[]) => unknown } }} db
 * @returns {{ from: number, to: number, migrated: boolean, steps: string[] }}
 */
export function migrateSliceSchema(db) {
  db.exec(SHARED_SCHEMA_VERSIONS_DDL);
  const current = getSliceSchemaVersion(db);

  if (current > SLICE_SCHEMA_SUPPORTED_VERSION) {
    throw new SliceMigrationError(
      `unsupported ${SLICE_COMPONENT} schema version ${current} (max supported ${SLICE_SCHEMA_SUPPORTED_VERSION})`,
    );
  }

  if (current === SLICE_SCHEMA_SUPPORTED_VERSION) {
    return { from: current, to: current, migrated: false, steps: [] };
  }

  /** @type {{ from: number, ddl: string }[]} */
  const steps = [];
  if (current < 1) steps.push({ from: 0, ddl: SLICE_DDL_V1 });
  if (current < 2) steps.push({ from: 1, ddl: SLICE_DDL_V2 });

  const now = new Date().toISOString();
  const appliedStepLabels = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const step of steps) {
      db.exec(step.ddl);
      appliedStepLabels.push(`v${step.from}->v${step.from + 1}`);
    }
    const existing = db
      .prepare(`SELECT 1 FROM explorer_schema_versions WHERE component = ?`)
      .get(SLICE_COMPONENT);
    if (!existing) {
      db.prepare(
        `INSERT INTO explorer_schema_versions (component, version, applied_at) VALUES (?,?,?)`,
      ).run(SLICE_COMPONENT, SLICE_SCHEMA_SUPPORTED_VERSION, now);
    } else {
      db.prepare(
        `UPDATE explorer_schema_versions SET version = ?, applied_at = ? WHERE component = ?`,
      ).run(SLICE_SCHEMA_SUPPORTED_VERSION, now, SLICE_COMPONENT);
    }
    db.exec("COMMIT");
  } catch (err) {
    let rollbackErr;
    try {
      db.exec("ROLLBACK");
    } catch (rb) {
      rollbackErr = rb;
    }
    const primary = err instanceof Error ? err.message : String(err);
    if (rollbackErr instanceof Error) {
      throw new SliceStoreError(
        `${primary}; rollback also failed: ${rollbackErr.message}`,
        { cause: err },
      );
    }
    throw new SliceStoreError(primary, { cause: err });
  }

  return {
    from: current,
    to: SLICE_SCHEMA_SUPPORTED_VERSION,
    migrated: true,
    steps: appliedStepLabels,
  };
}
