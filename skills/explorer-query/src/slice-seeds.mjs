/**
 * Slice seeds — closed taxonomy for v1.
 *
 * Three seed kinds (plan Scope #2):
 *   - l0_fact:     {kind, namespace, logical_repo, fact_id}
 *   - l1_edge:     {kind, system_namespace, edge_id}
 *   - l2_journey:  {kind, system_namespace, journey_id, bind_id?}
 *     (absent bind_id resolves via l2_journey_current)
 *
 * Seeds are validated, deduplicated by full-key tuple and canonically
 * ordered by (kind, namespace|system_namespace, logical_repo|"", id) using
 * raw code-unit comparison — NEVER localeCompare and NEVER score.
 *
 * Coord note for orchestrator: slice-canonical.mjs (Todo 2) had NOT landed
 * when this was written, so `seedSetHash` is defined locally using the
 * shared `stableStringify`/`sha256Text` helpers from explorer-l0. When
 * Todo 2 lands, route `seedSetHash` through `./slice-canonical.mjs` so a
 * single hash implementation backs the whole engine.
 */

import { stableStringify, sha256Text } from "../../explorer-l0/src/stable-json.mjs";

/** @type {ReadonlySet<string>} */
const SEED_KINDS = new Set(["l0_fact", "l1_edge", "l2_journey"]);

/**
 * Company literal defaults are forbidden as namespaces — namespaces must be
 * explicit per call and never fall back to a corporate name. The blocklist
 * is matched case-insensitively. Add literals here when onboarding new
 * projects; do NOT remove the guardrail itself.
 * @type {ReadonlySet<string>}
 */
const FORBIDDEN_NAMESPACE_LITERALS = new Set([
  // Placeholder de exemplo. Ao onboardar, troque pelos literais corporativos
  // do seu time (nomes de empresa que jamais devem virar namespace).
  "example-corp",
]);

/**
 * Raw code-unit compare (UTF-16). Canonical engine sort — do not replace
 * with localeCompare, score, or anything that depends on environment.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareByCodeUnit(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Validate a single seed and return its normalized (closed-shape) form.
 * Throws on: non-object, unknown kind, missing required field, machine
 * path/file_path, free text, or company-literal namespace.
 *
 * @param {unknown} raw
 * @returns {{
 *   kind: "l0_fact",
 *   namespace: string,
 *   logical_repo: string,
 *   fact_id: string,
 * } | {
 *   kind: "l1_edge",
 *   system_namespace: string,
 *   edge_id: string,
 * } | {
 *   kind: "l2_journey",
 *   system_namespace: string,
 *   journey_id: string,
 *   bind_id?: string,
 * }}
 */
export function validateSeed(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("slice seed must be a non-null object");
  }
  const seed = /** @type {Record<string, unknown>} */ (raw);

  // Reject machine-path / free-text attempts before anything else.
  if (Object.prototype.hasOwnProperty.call(seed, "file_path")) {
    throw new Error(
      "slice seed must not be a machine file_path; use fact_id/edge_id/journey_id",
    );
  }
  if (Object.prototype.hasOwnProperty.call(seed, "path")) {
    throw new Error("slice seed must not be a machine path");
  }
  if (Object.prototype.hasOwnProperty.call(seed, "text")) {
    throw new Error("slice seed must not be free text");
  }

  const kind = seed.kind;
  if (typeof kind !== "string" || !SEED_KINDS.has(kind)) {
    throw new Error(
      `slice seed kind must be one of ${[...SEED_KINDS].join(", ")}`,
    );
  }

  if (kind === "l0_fact") return validateL0Fact(seed);
  if (kind === "l1_edge") return validateL1Edge(seed);
  return validateL2Journey(seed);
}

/**
 * @param {Record<string, unknown>} seed
 */
function validateL0Fact(seed) {
  const namespace = requireString(seed, "namespace");
  rejectCompanyLiteral(namespace);
  const logical_repo = requireString(seed, "logical_repo");
  const fact_id = requireString(seed, "fact_id");
  // Closed shape: no extra keys.
  assertClosedShape(seed, ["kind", "namespace", "logical_repo", "fact_id"]);
  return { kind: "l0_fact", namespace, logical_repo, fact_id };
}

/**
 * @param {Record<string, unknown>} seed
 */
