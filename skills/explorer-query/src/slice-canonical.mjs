/**
 * Canonical projection, stable IDs and deterministic hashes for the
 * persistent Context Slice.
 *
 * Plan-locked rules (persistent-context-slice-engine-v2, Scope Must-have #3/#7):
 *  - Canonical sort: RAW code-unit compare (`a < b ? -1 : a > b ? 1 : 0`).
 *    NEVER `localeCompare`. NEVER use `score` as a canonical sort key.
 *  - Clocks (`*_at`, durations `*_ms`, `Date.now()`, `performance.now()`) never
 *    enter a hashed payload. The audit envelope (created_at/updated_at/
 *    materialization_ms) is a SIBLING of the canonical payload, never inside.
 *  - Unknown canonical fields are rejected via an ALLOWLIST projection that
 *    THROWS SliceDeterminismError. No silent deletion.
 *  - `stableStringify`/`sha256Text` are reused from explorer-l0; not reimplemented.
 */

import { sha256Text, stableStringify } from "../../explorer-l0/src/stable-json.mjs";
import { ID_VERSION } from "../../explorer-l0/src/layered-id.mjs";
// Reconciled with Todo 4: import the canonical SliceDeterminismError rather
// than forking a local copy. Re-exported here so consumers of canonicalization
// can import everything from one module.
export { SliceDeterminismError } from "./slice-errors.mjs";
import { SliceDeterminismError } from "./slice-errors.mjs";

/** Re-export the active ID_VERSION so callers can fold it into payloads. */
export { ID_VERSION };

/** Keys recognised as audit envelope siblings (stripped, not canonical). */
const AUDIT_ENVELOPE_FIELDS = new Set([
  "created_at",
  "updated_at",
  "materialization_ms",
]);

/**
 * Allowlist of canonical fields for an L1 edge when computing edgeSetHash.
 * `score` and any `*_at` are intentionally absent: they are ranking/audit
 * signals, not part of edge-set identity.
 */
const EDGE_HASH_FIELDS = new Set([
  "edge_id",
  "system_namespace",
  "from",
  "to",
  "contract_key",
  "match_kind",
  "config_key",
]);

/** Anything matching this suffix is a clock/duration and is forbidden in hashes. */
const CLOCK_KEY = /_(at|ms)$/;

/**
 * Allowlist of canonical Slice payload top-level keys.
 * Anything not here and not in AUDIT_ENVELOPE_FIELDS => SliceDeterminismError.
 *
 * `id_version` is REQUIRED: every persisted Slice payload carries the layered
 * identity version (ADR 0009) so a version bump invalidates the derivation
 * key, slice_hash, and downstream Pack id.
 */
export const CANONICAL_PAYLOAD_FIELDS = new Set([
  "id_version",
  "schema_version",
  "engine_version",
  "system_namespace",
  "policy", // { name, version, options_hash }
  "seeds",
  "seed_set_hash",
  "nodes",
  "edges",
  "edge_set_hash",
  "misses",
  "l0_baselines",
  "l1", // { system_namespace, edge_set_hash }
  "l2_bindings",
  "coverage",
]);

/**
 * Copy only allowlisted keys from payload. Audit envelope fields are recognised
 * and dropped silently (they are siblings, not canonical). Any other unknown
 * key throws SliceDeterminismError. After projection, recursively asserts no
 * clock/duration field survives anywhere in the canonical output.
 *
 * @param {Record<string, unknown>} payload
 * @param {Set<string>} [allowlist]
 * @returns {Record<string, unknown>}
 */
export function projectCanonical(payload, allowlist = CANONICAL_PAYLOAD_FIELDS) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SliceDeterminismError("canonical payload must be a plain object");
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (AUDIT_ENVELOPE_FIELDS.has(key)) continue;
    if (!allowlist.has(key)) {
      throw new SliceDeterminismError(
        `forbidden canonical field '${key}': not in allowlist and not an audit envelope field`,
      );
    }
    out[key] = value;
  }
  assertNoClocks(out, "canonical");
  return out;
}

