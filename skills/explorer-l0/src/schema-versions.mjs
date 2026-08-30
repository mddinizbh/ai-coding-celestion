/**
 * Shared component-scoped schema versioning for the explorer pipeline.
 *
 * Used by L1 (`system-store.mjs`), L2 (`journey-store.mjs`), and Slice
 * (`slice-store-schema.mjs`) — never the global `PRAGMA user_version`
 * (which would collide across components in the shared DB).
 *
 * Locked rules (plan Todo 8b):
 *  - Forward-only migration. A DB that records a future version throws a
 *    typed `UnsupportedSchemaVersionError` BEFORE any write.
 *  - `CREATE TABLE IF NOT EXISTS explorer_schema_versions (...)` is applied
 *    idempotently before reading the version row.
 *  - Migration runs inside `BEGIN IMMEDIATE ... COMMIT`; any SQL error
 *    rolls back and the version row is NOT updated.
 *
 * @module skills/explorer-l0/src/schema-versions.mjs
 */

/**
 * Raised when a DB records a future schema version this code can't produce.
 * Subclasses Error so stores can `instanceof UnsupportedSchemaVersionError`.
 */
export class UnsupportedSchemaVersionError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown, component?: string, current?: number, supported?: number }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "UnsupportedSchemaVersionError";
    if (options.component !== undefined) this.component = options.component;
    if (options.current !== undefined) this.current = options.current;
    if (options.supported !== undefined) this.supported = options.supported;
  }
}

/**
 * Raised when an existing table row is corrupt (e.g. malformed package_json)
 * and the operation must fail closed rather than silently skip.
 */
export class MigrationCorruptionError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown, component?: string, table?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "MigrationCorruptionError";
    if (options.component !== undefined) this.component = options.component;
    if (options.table !== undefined) this.table = options.table;
  }
}

/**
 * Shared DDL for the version-tracking table. `CREATE TABLE IF NOT EXISTS` is
 * mandatory — multiple components share the table.
 */
export const SHARED_SCHEMA_VERSIONS_DDL = `
CREATE TABLE IF NOT EXISTS explorer_schema_versions (
  component TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);
`;

const LAYER_TABLE_RENAMES = [
  ["candidate_packages", "l0_candidate_packages"],
  ["accepted_baselines", "l0_accepted_baselines"],
  ["system_edges", "l1_system_edges"],
  ["system_stitch_runs", "l1_system_stitch_runs"],
  ["journey_specs", "l2_journey_specs"],
  ["journey_binds", "l2_journey_binds"],
  ["journey_step_edges", "l2_journey_step_edges"],
  ["journey_current", "l2_journey_current"],
];

const LAYER_INDEX_RENAMES = [
  ["idx_candidates_ns_repo", "idx_l0_candidates_ns_repo", "l0_candidate_packages", "namespace, logical_repo"],
  ["idx_system_edges_ns", "idx_l1_system_edges_ns", "l1_system_edges", "system_namespace"],
  ["idx_system_edges_from", "idx_l1_system_edges_from", "l1_system_edges", "system_namespace, from_logical_repo"],
  ["idx_system_edges_to", "idx_l1_system_edges_to", "l1_system_edges", "system_namespace, to_logical_repo"],
  ["idx_system_edges_contract", "idx_l1_system_edges_contract", "l1_system_edges", "system_namespace, contract_key"],
  ["idx_journey_binds_ns_id", "idx_l2_journey_binds_ns_id", "l2_journey_binds", "system_namespace, journey_id, created_at DESC"],
  ["idx_journey_step_edges_edge", "idx_l2_journey_step_edges_edge", "l2_journey_step_edges", "edge_id"],
];

/**
 * Atomically migrate pre-layer-prefix Explorer table and index names. Every
 * Explorer store calls this before its component schema migration so a shared
 * legacy DB is upgraded as one unit, regardless of which layer opens it first.
 *
 * @param {{ exec: (sql: string) => void, prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } }} db
 * @param {new (message: string, options?: { cause?: unknown }) => Error} [errorCtor]
 * @returns {{ migrated: boolean, tables: string[], indexes: string[] }}
 */
export function migrateLayerTableNames(db, errorCtor = Error) {
  const rows = /** @type {{ type: string, name: string }[]} */ (
    db
      .prepare(
        `SELECT type, name FROM sqlite_master
         WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'`,
      )
      .all()
  );
  const tableNames = new Set(rows.filter((row) => row.type === "table").map((row) => row.name));
  const indexNames = new Set(rows.filter((row) => row.type === "index").map((row) => row.name));
  const tableCollisions = LAYER_TABLE_RENAMES.filter(
    ([legacy, layered]) => tableNames.has(legacy) && tableNames.has(layered),
  );
  const indexCollisions = LAYER_INDEX_RENAMES.filter(
    ([legacy, layered]) => indexNames.has(legacy) && indexNames.has(layered),
  );
  if (tableCollisions.length > 0 || indexCollisions.length > 0) {
    const names = [
      ...tableCollisions.map(([legacy, layered]) => `${legacy}+${layered}`),
      ...indexCollisions.map(([legacy, layered]) => `${legacy}+${layered}`),
    ];
    throw new errorCtor(`legacy/layered schema name collision: ${names.join(", ")}`);
  }

  const pendingTables = LAYER_TABLE_RENAMES.filter(([legacy]) => tableNames.has(legacy));
  if (pendingTables.length === 0) {
    return { migrated: false, tables: [], indexes: [] };
  }

  const renamedTables = [];
  const recreatedIndexes = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [legacy, layered] of pendingTables) {
      db.exec(`ALTER TABLE ${legacy} RENAME TO ${layered}`);
      renamedTables.push(layered);
    }

    const renamedTableSet = new Set(renamedTables);
    for (const [legacy, layered, table, columns] of LAYER_INDEX_RENAMES) {
      if (!renamedTableSet.has(table)) continue;
      db.exec(`DROP INDEX IF EXISTS ${legacy}`);
      db.exec(`CREATE INDEX IF NOT EXISTS ${layered} ON ${table} (${columns})`);
      recreatedIndexes.push(layered);
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
    const message =
      rollbackErr instanceof Error
        ? `${primary}; rollback also failed: ${rollbackErr.message}`
        : primary;
    throw new errorCtor(message, { cause: err });
  }

  return { migrated: true, tables: renamedTables, indexes: recreatedIndexes };
}