function validateL1Edge(seed) {
  const system_namespace = requireString(seed, "system_namespace");
  rejectCompanyLiteral(system_namespace);
  const edge_id = requireString(seed, "edge_id");
  assertClosedShape(seed, ["kind", "system_namespace", "edge_id"]);
  return { kind: "l1_edge", system_namespace, edge_id };
}

/**
 * @param {Record<string, unknown>} seed
 */
function validateL2Journey(seed) {
  const system_namespace = requireString(seed, "system_namespace");
  rejectCompanyLiteral(system_namespace);
  const journey_id = requireString(seed, "journey_id");
  const bind_id = optionalString(seed, "bind_id");
  const allowed = ["kind", "system_namespace", "journey_id"];
  if (bind_id !== undefined) allowed.push("bind_id");
  assertClosedShape(seed, allowed);
  const out = {
    kind: "l2_journey",
    system_namespace,
    journey_id,
  };
  if (bind_id !== undefined) out.bind_id = bind_id;
  return out;
}

/**
 * @param {Record<string, unknown>} seed
 * @param {string} key
 * @returns {string}
 */
function requireString(seed, key) {
  const v = seed[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`slice seed field ${key} must be a non-empty string`);
  }
  return v;
}

/**
 * @param {Record<string, unknown>} seed
 * @param {string} key
 * @returns {string | undefined}
 */
function optionalString(seed, key) {
  if (!Object.prototype.hasOwnProperty.call(seed, key)) return undefined;
  const v = seed[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`slice seed field ${key} must be a non-empty string`);
  }
  return v;
}

/**
 * @param {string} namespace
 */
function rejectCompanyLiteral(namespace) {
  if (FORBIDDEN_NAMESPACE_LITERALS.has(namespace.toLowerCase())) {
    throw new Error(
      `namespace must be explicit; company literal default '${namespace}' is forbidden`,
    );
  }
}

/**
 * @param {Record<string, unknown>} seed
 * @param {string[]} allowedKeys
 */
function assertClosedShape(seed, allowedKeys) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(seed)) {
    if (!allowed.has(key)) {
      throw new Error(`slice seed has unknown field '${key}'`);
    }
  }
}

/**
 * Build the canonical sort tuple for a normalized seed.
 * Tuple: (kind, namespace|system_namespace, logical_repo|"", id)
 * where id is fact_id / edge_id / journey_id[|bind_id].
 *
 * @param {{kind:string} & Record<string, string>} s
 * @returns {[string, string, string, string]}
 */
function sortTuple(s) {
  const ns = s.namespace || s.system_namespace || "";
  const logicalRepo = s.logical_repo || "";
  let id;
  if (s.kind === "l0_fact") id = s.fact_id;
  else if (s.kind === "l1_edge") id = s.edge_id;
  else id = s.bind_id ? `${s.journey_id}|${s.bind_id}` : s.journey_id;
  return [s.kind, ns, logicalRepo, id];
}

/**
 * Validate, dedupe by full-key tuple and canonically order an array of seeds.
 * Returns a fresh array; input is not mutated.
 *
 * @param {unknown} rawSeeds
 * @returns {object[]}
 */
export function normalizeSeeds(rawSeeds) {
  if (rawSeeds == null) return [];
  if (!Array.isArray(rawSeeds)) {
    throw new Error("normalizeSeeds expects an array of seeds");
  }
  const seen = new Set();
  /** @type {object[]} */
  const out = [];
  for (const raw of rawSeeds) {
    const seed = validateSeed(raw);
    const key = JSON.stringify(sortTuple(/** @type {any} */ (seed)));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(seed);
  }
  out.sort((a, b) => compareTuples(sortTuple(/** @type {any} */ (a)), sortTuple(/** @type {any} */ (b))));
  return out;
}

/**
 * @param {string[]} x
 * @param {string[]} y
 */
function compareTuples(x, y) {
  for (let i = 0; i < x.length; i++) {
    const c = compareByCodeUnit(x[i], y[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * Deterministic sha256 (64-hex) of the canonical seed set.
 * Input MUST already be normalized (deduped + sorted).
 *
 * @param {object[]} normalizedSeeds
 * @returns {string}
 */
export function seedSetHash(normalizedSeeds) {
  const arr = Array.isArray(normalizedSeeds) ? normalizedSeeds : [];
  return sha256Text(stableStringify(arr));
}
