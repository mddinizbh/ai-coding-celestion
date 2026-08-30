/**
 * Layered identity migration — TWO-PHASE, dry-run-first (ADR 0009, plan Todo 8b).
 *
 * Human Gate physically separates candidate creation from derived rebuild, so
 * the migration has two explicit phases that NEVER share a transaction:
 *
 * Phase A `prepare({l0Store, db, dryRun})`:
 *   - Scans accepted L0 baselines for v1 ids (fail-closed on corrupt JSON).
 *   - dryRun=true (default): lists counts only, ZERO writes.
 *   - dryRun=false: transactionally creates v2 L0 candidates through the
 *     REAL L0 store/canonicalization API (`l0Store.persistV2Candidate`).
 *     NEVER calls `acceptBaseline` — Human Gate is required separately.
 *     Returns candidate IDs + `human_gate_pending: <count>`.
 *     A failure mid-prepare ROLLS BACK the candidate transaction — no
 *     partial candidates survive.
 *
 * Phase B `rebuild({db, acceptedV2CandidateIds, rebuildL1, rebuildL2})`:
 *   - Verifies every id in `acceptedV2CandidateIds` is recorded as accepted
 *     in `accepted_baselines` (fails closed otherwise).
 *   - Runs ONE `BEGIN IMMEDIATE` transaction that:
 *       1. Deletes every L1/L2/Slice derived row.
 *       2. Calls `rebuildL1(db)` then `rebuildL2(db)` (each receives the
 *          transaction-bound db handle so their writes participate).
 *       3. COMMITS only if both rebuilds return without error.
 *   - On ANY error inside the transaction: ROLLBACK — every deleted L1/L2/
 *     Slice row is restored because the rebuild writes also never committed.
 *
 * No alias table, no dual-read, no dual-write, no silent fallback. v2 readers
 * reject mixed v1/v2 ids with `MixedVersionError`.
 *
 * @module skills/explorer-query/src/slice-migrate.mjs
 */

import {
  detectIdVersion,
  ID_VERSION,
  MixedVersionError,
} from "../../explorer-l0/src/layered-id.mjs";
import {
  MigrationCorruptionError,
  tableExists,
} from "../../explorer-l0/src/schema-versions.mjs";

/** Re-export for callers that need to catch by type. */
export { MixedVersionError, MigrationCorruptionError };

/**
 * @typedef {{
 *   mode: "dry-run" | "prepare" | "rebuild",
 *   id_version_target: number,
 *   l0: { accepted_baselines: number, v1_detected: number, v2_candidates_created?: number, human_gate_pending?: number },
 *   l1?: { edges_before: number, edges_after?: number, rebuilt?: boolean },
 *   l2?: { binds_before: number, binds_after?: number, rebuilt?: boolean },
 *   slice?: { rows_before: number, rows_after?: number, reset?: boolean },
 *   rolled_back?: boolean,
 *   error?: string,
 * }} MigrationReport
 */

/** Ids that look like the legacy layered shapes — never pure data values. */
const LEGACY_RECORD_PREFIXES = /^(service|endpoint|controller|method|component|domain|topic|producer|consumer|config):/;
const LEGACY_FF = /^ff:[a-z_]+:/;
const LEGACY_L1 = /^l1:[a-f0-9]{32}$/;

const LAYER_TABLE_NAMES = {
  candidatePackages: ["l0_candidate_packages", "candidate_packages"],
  acceptedBaselines: ["l0_accepted_baselines", "accepted_baselines"],
  systemEdges: ["l1_system_edges", "system_edges"],
  systemStitchRuns: ["l1_system_stitch_runs", "system_stitch_runs"],
  journeySpecs: ["l2_journey_specs", "journey_specs"],
  journeyBinds: ["l2_journey_binds", "journey_binds"],
  journeyStepEdges: ["l2_journey_step_edges", "journey_step_edges"],
  journeyCurrent: ["l2_journey_current", "journey_current"],
};

/**
 * Dry-run scan: read-only inventory of v1 baselines and current L1/L2/Slice
 * row counts. Performs ZERO writes. Fails closed on corrupt package_json.
 *
 * @param {{ db: SqliteDb }} input
 * @returns {MigrationReport}
 */
