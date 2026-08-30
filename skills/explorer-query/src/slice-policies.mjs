/**
 * Slice policies — versioned registry of the three traversal policy cards.
 *
 * Plan Scope #5 (verbatim semantics):
 *   - journey@1: forward, default allowlist CALLS,EXPOSES; visits each node
 *     once; stops on missing edge, relation off-allowlist or end of graph.
 *   - impact@1: bidirectional; L0 CALLS,EXPOSES both ways, L1 cross-service
 *     both ways, L2 edge→journey associations; classifies seed|upstream|
 *     downstream|cross_service|data_dependency. data_dependency is emitted
 *     ONLY when the indexed relation type explicitly declares it — NEVER
 *     inferred by name.
 *   - drill-down@1: EXPOSES and CALLS forward, max_hops=2 default; max_hops
 *     is an explicit option that enters options_hash; a frontier reached at
 *     the hop limit becomes a policy_boundary miss, NEVER silent truncation.
 *
 * L1 is cross-repo ONLY (matcher.mjs:89-99): impact must not promote
 * intra-repo calls to L1 — that responsibility stays at L0.
 *
 * Safety ceilings (max_nodes=100000, max_edges=200000) are materialization
 * guardrails, NOT Pack budget — exceeding them fails materialization.
 *
 * Coord note for orchestrator: slice-canonical.mjs (Todo 2) had NOT landed
 * here, so optionsHash is defined locally via explorer-l0 stable-json. When
 * Todo 2 lands, prefer routing optionsHash through slice-canonical.mjs so
 * the engine has a single hashing implementation.
 */

import { stableStringify, sha256Text } from "../../explorer-l0/src/stable-json.mjs";

/**
 * Closed relation universe for v1 policy cards. The default allowlist
 * (CALLS,EXPOSES) is a subset of this set. Add relation kinds here only
 * when the indexed baseline declares them — never by name inference.
 * @type {ReadonlySet<string>}
 */
export const KNOWN_RELATIONS = new Set(["CALLS", "EXPOSES"]);

/** Relations that, when traversed, classify a node as `data_dependency`. */
const DATA_RELATION_KINDS = new Set([]);

const DEFAULT_ALLOWLIST = ["CALLS", "EXPOSES"];

/** @typedef {{max_nodes:number, max_edges:number}} SafetyCeilings */
/** @typedef {{name:string, version:number}} PolicyRef */

/**
 * @typedef {Object} PolicyCard
 * @property {string} name
 * @property {number} version
 * @property {"forward"|"bidirectional"} direction
 * @property {string[]} allowlist
 * @property {string} hop_rule
 * @property {SafetyCeilings} safety_ceilings
 * @property {string} boundary_behavior
 * @property {object} [default_options]
 * @property {string[]} [classifications]
 * @property {string[]} [data_relation_kinds]
 */

/** @type {SafetyCeilings} */
const SAFETY_CEILINGS = Object.freeze({
  max_nodes: 100000,
  max_edges: 200000,
});

/**
 * Build a frozen policy card. Default allowlist is CALLS,EXPOSES; callers
 * may narrow it but cannot widen it beyond KNOWN_RELATIONS.
 *
 * @param {{
 *   name: string,
 *   version: number,
 *   direction: "forward"|"bidirectional",
 *   allowlist?: string[],
 *   hop_rule: string,
 *   boundary_behavior: string,
 *   default_options?: object,
 *   classifications?: string[],
 * }} spec
 * @returns {PolicyCard}
 */
function makePolicy(spec) {
  const allowlist = spec.allowlist ? [...spec.allowlist] : [...DEFAULT_ALLOWLIST];
  assertAllowedRelations(allowlist);
  const card = {
    name: spec.name,
    version: spec.version,
    direction: spec.direction,
    allowlist,
    hop_rule: spec.hop_rule,
    safety_ceilings: { ...SAFETY_CEILINGS },
    boundary_behavior: spec.boundary_behavior,
  };
  if (spec.default_options) card.default_options = { ...spec.default_options };
  if (spec.classifications) card.classifications = [...spec.classifications];
  card.data_relation_kinds = [...DATA_RELATION_KINDS];
  return Object.freeze(card);
}