/**
 * Deterministic canonical projection of a materialized slice:
 *  1. project top-level keys through CANONICAL_PAYLOAD_FIELDS (throws on
 *     unknown non-audit keys);
 *  2. recursively reject any clock/duration field (`*_at`/`*_ms`) that
 *     survived projection (fail-closed);
 *  3. sort every set-like array (nodes/edges/misses/seeds/l0_baselines/
 *     l2_bindings) by its stable ID using raw code-unit compare, so the
 *     output is byte-identical regardless of insertion order.
 *
 * The audit envelope (created_at/updated_at/materialization_ms) is a SIBLING
 * of the canonical payload and is stripped, not hashed.
 *
 * @param {Record<string, unknown>} materialized
 * @returns {Record<string, unknown>}
 */
export function canonicalSlicePayload(materialized) {
  const out = projectCanonical(materialized, CANONICAL_PAYLOAD_FIELDS);
  if (Array.isArray(out.seeds)) out.seeds = sortById(out.seeds, seedKey);
  if (Array.isArray(out.nodes)) out.nodes = sortById(out.nodes, canonicalNodeId);
  if (Array.isArray(out.edges)) out.edges = sortById(out.edges, canonicalEdgeId);
  if (Array.isArray(out.misses)) out.misses = sortById(out.misses, canonicalMissId);
  if (Array.isArray(out.l0_baselines)) {
    out.l0_baselines = sortById(out.l0_baselines, L0_BASELINE_KEY);
  }
  if (Array.isArray(out.l2_bindings)) {
    out.l2_bindings = sortById(out.l2_bindings, L2_BIND_KEY);
  }
  return out;
}

/**
 * Fail-closed walk: any key ending in `_at`/`_ms` inside a hashed payload is a
 * determinism violation. Slices must never carry clocks.
 *
 * @param {unknown} value
 * @param {string} path
 */
function assertNoClocks(value, path) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertNoClocks(value[i], `${path}[${i}]`);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (CLOCK_KEY.test(k)) {
        throw new SliceDeterminismError(
          `forbidden clock/duration field '${k}' at ${path}: clocks are never canonical`,
        );
      }
      assertNoClocks(v, `${path}.${k}`);
    }
  }
}

// --- Stable IDs --------------------------------------------------------------

/** @param {{ id?: string } | object} node */
export function canonicalNodeId(node) {
  return /** @type {any} */ (node)?.id ?? "";
}

/** @param {{ edge_id?: string, id?: string } | object} edge */
export function canonicalEdgeId(edge) {
  const e = /** @type {any} */ (edge);
  return e?.edge_id ?? e?.id ?? "";
}

/** @param {{ id?: string } | object} miss */
export function canonicalMissId(miss) {
  return /** @type {any} */ (miss)?.id ?? "";
}

/**
 * Raw code-unit comparison. Plan-locked: never localeCompare.
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
export function compareRaw(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Return a NEW array sorted ascending by stable ID using raw compare.
 * Input is never mutated. Score is intentionally NOT used.
 *
 * @template T
 * @param {readonly T[]} items
 * @param {(item: T) => string} idFn
 * @returns {T[]}
 */
export function sortById(items, idFn) {
  return [...items].sort((a, b) => compareRaw(idFn(a) ?? "", idFn(b) ?? ""));
}

// --- Set hashes --------------------------------------------------------------

/**
 * Sort key for a seed tuple (kind, namespace|system_namespace, logical_repo, id, bind_id?).
 * Uses NUL separator so tuple components can't bleed into each other.
 *
 * @param {Record<string, unknown>} seed
 * @returns {string}
 */
function seedKey(seed) {
  const s = /** @type {any} */ (seed);
  const ns = s.system_namespace ?? s.namespace ?? "";
  const repo = s.logical_repo ?? "";
  const id = s.fact_id ?? s.edge_id ?? s.journey_id ?? s.id ?? "";
  const bind = s.bind_id ?? "";
  return [s.kind ?? "", ns, repo, id, bind].join("\u0000");
}

/**
 * SHA-256 over stable-stringified seeds sorted by their canonical tuple.
 * Caller passes seeds in ANY order; result is byte-stable.
 *
 * @param {object[]} seeds
 * @returns {string}
 */
