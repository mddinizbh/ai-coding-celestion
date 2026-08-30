/**
 * Layered identity module — single deterministic source of truth for every ID
 * produced by the explorer pipeline (L0/L1/L2/Slice/Pack).
 *
 * Locked decisions (plan persistent-context-slice-engine-v2.md, Todo 8b):
 *  - ID_VERSION=2: every new ID carries an explicit layer prefix
 *    (l0:<kind>:, l0:rel:, l0:ff:, l1:edge:, l2:journey:, l2:bind:, slice:, pack:).
 *  - Legacy unprefixed IDs (service:x, ff:..., l1:<hash>) are id_version=1.
 *  - Hash bodies preserve their pre-Todo-8b widths:
 *      • l0:ff:<kind>:<16-hex-sha256>     (frontier-export.mjs width)
 *      • l1:edge:<32-hex-sha256>          (matcher.mjs edge_id width)
 *      • l2:bind:<32-hex-sha256>          (journey-bind.mjs journey_hash width)
 *      • slice:<64-hex>  ·  pack:<64-hex>
 *  - Hash material includes ID_VERSION so changing ONLY the version invalidates
 *    every downstream identity (canonical_graph_hash, edge_id, journey_hash,
 *    derivation_key, slice_hash, pack_id).
 *  - Raw code-unit compare. NEVER localeCompare.
 *  - No clocks enter any hash.
 *
 * Production builders are pinned to ID_VERSION=2 via the
 * `createLayeredIdBuilders({idVersion})` factory. Tests instantiate the
 * factory with `idVersion: 1` to PROVE byte-different outputs from the same
 * inputs (executable invalidation proof, ADR 0009).
 *
 * This module is the lowest reusable identity layer. L1/L2/query import from
 * here; no duplicate builders allowed (plan MUST DO).
 *
 * @module skills/explorer-l0/src/layered-id.mjs
 */

import { createHash } from "node:crypto";
import { sha256Text, stableStringify } from "./stable-json.mjs";

/** Bump when the visible ID format changes. Participates in every hash. */
export const ID_VERSION = 2;
export const SUPPORTED_ID_VERSIONS = Object.freeze([1, 2]);

// Width constants — preserve current hash entropy (plan MUST DO).
const FF_HASH_WIDTH = 16;
const L1_EDGE_HASH_WIDTH = 32;
const L2_BIND_HASH_WIDTH = 32;
const SLICE_PACK_HASH_WIDTH = 64;

// Layer prefixes (closed enum).
const L0_PREFIX = "l0:";
const L0_REL_PREFIX = "l0:rel:";
const L0_FF_PREFIX = "l0:ff:";
const L1_EDGE_PREFIX = "l1:edge:";
const L2_JOURNEY_PREFIX = "l2:journey:";
const L2_BIND_PREFIX = "l2:bind:";
const SLICE_PREFIX = "slice:";
const PACK_PREFIX = "pack:";

// Layer prefixes that mark a v2 id (anything else is v1 legacy).
const V2_PREFIXES = [
  L0_PREFIX,
  L1_EDGE_PREFIX,
  L2_JOURNEY_PREFIX,
  L2_BIND_PREFIX,
  SLICE_PREFIX,
  PACK_PREFIX,
];

/**
 * Base typed error for layered identity violations.
 */
export class LayeredIdError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "LayeredIdError";
  }
}

/**
 * Raised when a set of IDs mixes id_version=1 and id_version=2 shapes.
 * v2 readers reject mixed versions with this typed error (plan MUST DO).
 */
export class MixedVersionError extends LayeredIdError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "MixedVersionError";
  }
}

/** Raised when a single layered id fails a structural assertion. */
export class InvalidLayeredIdError extends LayeredIdError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "InvalidLayeredIdError";
  }
}

/**
 * Normalize a natural-key segment for use in an ID body.
 * NFC unicode, trim, lowercase, collapse whitespace runs to a single '-'.
 *
 * @param {string} segment
 * @returns {string}
 */