/**
 * Read the recorded schema version for a component. Returns 0 when no row
 * exists (fresh DB). Callers MUST apply SHARED_SCHEMA_VERSIONS_DDL first.
 *
 * @param {{ prepare: (sql: string) => { get: (...a: unknown[]) => unknown } }} db
 * @param {string} component
 * @returns {number}
 */
export function getComponentSchemaVersion(db, component) {
  const row = /** @type {{ version?: number } | undefined} */ (
    db
      .prepare(`SELECT version FROM explorer_schema_versions WHERE component = ?`)
      .get(component)
  );
  return row?.version ?? 0;
}

/**
 * Reject a recorded future component version without creating tables or
 * changing layer names. Stores call this before the shared table-name
 * migration to preserve the forward-only "no write on future version" rule.
 *
 * @param {{ prepare: (sql: string) => { get: (...a: unknown[]) => unknown } }} db
 * @param {string} component
 * @param {number} supportedVersion
 * @param {new (message: string, options?: { component?: string, current?: number, supported?: number }) => Error} [errorCtor]
 * @returns {number}
 */
export function assertComponentSchemaVersionSupported(
  db,
  component,
  supportedVersion,
  errorCtor = UnsupportedSchemaVersionError,
) {
  if (!tableExists(db, "explorer_schema_versions")) return 0;
  const current = getComponentSchemaVersion(db, component);
  if (current > supportedVersion) {
    throw new errorCtor(
      `unsupported ${component} schema version ${current} (max supported ${supportedVersion})`,
      { component, current, supported: supportedVersion },
    );
  }
  return current;
}

/**
 * Forward-only, fail-closed migration for one component. The caller provides
 * an ordered list of `{fromVersion, ddl}` steps. The runner:
 *   1. Applies SHARED_SCHEMA_VERSIONS_DDL idempotently.
 *   2. Reads the current version; if `current > supported`, throws
 *      `UnsupportedSchemaVersionError` BEFORE any DDL.
 *   3. Inside `BEGIN IMMEDIATE`, applies each pending step's DDL, then
 *      upserts the version row to the supported version.
 *   4. On any SQL error, `ROLLBACK` and re-throw as the caller's typed error.
 *
 * @param {{
 *   db: { exec: (sql: string) => void, prepare: (sql: string) => { get: (...a: unknown[]) => unknown, run: (...a: unknown[]) => unknown } },
 *   component: string,
 *   supportedVersion: number,
 *   steps: { fromVersion: number, ddl: string }[],
 *   errorCtor?: new (message: string, options?: { cause?: unknown }) => Error,
 * }} input
 * @returns {{ from: number, to: number, migrated: boolean, steps: string[] }}
 */
export function migrateComponentSchema(input) {
  const { db, component, supportedVersion, steps, errorCtor = Error } = input;
  db.exec(SHARED_SCHEMA_VERSIONS_DDL);
  const current = assertComponentSchemaVersionSupported(db, component, supportedVersion);

  if (current === supportedVersion) {
    return { from: current, to: current, migrated: false, steps: [] };
  }

  const pending = steps.filter((s) => s.fromVersion >= current);
  if (pending.length === 0) {
    return { from: current, to: current, migrated: false, steps: [] };
  }

  const now = new Date().toISOString();
  const appliedLabels = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const step of pending) {
      db.exec(step.ddl);
      appliedLabels.push(`v${step.fromVersion}->v${step.fromVersion + 1}`);
    }
    const existing = db
      .prepare(`SELECT 1 FROM explorer_schema_versions WHERE component = ?`)
      .get(component);
    if (!existing) {
      db.prepare(
        `INSERT INTO explorer_schema_versions (component, version, applied_at) VALUES (?,?,?)`,
      ).run(component, supportedVersion, now);
    } else {
      db.prepare(
        `UPDATE explorer_schema_versions SET version = ?, applied_at = ? WHERE component = ?`,
      ).run(supportedVersion, now, component);
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
      throw new errorCtor(`${primary}; rollback also failed: ${rollbackErr.message}`, { cause: err });
    }
    throw new errorCtor(primary, { cause: err });
  }

  return {
    from: current,
    to: supportedVersion,
    migrated: true,
    steps: appliedLabels,
  };
}

/**
 * Detect whether a table exists. Used by dry-run scans to distinguish an
 * absent optional table (return zeros) from a present table that needs
 * fail-closed scanning.
 *
 * @param {{ prepare: (sql: string) => { get: (...a: unknown[]) => unknown } }} db
 * @param {string} table
 * @returns {boolean}
 */
export function tableExists(db, table) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error(`tableExists: invalid table name ${table}`);
  }
  const row = /** @type {{ n?: number } | undefined} */ (
    db
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table)
  );
  return (row?.n ?? 0) > 0;
}