export function seedSetHash(seeds) {
  const sorted = sortById(seeds ?? [], seedKey);
  return sha256Text(stableStringify(sorted));
}

/**
 * SHA-256 over stable-stringified edges projected to canonical fields and
 * sorted by edge_id. `score` and `created_at` (and any other non-canonical
 * field) are excluded via the EDGE_HASH_FIELDS allowlist — they are ranking/
 * audit signals, never part of edge-set identity.
 *
 * @param {object[]} edges
 * @returns {string}
 */
export function edgeSetHash(edges) {
  const projected = (edges ?? []).map((edge) => projectToAllowlist(edge, EDGE_HASH_FIELDS));
  const sorted = sortById(projected, canonicalEdgeId);
  return sha256Text(stableStringify(sorted));
}

/**
 * Copy only allowlisted keys from a value (allowlist projection, like
 * graph-hash.mjs `project`). Undefined fields are omitted.
 *
 * @param {Record<string, unknown>} value
 * @param {Set<string>} allowlist
 * @returns {Record<string, unknown>}
 */
function projectToAllowlist(value, allowlist) {
  if (value === null || typeof value !== "object") return {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(/** @type {Record<string, unknown>} */ (value))) {
    if (allowlist.has(key) && value[key] !== undefined) {
      out[key] = value[key];
    }
  }
  return out;
}

/**
 * SHA-256 over stable-stringified policy options. Callers normalise (fill
 * defaults) before hashing; `stableStringify` already sorts keys.
 *
 * @param {Record<string, unknown>} options
 * @returns {string}
 */
export function optionsHash(options) {
  const normalized =
    options && typeof options === "object" && !Array.isArray(options) ? options : {};
  return sha256Text(stableStringify(normalized));
}

// --- Derivation key ----------------------------------------------------------

const L0_BASELINE_KEY = (/** @type {any} */ b) =>
  [b.namespace ?? "", b.logical_repo ?? "", b.candidate_id ?? ""].join("\u0000");

const L2_BIND_KEY = (/** @type {any} */ b) =>
  [b.journey_id ?? "", b.bind_id ?? ""].join("\u0000");

/**
 * Build the exhaustive derivation key for a Slice request.
 *
 * Canonical struct (plan Must-have #3, verbatim, with ADR 0009 id_version):
 *   {id_version, engine_version, slice_schema_version, system_namespace,
 *    policy:{name,version,options_hash}, seeds:[...],
 *    l0_baselines:[{namespace,logical_repo,candidate_id,source_revision,canonical_graph_hash}],
 *    l1:{system_namespace,edge_set_hash},
 *    l2_bindings:[{journey_id,bind_id,journey_hash}]}
 *
 * `derivation_key = sha256(stableStringify(struct))`. `id_version` participates
 * in the struct so a layered identity version bump invalidates every Slice
 * cache entry without any other field changing (plan MUST DO).
 *
 * @param {object} struct
 * @returns {string} 64-char hex SHA-256
 */
export function derivationKey(struct) {
  const canonical = {
    id_version: struct.id_version ?? ID_VERSION,
    engine_version: struct.engine_version,
    slice_schema_version: struct.slice_schema_version,
    system_namespace: struct.system_namespace,
    policy: struct.policy,
    seeds: sortById(struct.seeds ?? [], seedKey),
    l0_baselines: sortById(struct.l0_baselines ?? [], L0_BASELINE_KEY),
    l1: struct.l1,
    l2_bindings: sortById(struct.l2_bindings ?? [], L2_BIND_KEY),
  };
  assertNoClocks(canonical, "derivation");
  return sha256Text(stableStringify(canonical));
}

/**
 * SHA-256 over the canonical projection of a slice payload.
 * Refuses clock-bearing input with SliceDeterminismError.
 *
 * @param {Record<string, unknown>} canonicalPayload
 * @returns {string}
 */
export function sliceHash(canonicalPayload) {
  assertNoClocks(canonicalPayload, "sliceHash");
  return sha256Text(stableStringify(canonicalPayload));
}