export function normalizeNaturalKey(segment) {
  if (typeof segment !== "string") {
    throw new LayeredIdError("natural key segment must be a string");
  }
  const normalized = segment.normalize("NFC").trim().toLowerCase().replace(/\s+/g, "-");
  if (normalized === "") {
    throw new LayeredIdError("natural key segment is empty after normalization");
  }
  return normalized;
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
 * SHA-256 hex of a string.
 * @param {string} text
 * @returns {string} 64-char lowercase hex
 */
function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * SHA-256 hex of a string, sliced to `width`. Used by ff / l1 edge / l2 bind
 * to preserve their pre-Todo-8b hash widths while still hashing ID_VERSION.
 *
 * @param {string} material
 * @param {number} width
 * @returns {string}
 */
function sha256Width(material, width) {
  return sha256Hex(material).slice(0, width);
}

/**
 * Factory: parameterized identity builders. Production code uses
 * `createLayeredIdBuilders()` (defaults to ID_VERSION=2). Tests pass
 * `{idVersion: 1}` to compute legacy outputs from the same inputs and prove
 * byte-different hashes (executable invalidation proof).
 *
 * v1 builders reproduce the pre-Todo-8b legacy shapes exactly:
 *   • l0 record: `<type>:<key>`         (no l0: prefix)
 *   • l0 relation: `<type>:<from>-><to>` (no l0:rel:, lowercase type)
 *   • ff: `ff:<kind>:<16-hex>`           (no l0:ff:)
 *   • l1 edge: `l1:<32-hex>`             (no l1:edge:)
 *   • l2 journey: `<id>` verbatim        (no l2:journey:)
 *   • l2 bind: `<material>` verbatim     (no l2:bind:)
 *
 * `idv<N>` enters the hash material of every hashed builder, so identical
 * inputs at idVersion=1 and idVersion=2 produce different hashes.
 *
 * @param {{ idVersion?: 1 | 2 }} [options]
 * @returns {{
 *   ID_VERSION: 1 | 2,
 *   makeL0RecordId: (recordKind: string, naturalKey: string) => string,
 *   makeL0RelationId: (relationType: string, fromNaturalKey: string, toNaturalKey: string) => string,
 *   makeFrontierFactId: (input: object) => string,
 *   makeL1EdgeId: (material: string) => string,
 *   makeL2JourneyId: (journeyId: string) => string,
 *   makeL2BindId: (material: string) => string,
 *   makeSliceId: (hash: string) => string,
 *   makePackId: (hash: string) => string,
 * }}
 */
export function createLayeredIdBuilders(options = {}) {
  const idVersion = options.idVersion ?? ID_VERSION;
  if (!SUPPORTED_ID_VERSIONS.includes(idVersion)) {
    throw new LayeredIdError(
      `unsupported idVersion ${idVersion}; supported: ${SUPPORTED_ID_VERSIONS.join(", ")}`,
    );
  }
  const stamp = `idv${idVersion}`;
  const v2 = idVersion === 2;

  /** @param {string} recordKind @param {string} naturalKey */
  const makeL0RecordId = (recordKind, naturalKey) => {
    const kind = normalizeNaturalKey(recordKind);
    const key = normalizeNaturalKey(naturalKey);
    return v2 ? `${L0_PREFIX}${kind}:${key}` : `${kind}:${key}`;
  };

  /** @param {string} relationType @param {string} fromNaturalKey @param {string} toNaturalKey */
  const makeL0RelationId = (relationType, fromNaturalKey, toNaturalKey) => {
    if (typeof relationType !== "string" || relationType.trim() === "") {
      throw new LayeredIdError("relation_type is empty");
    }
    const from = normalizeNaturalKey(fromNaturalKey);
    const to = normalizeNaturalKey(toNaturalKey);
    if (v2) {
      return `${L0_REL_PREFIX}${relationType.trim().toUpperCase()}:${from}->${to}`;
    }
    // v1: lowercase type, no prefix; legacy `exposes:service:billing->endpoint:b`
    return `${relationType.trim().toLowerCase()}:${from}->${to}`;
  };

  /** @param {object} input */
  const makeFrontierFactId = (input) => {
    if (!input || typeof input !== "object") {
      throw new LayeredIdError("makeFrontierFactId requires an input object");
    }
    const { kind, namespace, logical_repo, source_revision, identity_key, file, line } = input;
    if (
      typeof kind !== "string" || kind === "" ||
      typeof namespace !== "string" || namespace === "" ||
      typeof logical_repo !== "string" || logical_repo === "" ||
      typeof source_revision !== "string" || source_revision === "" ||
      typeof identity_key !== "string" || identity_key === "" ||
      typeof file !== "string" ||
      typeof line !== "number"
    ) {
      throw new LayeredIdError("makeFrontierFactId: required fields missing or wrong type");
    }
    const material = [
      stamp,
      namespace,
      logical_repo,
      source_revision,
      kind,
      identity_key,
      file,
      String(line),
    ].join("|");
    const hash = sha256Width(material, FF_HASH_WIDTH);
    return v2 ? `${L0_FF_PREFIX}${kind}:${hash}` : `ff:${kind}:${hash}`;
  };

  /** @param {string} material */
  const makeL1EdgeId = (material) => {
    if (typeof material !== "string" || material === "") {
      throw new LayeredIdError("makeL1EdgeId requires a non-empty material string");
    }
    const hash = sha256Width(`${stamp}|${material}`, L1_EDGE_HASH_WIDTH);
    return v2 ? `${L1_EDGE_PREFIX}${hash}` : `l1:${hash}`;
  };

  /** @param {string} journeyId */
  const makeL2JourneyId = (journeyId) => {
    if (typeof journeyId !== "string" || journeyId.trim() === "") {
      throw new LayeredIdError("journey-id must be a non-empty string");
    }
    return v2 ? `${L2_JOURNEY_PREFIX}${journeyId}` : journeyId;
  };

  /** @param {string} material */
  const makeL2BindId = (material) => {
    if (typeof material !== "string" || material === "") {
      throw new LayeredIdError("makeL2BindId requires a non-empty material string");
    }
    if (!v2) {
      // v1 makeBindId returned `${ns}:${journeyId}:${hash}` verbatim — that
      // IS the material string. No prefix, no rehash.
      return material;
    }
    const hash = sha256Width(`${stamp}|${material}`, L2_BIND_HASH_WIDTH);
    return `${L2_BIND_PREFIX}${hash}`;
  };

  /** @param {string} hash */
  const makeSliceId = (hash) => {
    assertHashWidth(hash, SLICE_PACK_HASH_WIDTH, "slice");
    return `${SLICE_PREFIX}${hash}`;
  };

  /** @param {string} hash */
  const makePackId = (hash) => {
    assertHashWidth(hash, SLICE_PACK_HASH_WIDTH, "pack");
    return `${PACK_PREFIX}${hash}`;
  };

  return {
    ID_VERSION: idVersion,
    makeL0RecordId,
    makeL0RelationId,
    makeFrontierFactId,
    makeL1EdgeId,
    makeL2JourneyId,
    makeL2BindId,
    makeSliceId,
    makePackId,
  };
}

// --- Production exports pinned to ID_VERSION=2 -------------------------------
// Consumers import these directly. The factory above is the canonical entry
// point; these are convenience re-exports that always produce v2 ids.
const V2_BUILDERS = createLayeredIdBuilders({ idVersion: ID_VERSION });

/**
 * L0 record id: `l0:<record-kind>:<canonical-natural-key>`.
 *
 * @param {string} recordKind  e.g. "Service", "Endpoint"
 * @param {string} naturalKey  e.g. "billing", "get:/billing"
 * @returns {string}
 */
export const makeL0RecordId = V2_BUILDERS.makeL0RecordId;

/**
 * L0 relation id. The body carries canonical NATURAL KEYS only (NOT full L0
 * record ids). Plan MUST DO: relation IDs contain canonical natural keys while
 * relation endpoints continue storing full L0 record IDs.
 *
 * Format: `l0:rel:<RELATION_TYPE>:<from-canonical-natural-key>-><to-canonical-natural-key>`
 *
 * @param {string} relationType
 * @param {string} fromNaturalKey
 * @param {string} toNaturalKey
 * @returns {string}
 */
export const makeL0RelationId = V2_BUILDERS.makeL0RelationId;

/**
 * FrontierFact id (v2 production form). Tests use `createLayeredIdBuilders`
 * directly when they need v1 outputs.
 * @param {object} input
 * @returns {string} `l0:ff:<kind>:<16-hex>`
 */
export const makeFrontierFactId = V2_BUILDERS.makeFrontierFactId;

/** L1 edge id (v2 production form). @param {string} material @returns {string} */
export const makeL1EdgeId = V2_BUILDERS.makeL1EdgeId;

/** L2 journey id (v2 production form). @param {string} journeyId @returns {string} */
export const makeL2JourneyId = V2_BUILDERS.makeL2JourneyId;

/** L2 bind id (v2 production form). @param {string} material @returns {string} */
export const makeL2BindId = V2_BUILDERS.makeL2BindId;

/** Slice id: `slice:<64-hex-slice-hash>`. @param {string} hash @returns {string} */
export const makeSliceId = V2_BUILDERS.makeSliceId;

/** Pack id: `pack:<64-hex-pack-hash>`. @param {string} hash @returns {string} */
export const makePackId = V2_BUILDERS.makePackId;

/**
 * @param {string} hash
 * @param {number} width
 * @param {string} label
 */
function assertHashWidth(hash, width, label) {
  if (typeof hash !== "string" || !new RegExp(`^[a-f0-9]{${width}}$`).test(hash)) {
    throw new LayeredIdError(`${label} hash must be ${width}-char lowercase hex SHA-256`);
  }
}

/**
 * Detect the id_version of an opaque id string.
 * Returns 2 for any v2 layered prefix, 1 for legacy unprefixed shapes.
 *
 * @param {string} id
 * @returns {1 | 2}
 */
export function detectIdVersion(id) {
  if (typeof id !== "string" || id === "") return 1;
  for (const prefix of V2_PREFIXES) {
    if (id.startsWith(prefix)) return 2;
  }
  return 1;
}

/** @param {string} id @returns {boolean} */
export function isV1(id) {
  return detectIdVersion(id) === 1;
}

/** @param {string} id @returns {boolean} */
export function isV2(id) {
  return detectIdVersion(id) === 2;
}

/**
 * Assert that every id in the list belongs to the same id_version.
 * Mixed v1+v2 inputs raise `MixedVersionError` — v2 readers reject mixed
 * versions with this typed error (plan MUST DO: no alias table, dual-read,
 * or silent fallback).
 *
 * @param {string[]} ids
 * @param {{ expected?: 1 | 2 }} [options]
 * @returns {{ version: 1 | 2, ids: string[] }}
 */
export function assertAllSameVersion(ids, options = {}) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new MixedVersionError("assertAllSameVersion requires a non-empty id list");
  }
  const first = detectIdVersion(ids[0]);
  for (let i = 1; i < ids.length; i += 1) {
    if (detectIdVersion(ids[i]) !== first) {
      throw new MixedVersionError(
        `mixed id_version detected: id[0]=${ids[0]} (v${first}) vs id[${i}]=${ids[i]} (v${
          detectIdVersion(ids[i])
        }); v2 readers reject mixed versions`,
      );
    }
  }
  if (options.expected !== undefined && options.expected !== first) {
    throw new MixedVersionError(
      `expected id_version=${options.expected} but found v${first}`,
    );
  }
  return { version: first, ids };
}

