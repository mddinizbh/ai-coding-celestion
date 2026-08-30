/**
 * Filesystem helpers for the Descobrir SQLite store.
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { AcceptanceError, StoreError } from "./errors.mjs";
import { stableStringify } from "./stable-json.mjs";

/**
 * @param {string} dbPath
 */
export function ensureParentDir(dbPath) {
  if (dbPath === ":memory:") return;
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Set restrictive mode on the db file. Fail closed on error.
 * @param {string} dbPath
 */
export function lockDownFile(dbPath) {
  if (dbPath === ":memory:" || !existsSync(dbPath)) return;
  try {
    chmodSync(dbPath, 0o600);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new StoreError(`failed to set database mode 0600: ${msg}`);
  }
}

/**
 * @param {unknown} err
 * @returns {AcceptanceError}
 */
export function toAcceptanceError(err) {
  if (err instanceof AcceptanceError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new AcceptanceError(`stored package integrity failed: ${msg}`);
}

/**
 * Same-key lookup: idempotent if JSON matches; StoreError on divergent collision.
 * @param {{ prepare: (sql: string) => { get: (...args: unknown[]) => unknown } }} db
 * @param {object} pkg
 * @param {string} incomingJson
 * @returns {{ candidate_id: string, created: false } | null}
 */
export function existingCandidateOrCollision(db, pkg, incomingJson) {
  const existing = db
    .prepare(
      `SELECT candidate_id, package_json FROM l0_candidate_packages
       WHERE namespace = ? AND logical_repo = ? AND source_revision = ? AND canonical_graph_hash = ?`,
    )
    .get(pkg.namespace, pkg.logical_repo, pkg.source_revision, pkg.graph_index.canonical_graph_hash);
  if (!existing) return null;
  const row = /** @type {{ candidate_id: string, package_json: string }} */ (existing);
  const storedCanonical = stableStringify(JSON.parse(row.package_json));
  if (storedCanonical !== incomingJson) {
    throw new StoreError(
      "divergent package for same key (namespace/logical_repo/source_revision/canonical_graph_hash): collision rejected",
    );
  }
  return { candidate_id: row.candidate_id, created: false };
}

/**
 * Run a write transaction; surface rollback failures explicitly.
 * @param {{ exec: (sql: string) => void }} db
 * @param {() => void} body
 * @param {new (message: string) => Error} ErrorType
 */
export function runTransaction(db, body, ErrorType) {
  db.exec("BEGIN IMMEDIATE");
  try {
    body();
    db.exec("COMMIT");
  } catch (err) {
    let rollbackError;
    try {
      db.exec("ROLLBACK");
    } catch (rb) {
      rollbackError = rb;
    }
    const primary = err instanceof Error ? err.message : String(err);
    if (rollbackError instanceof Error) {
      throw new ErrorType(`${primary}; rollback also failed: ${rollbackError.message}`);
    }
    if (err instanceof ErrorType) throw err;
    throw new ErrorType(primary);
  }
}