export function dryRun({ db }) {
  if (!db) throw new Error("dryRun requires a db handle");
  const tables = resolveLayerTables(db);
  const l0 = scanL0Accepted(db, tables);
  return {
    mode: "dry-run",
    id_version_target: ID_VERSION,
    l0: {
      accepted_baselines: l0.total,
      v1_detected: l0.v1Count,
    },
    l1: { edges_before: countRows(db, tables.systemEdges) },
    l2: { binds_before: countRows(db, tables.journeyBinds) },
    slice: { rows_before: countRows(db, "context_slices") },
  };
}

/**
 * Phase A — prepare v2 L0 candidates from accepted v1 baselines.
 *
 * Contract:
 *   - dryRun=true (default): scan only, return counts, ZERO writes.
 *   - dryRun=false: call `l0Store.persistV2Candidate(payload, txDb)` for each
 *     v1 accepted baseline inside ONE `BEGIN IMMEDIATE` transaction on `db`.
 *     A failure mid-loop ROLLS BACK; no partial candidates survive.
 *   - NEVER accepts the candidates — Human Gate is the caller's responsibility.
 *   - Fails closed with `MigrationCorruptionError` on malformed package_json.
 *
 * @param {{
 *   db: SqliteDb,
 *   l0Store?: { persistV2Candidate: (payload: object, txDb: SqliteDb) => { candidate_id: string } },
 *   dryRun?: boolean,
 * }} input
 * @returns {MigrationReport}
 */
