/**
 * Zero-dependency SQLite document store for Descobrir candidate packages
 * and accepted baselines. JSON is export-only — SQLite is the source of truth.
 */

import { DatabaseSync } from "node:sqlite";

import { AcceptanceError, StoreError } from "./errors.mjs";
import { assertCanonicalPackageIntegrity } from "./package-integrity.mjs";
import {
  ensureParentDir,
  existingCandidateOrCollision,
  lockDownFile,
  runTransaction,
  toAcceptanceError,
} from "./store-fs.mjs";
import { SCHEMA_SQL, candidateIdFor } from "./store-schema.mjs";
import { migrateLayerTableNames } from "./schema-versions.mjs";
import { stablePretty, stableStringify } from "./stable-json.mjs";

export { AcceptanceError, StoreError };

/**
 * @param {ReturnType<typeof openStore>} store
 * @param {string} candidateId
 */
function loadPackage(store, candidateId) {
  const row = store._db
    .prepare(`SELECT package_json FROM l0_candidate_packages WHERE candidate_id = ?`)
    .get(candidateId);
  if (!row) {
    throw new StoreError(`candidate not found: ${candidateId}`);
  }
  return JSON.parse(/** @type {string} */ (row.package_json));
}

/**
 * Open (or create) a Descobrir store.
 * @param {string} dbPath
 */
export function openStore(dbPath) {
  if (typeof dbPath !== "string" || dbPath === "") {
    throw new StoreError("dbPath must be a non-empty string");
  }
  ensureParentDir(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    migrateLayerTableNames(db, StoreError);
    db.exec(SCHEMA_SQL);
  } catch (err) {
    db.close();
    throw err;
  }
  lockDownFile(dbPath);

  return {
    /** @internal */
    _db: db,
    dbPath,

    /**
     * @param {{ namespace: string, logical_repo: string }} q
     * @returns {object[]}
     */
    listCandidates(q) {
      return db
        .prepare(
          `SELECT candidate_id, namespace, logical_repo, source_revision,
                  canonical_graph_hash, created_at
           FROM l0_candidate_packages
           WHERE namespace = ? AND logical_repo = ?
           ORDER BY created_at ASC, candidate_id ASC`,
        )
        .all(q.namespace, q.logical_repo)
        .map((row) => ({ ...row }));
    },

    /**
     * @param {{ namespace: string, logical_repo: string }} q
     * @returns {object|null}
     */
    getAcceptedBaseline(q) {
      const row = db
        .prepare(
          `SELECT namespace, logical_repo, candidate_id, approver, accepted_at
           FROM l0_accepted_baselines
           WHERE namespace = ? AND logical_repo = ?`,
        )
        .get(q.namespace, q.logical_repo);
      return row ? { ...row } : null;
    },

    close() {
      db.close();
      lockDownFile(dbPath);
    },
  };
}

/**
 * Persist a canonical candidate package. Idempotent on ns/repo/rev/hash.
 * @param {ReturnType<typeof openStore>} store
 * @param {object|null} pkg
 * @returns {{ candidate_id: string, created: boolean }}
 */
export function persistCandidate(store, pkg) {
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
    throw new StoreError("package must be an object");
  }
  assertCanonicalPackageIntegrity(pkg);

  const candidateId = candidateIdFor(pkg);
  const db = store._db;
  const incomingJson = stableStringify(pkg);
  const hit = existingCandidateOrCollision(db, pkg, incomingJson);
  if (hit) return hit;

  runTransaction(
    db,
    () => {
      db.prepare(
        `INSERT INTO l0_candidate_packages (
           candidate_id, namespace, logical_repo, source_revision,
           canonical_graph_hash, package_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        candidateId,
        pkg.namespace,
        pkg.logical_repo,
        pkg.source_revision,
        pkg.graph_index.canonical_graph_hash,
        incomingJson,
        new Date().toISOString(),
      );
    },
    StoreError,
  );

  lockDownFile(store.dbPath);
  return { candidate_id: candidateId, created: true };
}

/**
 * Human Gate: accept a candidate as the baseline for namespace+logical_repo.
 * @param {ReturnType<typeof openStore>} store
 * @param {{ candidate_id: string, approver?: string }} input
 */
export function acceptBaseline(store, input) {
  if (!input || typeof input !== "object") {
    throw new AcceptanceError("accept input is required");
  }
  const approver = typeof input.approver === "string" ? input.approver.trim() : "";
  if (approver === "") {
    throw new AcceptanceError("approver identity is required (Human Gate)");
  }
  if (typeof input.candidate_id !== "string" || input.candidate_id === "") {
    throw new AcceptanceError("candidate_id is required");
  }

  const pkg = loadPackage(store, input.candidate_id);
  try {
    assertCanonicalPackageIntegrity(pkg);
  } catch (err) {
    throw toAcceptanceError(err);
  }
  if (pkg.coverage_report?.passed !== true) {
    throw new AcceptanceError("acceptance rejected: coverage_report.passed must be true");
  }

  const acceptedAt = new Date().toISOString();
  const db = store._db;
  runTransaction(
    db,
    () => {
      db.prepare(
        `INSERT INTO l0_accepted_baselines (namespace, logical_repo, candidate_id, approver, accepted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(namespace, logical_repo) DO UPDATE SET
           candidate_id = excluded.candidate_id,
           approver = excluded.approver,
           accepted_at = excluded.accepted_at`,
      ).run(pkg.namespace, pkg.logical_repo, input.candidate_id, approver, acceptedAt);
    },
    AcceptanceError,
  );

  return {
    namespace: pkg.namespace,
    logical_repo: pkg.logical_repo,
    candidate_id: input.candidate_id,
    approver,
    accepted_at: acceptedAt,
  };
}

/**
 * Export a stored package as a plain object (JSON is compatibility/audit only).
 * @param {ReturnType<typeof openStore>} store
 * @param {{ candidate_id?: string, namespace?: string, logical_repo?: string, accepted?: boolean }} q
 */
export function exportPackage(store, q) {
  if (q.candidate_id) {
    return loadPackage(store, q.candidate_id);
  }
  if (q.accepted) {
    if (!q.namespace || !q.logical_repo) {
      throw new StoreError("namespace and logical_repo required for accepted export");
    }
    const baseline = store.getAcceptedBaseline({
      namespace: q.namespace,
      logical_repo: q.logical_repo,
    });
    if (!baseline) {
      throw new StoreError("no accepted baseline for namespace+logical_repo");
    }
    return loadPackage(store, /** @type {string} */ (baseline.candidate_id));
  }
  throw new StoreError("export requires candidate_id or accepted=true with namespace+logical_repo");
}

/**
 * @param {ReturnType<typeof openStore>} store
 * @param {{ namespace: string, logical_repo: string, graph_hash: string }} q
 */
export function findCandidateByHash(store, q) {
  const row = store._db
    .prepare(
      `SELECT candidate_id FROM l0_candidate_packages
       WHERE namespace = ? AND logical_repo = ? AND canonical_graph_hash = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(q.namespace, q.logical_repo, q.graph_hash);
  return row ? /** @type {string} */ (row.candidate_id) : null;
}

/**
 * @param {object} pkg
 */
export function packageToExportJson(pkg) {
  return stablePretty(pkg);
}
