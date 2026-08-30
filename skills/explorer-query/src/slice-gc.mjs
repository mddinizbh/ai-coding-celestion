/**
 * Safe Context Slice garbage collection (plan Todo 16).
 *
 * Contracts (plan lines 298-304):
 *   - dry-run default: ZERO writes.
 *   - execute: deletes ONLY context_slice_* rows via FK cascade.
 *   - NEVER touches L0/L1/L2 tables.
 *   - NEVER runs VACUUM.
 *   - enables `PRAGMA foreign_keys = ON` on its connection so the `ON DELETE
 *     CASCADE` declared in slice-store-schema.mjs actually fires.
 *   - validates filters BEFORE any write; invalid → SliceStoreError, no delete.
 *   - single `BEGIN IMMEDIATE` transaction; any SQL error rolls back.
 *   - eligible slices are ordered by slice_id for deterministic output.
 *
 * Audit `created_at` is used ONLY for retention eligibility (--older-than);
 * canonical hashes never participate in GC decisions.
 *
 * @see skills/explorer-query/src/slice-store-schema.mjs — FK cascade DDL.
 * @see skills/explorer-query/src/slice-migrate.mjs — transaction/rollback pattern.
 * @module skills/explorer-query/src/slice-gc.mjs
 */

import { SliceStoreError } from "./slice-errors.mjs";
import { tableExists } from "../../explorer-l0/src/schema-versions.mjs";

/** All context_slice_* tables, ordered child-first for count/reporting. */
const SLICE_TABLES = [
  "context_slice_current",
  "context_slice_misses",
  "context_slice_edges",
  "context_slice_nodes",
  "context_slice_seeds",
  "context_slices",
];

/** slice_hash format: 64-char lowercase hex sha256. */
const HASH_RE = /^[a-f0-9]{64}$/;

/**
 * @typedef {{
 *   olderThan: string | null,
 *   exceptHash: string[],
 *   keepCurrent: boolean,
 * }} GcFilters
 */

/**
 * @typedef {{
 *   mode: "dry-run" | "execute",
 *   eligible: string[],
 *   deleted_count: number,
 *   counts_before: Record<string, number>,
 *   counts_after: Record<string, number>,
 * }} GcReport
 */

/**
 * Validate GC filters. Throws `SliceStoreError` on any invalid input so the
 * caller never proceeds to a delete with malformed data.
 *
 * @param {GcFilters} filters
 */
function validateFilters(filters) {
  const { olderThan, exceptHash, keepCurrent } = filters;
  if (olderThan !== null && olderThan !== undefined) {
    if (typeof olderThan !== "string" || olderThan === "") {
      throw new SliceStoreError("--older-than must be an ISO 8601 timestamp");
    }
    if (Number.isNaN(new Date(olderThan).getTime())) {
      throw new SliceStoreError(
        `--older-than must be a valid ISO 8601 timestamp: ${olderThan}`,
      );
    }
  }
  if (!Array.isArray(exceptHash)) {
    throw new SliceStoreError("--except-hash must be an array");
  }
  for (const h of exceptHash) {
    if (typeof h !== "string" || !HASH_RE.test(h)) {
      throw new SliceStoreError(
        `--except-hash must be a 64-char lowercase hex sha256: ${h}`,
      );
    }
  }
  if (typeof keepCurrent !== "boolean") {
    throw new SliceStoreError("keepCurrent must be a boolean");
  }
}

/**
 * Build the WHERE clause + bound params for eligible slice selection.
 * All filters are AND-combined; empty filters match every slice.
 *
 * @param {GcFilters} filters
 * @returns {{ where: string, params: string[] }}
 */
function buildEligibleWhere(filters) {
  const { olderThan, exceptHash, keepCurrent } = filters;
  /** @type {string[]} */
  const conditions = [];
  /** @type {string[]} */
  const params = [];

  if (olderThan) {
    conditions.push("created_at < ?");
    params.push(olderThan);
  }
  if (exceptHash.length > 0) {
    const placeholders = exceptHash.map(() => "?").join(",");
    conditions.push(`slice_hash NOT IN (${placeholders})`);
    params.push(...exceptHash);
  }
  if (keepCurrent) {
    conditions.push(
      "slice_id NOT IN (SELECT slice_id FROM context_slice_current)",
    );
  }

  const where =
    conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  return { where, params };
}

/**
 * Count rows in every context_slice_* table. Tables are checked for existence
 * so the function is safe on a DB where the schema hasn't been fully applied.
 *
 * @param {{ prepare: (sql: string) => { get: (...a: unknown[]) => unknown } }} db
 * @returns {Record<string, number>}
 */
function countAllSliceTables(db) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const t of SLICE_TABLES) {
    counts[t] = tableExists(db, t)
      ? /** @type {{ c: number }} */ (
          db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()
        ).c
      : 0;
  }
  return counts;
}

/**
 * Run the Context Slice garbage collector.
 *
 * @param {{
 *   db: { exec: (sql: string) => void, prepare: (sql: string) => { all: (...a: unknown[]) => unknown[], run: (...a: unknown[]) => unknown } },
 *   filters: GcFilters,
 *   dryRun: boolean,
 * }} input
 * @returns {GcReport}
 * @throws {SliceStoreError} invalid filters, DB error, or rollback failure.
 */
export function runGc({ db, filters, dryRun }) {
  if (!db) throw new SliceStoreError("db handle required");
  if (!filters || typeof filters !== "object") {
    throw new SliceStoreError("filters required");
  }
  validateFilters(filters);

  const countsBefore = countAllSliceTables(db);
  const { where, params } = buildEligibleWhere(filters);

  if (dryRun) {
    const rows = /** @type {{ slice_id: string }[]} */ (
      db
        .prepare(`SELECT slice_id FROM context_slices${where} ORDER BY slice_id ASC`)
        .all(...params)
    );
    const eligible = rows.map((r) => r.slice_id);
    return {
      mode: "dry-run",
      eligible,
      deleted_count: 0,
      counts_before: countsBefore,
      counts_after: countsBefore,
    };
  }

  // Execute: enable FK cascade BEFORE BEGIN (SQLite forbids pragma changes
  // inside an active transaction).
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");

  /** @type {string[]} */
  let eligible;
  try {
    const rows = /** @type {{ slice_id: string }[]} */ (
      db
        .prepare(`SELECT slice_id FROM context_slices${where} ORDER BY slice_id ASC`)
        .all(...params)
    );
    eligible = rows.map((r) => r.slice_id);

    if (eligible.length > 0) {
      const placeholders = eligible.map(() => "?").join(",");
      db.prepare(
        `DELETE FROM context_slices WHERE slice_id IN (${placeholders})`,
      ).run(...eligible);
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

  const countsAfter = countAllSliceTables(db);
  return {
    mode: "execute",
    eligible,
    deleted_count: eligible.length,
    counts_before: countsBefore,
    counts_after: countsAfter,
  };
}