export function prepare({ db, l0Store, dryRun = true }) {
  if (!db) throw new Error("prepare requires a db handle");
  const tables = resolveLayerTables(db);
  const scan = scanL0Accepted(db, tables);
  const report = {
    mode: dryRun ? "dry-run" : "prepare",
    id_version_target: ID_VERSION,
    l0: {
      accepted_baselines: scan.total,
      v1_detected: scan.v1Count,
      v2_candidates_created: 0,
      human_gate_pending: 0,
    },
  };

  if (dryRun || scan.v1Count === 0) return report;

  if (!l0Store || typeof l0Store.persistV2Candidate !== "function") {
    return failReport(report, "prepare requires l0Store.persistV2Candidate for execute mode");
  }

  const payloads = listAcceptedPackages(db, tables);
  /** @type {{candidate_id: string}[]} */
  const created = [];

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const p of payloads) {
      if (!hasV1Id(p)) continue;
      const r = l0Store.persistV2Candidate(p, db);
      created.push(r);
    }
    db.exec("COMMIT");
  } catch (err) {
    return failRollback(db, report, `prepare failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  report.l0.v2_candidates_created = created.length;
  report.l0.human_gate_pending = created.length;
  return report;
}

/**
 * Phase B — rebuild L1/L2/Slice from accepted v2 candidates.
 *
 * Contract:
 *   - `acceptedV2CandidateIds` MUST be a list of candidate_ids that are
 *     recorded in `accepted_baselines`. The function verifies each BEFORE
 *     opening the transaction (fail closed without destroying derived data).
 *   - Inside ONE `BEGIN IMMEDIATE` transaction on `db`:
 *       1. Reset every L1/L2/Slice derived row.
 *       2. Call `rebuildL1(db)` (must use the transaction-bound handle).
 *       3. Call `rebuildL2(db)` (must use the transaction-bound handle).
 *       4. COMMIT only if both return without error.
 *   - On ANY error: ROLLBACK. All derived rows restored because the deletes
 *     AND the rebuild writes both live in the same transaction that never
 *     committed.
 *
 * The rebuild callbacks MUST write through the provided `db` handle so their
 * writes participate in the same transaction.
 *
 * @param {{
 *   db: SqliteDb,
 *   acceptedV2CandidateIds: string[],
 *   rebuildL1?: (db: SqliteDb) => { edges_after: number } | void,
 *   rebuildL2?: (db: SqliteDb) => { binds_after: number } | void,
 * }} input
 * @returns {MigrationReport}
 */
export function rebuild({ db, acceptedV2CandidateIds, rebuildL1, rebuildL2 }) {
  if (!db) throw new Error("rebuild requires a db handle");
  if (!Array.isArray(acceptedV2CandidateIds)) {
    throw new Error("rebuild requires acceptedV2CandidateIds array");
  }

  const tables = resolveLayerTables(db);
  const report = {
    mode: "rebuild",
    id_version_target: ID_VERSION,
    l1: {
      edges_before: countRows(db, tables.systemEdges),
      edges_after: 0,
      rebuilt: false,
    },
    l2: {
      binds_before: countRows(db, tables.journeyBinds),
      binds_after: 0,
      rebuilt: false,
    },
    slice: {
      rows_before: countRows(db, "context_slices"),
      rows_after: 0,
      reset: false,
    },
  };

  // Verify every claimed-accepted candidate is actually recorded as accepted.
  // If the caller lied about Human Gate, fail closed WITHOUT touching derived
  // data — never destroy L1/L2/Slice on an unverified promise.
  if (acceptedV2CandidateIds.length > 0) {
    if (!tables.acceptedBaselines) {
      return failReport(report, "rebuild: L0 accepted-baselines table missing — cannot verify Human Gate");
    }
    for (const cid of acceptedV2CandidateIds) {
      const row = db
        .prepare(`SELECT candidate_id FROM ${tables.acceptedBaselines} WHERE candidate_id = ?`)
        .get(cid);
      if (!row) {
        return failReport(
          report,
          `rebuild: candidate ${cid} is NOT recorded as accepted; Human Gate incomplete — refusing to destroy derived data`,
        );
      }
    }
  }

  try {
    db.exec("BEGIN IMMEDIATE");
    resetDerivedTables(db, tables);
    report.slice.reset = true;
    report.slice.rows_after = 0;
    report.l1.edges_after = 0;
    report.l2.binds_after = 0;

    if (typeof rebuildL1 === "function") {
      const r1 = rebuildL1(db);
      report.l1.edges_after = r1?.edges_after ?? countRows(db, tables.systemEdges);
      report.l1.rebuilt = true;
    }
    if (typeof rebuildL2 === "function") {
      const r2 = rebuildL2(db);
      report.l2.binds_after = r2?.binds_after ?? countRows(db, tables.journeyBinds);
      report.l2.rebuilt = true;
    }
    db.exec("COMMIT");
  } catch (err) {
    return failRollback(
      db,
      report,
      `rebuild failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return report;
}

// --- Internals --------------------------------------------------------------

/**
 * @typedef {{ exec: (sql: string) => void, prepare: (sql: string) => { get: (...a: unknown[]) => unknown, all: (...a: unknown[]) => unknown[], run: (...a: unknown[]) => unknown } }} SqliteDb
 */

/**
 * Resolve layered table names while retaining read-only visibility into a
 * pre-migration DB. Coexisting legacy and layered names are ambiguous and
 * therefore treated as corruption instead of silently preferring one.
 *
 * @param {SqliteDb} db
 */
function resolveLayerTables(db) {
  return Object.fromEntries(
    Object.entries(LAYER_TABLE_NAMES).map(([key, [layered, legacy]]) => [
      key,
      resolveLayerTable(db, layered, legacy),
    ]),
  );
}

/**
 * @param {SqliteDb} db
 * @param {string} layered
 * @param {string} legacy
 * @returns {string|null}
 */
function resolveLayerTable(db, layered, legacy) {
  const hasLayered = tableExists(db, layered);
  const hasLegacy = tableExists(db, legacy);
  if (hasLayered && hasLegacy) {
    throw new MigrationCorruptionError(
      `legacy/layered schema name collision: ${legacy}+${layered}`,
      { table: layered },
    );
  }
  if (hasLayered) return layered;
  if (hasLegacy) return legacy;
  return null;
}

/**
 * Scan accepted L0 baselines. Distinguishes absent-table (return zeros) from
 * present-table-with-corrupt-rows (throw `MigrationCorruptionError`).
 *
 * @param {SqliteDb} db
 * @returns {{ total: number, v1Count: number }}
 */
function scanL0Accepted(db, tables) {
  if (!tables.candidatePackages || !tables.acceptedBaselines) {
    return { total: 0, v1Count: 0 };
  }
  const rows = safeQueryAll(
    db,
    `SELECT package_json FROM ${tables.candidatePackages} JOIN ${tables.acceptedBaselines} USING (candidate_id, namespace, logical_repo)`,
    tables.candidatePackages,
  );
  let v1 = 0;
  for (const row of rows) {
    const pkg = safeParseJson(/** @type {string} */ (row.package_json), tables.candidatePackages);
    if (hasV1Id(pkg)) v1 += 1;
  }
  return { total: rows.length, v1Count: v1 };
}

/**
 * @param {SqliteDb} db
 * @returns {object[]}
 */
function listAcceptedPackages(db, tables) {
  if (!tables.candidatePackages || !tables.acceptedBaselines) {
    return [];
  }
  const rows = safeQueryAll(
    db,
    `SELECT package_json FROM ${tables.candidatePackages} JOIN ${tables.acceptedBaselines} USING (candidate_id, namespace, logical_repo)`,
    tables.candidatePackages,
  );
  return rows.map((row) =>
    safeParseJson(/** @type {string} */ (row.package_json), tables.candidatePackages),
  );
}

/**
 * Fail-closed JSON parse. Malformed package_json is a migration corruption
 * error, never silently skipped.
 *
 * @param {string} text
 * @param {string} table
 * @returns {object}
 */
function safeParseJson(text, table) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new MigrationCorruptionError(
      `corrupt JSON in ${table}: ${err instanceof Error ? err.message : String(err)}`,
      { table, cause: err },
    );
  }
}

