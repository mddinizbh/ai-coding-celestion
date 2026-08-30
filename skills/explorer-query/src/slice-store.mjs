/**
 * Persistent Context Slice store — open/close, schema bootstrap, idempotent
 * persist + current-pointer (Todo 6).
 *
 * Mirrors `openSystemStore` (L1) and `openJourneyStore` (L2): create parent dir
 * with mode 0700, open the SQLite handle, apply the schema/migration, then chmod
 * the DB file to 0600. `:memory:` skips all filesystem touching.
 *
 * Todo 6 extends the returned object with `persist`/`read`/`readByHash`/`list`/
 * `setCurrent`/`getCurrent`. Persist runs a single `BEGIN IMMEDIATE` transaction;
 * canonical JSON is compared BEFORE a hit is declared; divergent same-key throws
 * `SliceCollisionError`; the `context_slice_current` pointer switches ONLY after
 * the Slice commit.
 *
 * @see skills/explorer-l1/src/system-store.mjs:48-67 — openSystemStore reference.
 * @see skills/explorer-l0/src/store-fs.mjs:14-34 — lockDownFile / 0600 contract.
 * @see skills/explorer-l0/src/store-fs.mjs:47-95 — runTransaction + collision pattern.
 */

import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { stableStringify } from "../../explorer-l0/src/stable-json.mjs";
import { ID_VERSION, makeSliceId } from "../../explorer-l0/src/layered-id.mjs";
import {
  assertComponentSchemaVersionSupported,
  migrateLayerTableNames,
} from "../../explorer-l0/src/schema-versions.mjs";
import {
  SliceCollisionError,
  SliceMigrationError,
  SliceStoreError,
} from "./slice-errors.mjs";
import { canonicalSlicePayload } from "./slice-canonical.mjs";
import {
  migrateSliceSchema,
  SLICE_COMPONENT,
  SLICE_SCHEMA_SUPPORTED_VERSION,
} from "./slice-store-schema.mjs";

/**
 * Insert child rows (seeds/nodes/edges/misses) in canonical order. Callers pass
 * already-canonicalized arrays (output of `canonicalSlicePayload`), so the `seq`
 * index is deterministic and byte-stable on read-back.
 *
 * @param {InstanceType<typeof DatabaseSync>} db
 * @param {string} table - one of context_slice_{seeds,nodes,edges,misses}
 * @param {string} jsonCol - matching seed_json|node_json|edge_json|miss_json
 * @param {string} sliceId
 * @param {unknown[]} items
 */