/** @type {PolicyCard[]} */
const REGISTRY = Object.freeze([
  makePolicy({
    name: "journey",
    version: 1,
    direction: "forward",
    allowlist: ["CALLS", "EXPOSES"],
    hop_rule: "unbounded_per_visited_set",
    boundary_behavior: "stop_on_missing_edge_or_off_allowlist_or_end_of_graph",
    default_options: {},
  }),
  makePolicy({
    name: "impact",
    version: 1,
    direction: "bidirectional",
    allowlist: ["CALLS", "EXPOSES"],
    hop_rule: "unbounded_per_visited_set",
    boundary_behavior: "classify_and_continue",
    default_options: {},
    classifications: [
      "seed",
      "upstream",
      "downstream",
      "cross_service",
      "data_dependency",
    ],
  }),
  makePolicy({
    name: "drill-down",
    version: 1,
    direction: "forward",
    allowlist: ["EXPOSES", "CALLS"],
    hop_rule: "max_hops_explicit",
    boundary_behavior: "policy_boundary_miss_at_hop_limit",
    default_options: { max_hops: 2 },
  }),
]);

/**
 * @returns {PolicyCard[]}
 */
export function listPolicies() {
  return REGISTRY.map((p) => p);
}

/**
 * @param {string} name
 * @param {number} version
 * @returns {PolicyCard}
 */
export function getPolicy(name, version) {
  if (typeof name !== "string" || typeof version !== "number") {
    throw new Error(`policy name must be string and version must be number`);
  }
  const card = REGISTRY.find(
    (p) => p.name === name && p.version === version,
  );
  if (!card) {
    throw new Error(`unknown policy ${name}@${version}`);
  }
  return card;
}

/**
 * Closed-allowlist guard. Throws if any relation is outside
 * KNOWN_RELATIONS. Public so tests and future policy authors can prove the
 * closure is tight (e.g. relation UNKNOWN must throw).
 *
 * @param {unknown[]} relations
 */
export function assertAllowedRelations(relations) {
  if (!Array.isArray(relations)) {
    throw new Error("relations must be an array");
  }
  for (const r of relations) {
    if (typeof r !== "string" || !KNOWN_RELATIONS.has(r)) {
      throw new Error(
        `relation '${String(r)}' is outside the closed allowlist ${[
          ...KNOWN_RELATIONS,
        ].join(",")}`,
      );
    }
  }
}

/**
 * Normalize raw options for a policy: fill defaults, reject unknown keys
 * (closure tight — never silently drop), and return a canonical object
 * whose keys are sorted (stableStringify handles final sort).
 *
 * @param {string} name
 * @param {unknown} rawOptions
 * @returns {object}
 */
export function normalizeOptions(name, rawOptions) {
  const card = getPolicy(name, 1); // v1 only; versioned lookup delegated to optionsHash
  const defaults = card.default_options || {};
  const input = rawOptions && typeof rawOptions === "object" && !Array.isArray(rawOptions)
    ? /** @type {Record<string, unknown>} */ (rawOptions)
    : {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(defaults)) {
    out[key] = defaults[key];
  }
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
      throw new Error(
        `unknown option '${key}' for policy ${name}@1 (closure is tight)`,
      );
    }
    out[key] = input[key];
  }
  // Per-option validation: max_hops must be a positive integer.
  if (Object.prototype.hasOwnProperty.call(out, "max_hops")) {
    const v = out.max_hops;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new Error("option max_hops must be a positive integer");
    }
  }
  return out;
}

/**
 * Deterministic sha256 (64-hex) of `{name, version, options}`.
 * Input options MUST already be normalized (defaults filled, unknowns
 * rejected). stableStringify sorts keys so insertion order is irrelevant.
 *
 * @param {string} name
 * @param {number} version
 * @param {object} options
 * @returns {string}
 */
export function optionsHash(name, version, options) {
  if (typeof name !== "string" || typeof version !== "number") {
    throw new Error("optionsHash requires (string, number, object)");
  }
  return sha256Text(
    stableStringify({ name, version, options: options || {} }),
  );
}