/**
 * Fail-closed query. A SQL error against a present table is corruption.
 *
 * @param {SqliteDb} db
 * @param {string} sql
 * @param {string} table
 * @returns {object[]}
 */
function safeQueryAll(db, sql, table) {
  try {
    return db.prepare(sql).all();
  } catch (err) {
    throw new MigrationCorruptionError(
      `failed to read ${table}: ${err instanceof Error ? err.message : String(err)}`,
      { table, cause: err },
    );
  }
}

/**
 * Recursively scan for any v1 layered id shape in a payload.
 * @param {unknown} value
 * @returns {boolean}
 */
function hasV1Id(value) {
  if (typeof value === "string") {
    return detectIdVersion(value) === 1 && looksLikeLegacyId(value);
  }
  if (Array.isArray(value)) return value.some(hasV1Id);
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) {
      if (hasV1Id(v)) return true;
    }
  }
  return false;
}

function looksLikeLegacyId(s) {
  return LEGACY_RECORD_PREFIXES.test(s) || LEGACY_FF.test(s) || LEGACY_L1.test(s);
}

/**
 * @param {SqliteDb} db
 * @param {string} table
 * @returns {number}
 */
function countRows(db, table) {
  if (!table || !tableExists(db, table)) return 0;
  try {
    const row = /** @type {{ n?: number } | undefined} */ (
      db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
    );
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Reset L1, L2, and Slice derived tables. The order respects FK cascades.
 * Runs inside the caller's transaction.
 *
 * @param {SqliteDb} db
 */
function resetDerivedTables(db, tables) {
  for (const t of [
    "context_slice_current",
    "context_slice_misses",
    "context_slice_edges",
    "context_slice_nodes",
    "context_slice_seeds",
    "context_slices",
  ]) {
    if (tableExists(db, t)) db.exec(`DELETE FROM ${t}`);
  }
  for (const table of [
    tables.journeyStepEdges,
    tables.journeyCurrent,
    tables.journeyBinds,
    tables.journeySpecs,
  ]) {
    if (table) db.exec(`DELETE FROM ${table}`);
  }
  if (tables.systemEdges) db.exec(`DELETE FROM ${tables.systemEdges}`);
  if (tables.systemStitchRuns) db.exec(`DELETE FROM ${tables.systemStitchRuns}`);
}

/**
 * @param {SqliteDb} db
 * @param {MigrationReport} report
 * @param {string} message
 * @returns {MigrationReport}
 */
function failRollback(db, report, message) {
  try {
    db.exec("ROLLBACK");
  } catch {
    // not in a transaction — best effort
  }
  return { ...report, rolled_back: true, error: message };
}

/**
 * @param {MigrationReport} report
 * @param {string} message
 * @returns {MigrationReport}
 */
function failReport(report, message) {
  return { ...report, rolled_back: true, error: message };
}