function insertChildRows(db, table, jsonCol, sliceId, items) {
  if (!Array.isArray(items) || items.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO ${table} (slice_id, seq, ${jsonCol}) VALUES (?,?,?)`,
  );
  for (let i = 0; i < items.length; i++) {
    stmt.run(sliceId, i, stableStringify(items[i]));
  }
}

/**
 * Open (or create) the Slice store at `dbPath`, running schema bootstrap + the
 * forward-only migration in one call.
 *
 * @param {string} dbPath - filesystem path, or `":memory:"` for an ephemeral DB.
 * @returns {{ _db: InstanceType<typeof DatabaseSync>, dbPath: string, close: () => void }}
 * @throws {SliceStoreError} dbPath missing/invalid, parent dir creation failed,
 *   or the DB could not be opened.
 * @throws {SliceMigrationError} the DB already records a future schema version.
 */
export function openSliceStore(dbPath) {
  if (typeof dbPath !== "string" || dbPath === "") {
    throw new SliceStoreError("dbPath required");
  }
  const isMemory = dbPath === ":memory:";

  if (!isMemory) {
    try {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new SliceStoreError("failed to create slice store parent directory", {
        cause: err,
      });
    }
  }

  let db;
  try {
    db = new DatabaseSync(dbPath);
  } catch (err) {
    throw new SliceStoreError("failed to open slice store database", { cause: err });
  }

  try {
    assertComponentSchemaVersionSupported(
      db,
      SLICE_COMPONENT,
      SLICE_SCHEMA_SUPPORTED_VERSION,
      SliceMigrationError,
    );
    migrateLayerTableNames(db, SliceStoreError);
    migrateSliceSchema(db);
  } catch (err) {
    db.close();
    throw err;
  }

  if (!isMemory) {
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // best-effort: some filesystems/volumes do not support mode change
    }
  }

  return {
    _db: db,
    dbPath,
    close() {
      db.close();
    },

    /**
     * Idempotently persist a Context Slice inside one `BEGIN IMMEDIATE` tx.
     * Same derivation_key + identical canonical bytes → {created:false} cache hit.
     * Same derivation_key + divergent bytes → SliceCollisionError (DB unchanged).
     * The current pointer switches ONLY after the root+children commit.
     *
     * @param {object} input
     * @returns {{ created: boolean, slice_id: string }}
     */
    persist(input) {
      if (!input || typeof input !== "object") {
        throw new SliceStoreError("persist input required");
      }
      const {
        derivationKey,
        sliceHash,
        canonicalPayload,
        provenance,
        coverage,
        policy,
        systemNamespace,
        seedSetHash,
        status,
        materializationMs = 0,
      } = input;
      if (!derivationKey) throw new SliceStoreError("derivationKey required");
      if (!sliceHash) throw new SliceStoreError("sliceHash required");
      if (!canonicalPayload) throw new SliceStoreError("canonicalPayload required");
      if (!policy || !policy.name || policy.version === undefined) {
        throw new SliceStoreError("policy.{name,version} required");
      }
      if (!systemNamespace) throw new SliceStoreError("systemNamespace required");
      if (!seedSetHash) throw new SliceStoreError("seedSetHash required");
      if (status !== "cache_hit" && status !== "materialized") {
        throw new SliceStoreError("status must be cache_hit|materialized");
      }

      const canonical = canonicalSlicePayload(canonicalPayload);
      const canonicalJson = stableStringify(canonical);
      const sliceId = makeSliceId(sliceHash);
      const now = new Date().toISOString();
      const idVersion = canonical.id_version ?? ID_VERSION;

      db.exec("BEGIN IMMEDIATE");
      let created = false;
      try {
        const existing = /** @type {{slice_id:string, canonical_payload_json:string}|undefined} */ (
          db
            .prepare(
              `SELECT slice_id, canonical_payload_json FROM context_slices WHERE derivation_key = ?`,
            )
            .get(derivationKey)
        );

        if (existing) {
          if (existing.canonical_payload_json === canonicalJson) {
            db.exec("COMMIT");
            return { created: false, slice_id: existing.slice_id };
          }
          throw new SliceCollisionError(
            `divergent canonical payload for derivation key ${derivationKey}: collision rejected`,
          );
        }

        db.prepare(
          `INSERT INTO context_slices (
             slice_id, derivation_key, slice_hash, canonical_payload_json,
             provenance_json, coverage_json, policy_name, policy_version,
             status, system_namespace, seed_set_hash, id_version,
             created_at, updated_at, materialization_ms
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          sliceId,
          derivationKey,
          sliceHash,
          canonicalJson,
          stableStringify(provenance ?? {}),
          stableStringify(coverage ?? canonical.coverage ?? {}),
          policy.name,
          policy.version,
          status,
          systemNamespace,
          seedSetHash,
          idVersion,
          now,
          now,
          materializationMs,
        );

        insertChildRows(db, "context_slice_seeds", "seed_json", sliceId, canonical.seeds);
        insertChildRows(db, "context_slice_nodes", "node_json", sliceId, canonical.nodes);
        insertChildRows(db, "context_slice_edges", "edge_json", sliceId, canonical.edges);
        insertChildRows(db, "context_slice_misses", "miss_json", sliceId, canonical.misses);

        db.prepare(
          `INSERT INTO context_slice_current (system_namespace, policy_name, seed_set_hash, slice_id)
           VALUES (?,?,?,?)
           ON CONFLICT(system_namespace, policy_name, seed_set_hash)
           DO UPDATE SET slice_id = excluded.slice_id`,
        ).run(systemNamespace, policy.name, seedSetHash, sliceId);

        db.exec("COMMIT");
        created = true;
      } catch (err) {
        let rollbackErr;
        try {
          db.exec("ROLLBACK");
        } catch (rb) {
          rollbackErr = rb;
        }
        if (err instanceof SliceCollisionError) {
          if (rollbackErr instanceof Error) {
            throw new SliceStoreError(
              `collision detected but rollback failed: ${rollbackErr.message}`,
              { cause: err },
            );
          }
          throw err;
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
      return { created, slice_id: sliceId };
    },

    /**
     * Read the canonical payload by derivation key. Returns null when absent.
     * The returned object round-trips through `canonicalSlicePayload` byte-for-byte
     * because `canonical_payload_json` stores `stableStringify(canonicalSlicePayload(input))`.
     *
     * @param {{ derivationKey: string }} q
     * @returns {Record<string, unknown> | null}
     */
    read({ derivationKey }) {
      if (!derivationKey) throw new SliceStoreError("derivationKey required");
      const row = /** @type {{canonical_payload_json?: string}|undefined} */ (
        db
          .prepare(
            `SELECT canonical_payload_json FROM context_slices WHERE derivation_key = ?`,
          )
          .get(derivationKey)
      );
      return row ? JSON.parse(row.canonical_payload_json) : null;
    },

    /**
     * Read the canonical payload by slice_hash.
     *
     * @param {{ sliceHash: string }} q
     * @returns {Record<string, unknown> | null}
     */
    readByHash({ sliceHash }) {
      if (!sliceHash) throw new SliceStoreError("sliceHash required");
      const row = /** @type {{canonical_payload_json?: string}|undefined} */ (
        db
          .prepare(
            `SELECT canonical_payload_json FROM context_slices WHERE slice_hash = ?`,
          )
          .get(sliceHash)
      );
      return row ? JSON.parse(row.canonical_payload_json) : null;
    },

    /**
     * List slice summaries for a (system_namespace, policy_name) pair.
     *
     * @param {{ systemNamespace: string, policyName: string }} q
     * @returns {{ slice_id: string, slice_hash: string, derivation_key: string, created_at: string }[]}
     */
    list({ systemNamespace, policyName }) {
      if (!systemNamespace) throw new SliceStoreError("systemNamespace required");
      if (!policyName) throw new SliceStoreError("policyName required");
      return /** @type {any[]} */ (
        db
          .prepare(
            `SELECT slice_id, slice_hash, derivation_key, created_at
             FROM context_slices
             WHERE system_namespace = ? AND policy_name = ?
             ORDER BY created_at ASC`,
          )
          .all(systemNamespace, policyName)
      );
    },

    /**
     * Point the current pointer at a known slice. Convenience only — never a
     * freshness check (the plan requires cache hits to recompute the full key).
     *
     * @param {{ systemNamespace: string, policyName: string, seedSetHash: string, sliceId: string }} q
     */
    setCurrent({ systemNamespace, policyName, seedSetHash, sliceId }) {
      if (!systemNamespace || !policyName || !seedSetHash || !sliceId) {
        throw new SliceStoreError(
          "systemNamespace, policyName, seedSetHash, sliceId required",
        );
      }
      const exists = db.prepare(`SELECT 1 FROM context_slices WHERE slice_id = ?`).get(sliceId);
      if (!exists) throw new SliceStoreError(`slice_id not found: ${sliceId}`);
      db.prepare(
        `INSERT INTO context_slice_current (system_namespace, policy_name, seed_set_hash, slice_id)
         VALUES (?,?,?,?)
         ON CONFLICT(system_namespace, policy_name, seed_set_hash)
         DO UPDATE SET slice_id = excluded.slice_id`,
      ).run(systemNamespace, policyName, seedSetHash, sliceId);
    },

    /**
     * Read the current pointer for a (namespace, policy, seed_set_hash) triple.
     * Returns {slice_id, derivation_key} or null. Convenience only.
     *
     * @param {{ systemNamespace: string, policyName: string, seedSetHash: string }} q
     * @returns {{ slice_id: string, derivation_key: string } | null}
     */
    getCurrent({ systemNamespace, policyName, seedSetHash }) {
      if (!systemNamespace || !policyName || !seedSetHash) {
        throw new SliceStoreError(
          "systemNamespace, policyName, seedSetHash required",
        );
      }
      const row = /** @type {{slice_id?: string, derivation_key?: string}|undefined} */ (
        db
          .prepare(
            `SELECT c.slice_id, s.derivation_key
             FROM context_slice_current c
             JOIN context_slices s ON s.slice_id = c.slice_id
             WHERE c.system_namespace = ? AND c.policy_name = ? AND c.seed_set_hash = ?`,
          )
          .get(systemNamespace, policyName, seedSetHash)
      );
      return row ? { slice_id: row.slice_id, derivation_key: row.derivation_key } : null;
    },
  };
}