/**
 * Assert that an L1 edge's `from` and `to` endpoints reference FrontierFacts
 * (`l0:ff:*`) — never an L0 record id like `l0:method:*`, `l0:endpoint:*`,
 * `l0:service:*`, or `l0:controller:*`. Plan MUST DO / MUST NOT DO.
 *
 * @param {{ from: { fact_id: string }, to: { fact_id: string } }} edge
 */
export function assertL0FfEndpoints(edge) {
  if (!edge || typeof edge !== "object") {
    throw new InvalidLayeredIdError("assertL0FfEndpoints requires an edge object");
  }
  for (const side of ["from", "to"]) {
    const factId = edge[side]?.fact_id;
    if (typeof factId !== "string" || !factId.startsWith(L0_FF_PREFIX)) {
      throw new InvalidLayeredIdError(
        `L1 edge ${side}.fact_id must be a FrontierFact id (l0:ff:*); got: ${String(factId)}`,
      );
    }
  }
}

/**
 * Convenience: hash the v2 stamp + value with stableStringify (used by
 * migration plumbing and derivation key structures that need to fold
 * ID_VERSION into a payload hash).
 *
 * @param {unknown} value
 * @returns {string} 64-char hex
 */
export function hashWithVersion(value) {
  return sha256Text(stableStringify({ id_version: ID_VERSION, value }));
}
