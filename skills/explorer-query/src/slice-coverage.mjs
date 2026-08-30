/**
 * slice-coverage.mjs — Coverage aggregation for a materialized Context Slice.
 *
 * Plan-locked rules (persistent-context-slice-engine-v2, Scope #6 + #11):
 *  - Factual status enum `comprovado|hipótese|contradição|stale` is IMMUTABLE
 *    per indexed record. `counts.by_status` reflects the ORIGINAL factual
 *    statuses passed via `factualStatuses` — traversal may mutate a node's
 *    status (e.g. resolve a hipótese), but the count never promotes hipótese
 *    to comprovado. When `factualStatuses` is undefined/null the count falls
 *    back to node+edge statuses; an explicit empty array yields zero counts.
 *  - miss_reason enum is closed: `no_matching_edge|no_accepted_l0|
 *    unresolved_fact_anchor|unresolved_dispatch|policy_boundary|index_missing`.
 *  - `complete_relative_to_index` is TRUE iff the indexed graph fully backs
 *    the slice. `no_matching_edge` and `policy_boundary` are graph/policy
 *    facts — the slice is still complete relative to the index. `index_missing`,
 *    `unresolved_fact_anchor`, `unresolved_dispatch`, `no_accepted_l0`,
 *    missing baselines and safety ceiling breaches flip it to false.
 *  - `dispatch_uncertainty` reports edges that explicitly declare dynamic
 *    dispatch (`edge.dispatch === "dynamic"`) but were still traversed — it
 *    is a fact about the indexed graph, NOT a miss. The `unresolved_dispatch`
 *    miss is emitted only when dispatch CANNOT be resolved at all. The two
 *    are mutually exclusive per edge.
 *  - Missing baseline is never masked: Todo 7's readAcceptedL0Snapshot
 *    blocks earlier via SliceMaterializationError, but if a scope with an
 *    uncovered repo reaches here we emit `missing_baselines:[repo]` and
 *    force complete=false.
 *  - Provenance carries L0 baselines, the L1 edge-set hash and L2 bindings
 *    WITHOUT timestamps — only stable IDs and hashes.
 *  - Canonical sort uses raw code-unit compare (`a < b ? -1 : a > b ? 1 : 0`);
 *    never localeCompare, never score.
 *
 * The module consumes outputs only — it never reads L0/L1/L2 stores or the
 * working tree. Errors are typed (`TypeError` for malformed caller input).
 */

import { compareRaw } from "./slice-canonical.mjs";

/** Closed enum of layer tags (relation.schema.json layerTag). */
const LAYERS = ["l0", "l1", "l2"];
/** Closed factual status enum (relation.schema.json sourceStatus). */
const STATUSES = ["comprovado", "hipótese", "contradição", "stale"];
/** Closed miss-reason enum (context-slice.schema.json missReason). */
const MISS_REASONS = [
  "no_matching_edge",
  "no_accepted_l0",
  "unresolved_fact_anchor",
  "unresolved_dispatch",
  "policy_boundary",
  "index_missing",
];

/** Reasons that signal an INDEX gap (not a graph/policy fact). */
const INDEX_GAP_REASONS = new Set([
  "index_missing",
  "unresolved_fact_anchor",
  "unresolved_dispatch",
  "no_accepted_l0",
]);

const zeroByLayer = () => ({ l0: 0, l1: 0, l2: 0 });
const zeroByStatus = () => ({ comprovado: 0, "hipótese": 0, contradição: 0, stale: 0 });
const zeroByReason = () => Object.fromEntries(MISS_REASONS.map((r) => [r, 0]));

/**
 * Compute the coverage object for a materialized Context Slice.
 *
 * @param {{
 *   nodes?: Array<{layer:string, status?:string}>,
 *   edges?: Array<{layer:string, status?:string, dispatch?:string, from?:string, to?:string, relation_type?:string}>,
 *   misses?: Array<{miss_reason:string}>,
 *   policy?: { safety_ceilings?: { max_nodes?: number, max_edges?: number } },
 *   scope?: {
 *     repoSet?: Set<string>|string[],
 *     l0_baselines?: Array<{namespace:string, logical_repo:string, candidate_id:string, source_revision:string, canonical_graph_hash:string}>,
 *     l1_edge_set_hash?: string,
 *     l2_bindings?: Array<{journey_id:string, bind_id?:string, journey_hash:string}>,
 *   },
 *   factualStatuses?: Array<{id:string,status:string}|string> | Map<string,string> | Record<string,string>,
 * }} input
 * @returns {{
 *   counts: { nodes:number, edges:number, misses:number, by_layer:Record<string,number>, by_status:Record<string,number>, by_reason:Record<string,number> },
 *   complete_relative_to_index: boolean,
 *   dispatch_uncertainty: { count:number, edges:Array<{from:string,to:string,relation_type:string,layer:string}> } | null,
 *   policy_boundary_count: number,
 *   missing_baselines: string[],
 *   provenance: { l0_baselines: object[], l1_edge_set_hash: string, l2_bindings: object[] },
 * }}
 */
export function computeCoverage({ nodes, edges, misses, policy, scope, factualStatuses } = {}) {
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const edgeList = Array.isArray(edges) ? edges : [];
  const missList = Array.isArray(misses) ? misses : [];

  const by_layer = zeroByLayer();
  for (const n of nodeList) {
    if (n && layerOf(n.layer) !== null) by_layer[n.layer]++;
  }

  const by_status = zeroByStatus();
  const statusSource = normalizeStatuses(factualStatuses);
  if (statusSource !== null) {
    for (const s of statusSource) {
      if (STATUSES.includes(s)) by_status[s]++;
    }
  } else {
    // Fallback: no factual map supplied — aggregate from slice nodes+edges.
    // Traversal may have mutated a node's status; this is the only path
    // where the count reflects slice-level state instead of indexed truth.
    for (const n of nodeList) {
      const s = n && typeof n.status === "string" ? n.status : null;
      if (s && STATUSES.includes(s)) by_status[s]++;
    }
    for (const e of edgeList) {
      const s = e && typeof e.status === "string" ? e.status : null;
      if (s && STATUSES.includes(s)) by_status[s]++;
    }
  }

  const by_reason = zeroByReason();
  let policy_boundary_count = 0;
  for (const m of missList) {
    const r = m && typeof m.miss_reason === "string" ? m.miss_reason : null;
    if (!r || !MISS_REASONS.includes(r)) continue;
    by_reason[r]++;
    if (r === "policy_boundary") policy_boundary_count++;
  }

  const dispatch_uncertainty = collectDispatchUncertainty(edgeList);
  const missing_baselines = computeMissingBaselines(scope);
  const safetyFailure = exceedsSafetyCeiling(nodeList.length, edgeList.length, policy);

  const hasIndexGap = missList.some((m) => {
    const r = m && typeof m.miss_reason === "string" ? m.miss_reason : null;
    return r !== null && INDEX_GAP_REASONS.has(r);
  });
  const complete_relative_to_index =
    !hasIndexGap && missing_baselines.length === 0 && !safetyFailure;

  return {
    counts: {
      nodes: nodeList.length,
      edges: edgeList.length,
      misses: missList.length,
      by_layer,
      by_status,
      by_reason,
    },
    complete_relative_to_index,
    dispatch_uncertainty,
    policy_boundary_count,
    missing_baselines,
    provenance: buildProvenance(scope),
  };
}

/**
 * Coerce a layer tag to the closed enum or null.
 * @param {unknown} layer
 * @returns {"l0"|"l1"|"l2"|null}
 */
function layerOf(layer) {
  return typeof layer === "string" && LAYERS.includes(layer) ? layer : null;
}

/**
 * Normalize factualStatuses into a flat array of status strings.
 * Returns `null` to signal "no input → fall back to node+edge statuses".
 * An explicit empty array returns `[]` (zero records → zero counts, NOT a
 * fallback). Unknown status strings are dropped silently here; they are
 * filtered again at the count site (defensive, not silent — they would skew
 * the closed enum).
 *
 * @param {unknown} factualStatuses
 * @returns {string[] | null}
 */
function normalizeStatuses(factualStatuses) {
  if (factualStatuses === undefined || factualStatuses === null) return null;
  if (Array.isArray(factualStatuses)) {
    const out = [];
    for (const item of factualStatuses) {
      if (typeof item === "string") out.push(item);
      else if (item && typeof item === "object" && typeof item.status === "string") {
        out.push(item.status);
      }
    }
    return out;
  }
  if (factualStatuses instanceof Map) {
    const out = [];
    for (const s of factualStatuses.values()) {
      if (typeof s === "string") out.push(s);
    }
    return out;
  }
  if (typeof factualStatuses === "object") {
    const out = [];
    for (const v of Object.values(factualStatuses)) {
      if (typeof v === "string") out.push(v);
    }
    return out;
  }
  return null;
}

/**
 * Collect edges that explicitly declare dynamic dispatch. Listed edges are a
 * fact about the indexed graph; they are NOT misses (traversal succeeded).
 * Identity fields only — never timestamps.
 *
 * @param {object[]} edgeList
 */
function collectDispatchUncertainty(edgeList) {
  const collected = [];
  for (const e of edgeList) {
    if (e && e.dispatch === "dynamic") {
      collected.push({
        from: e.from,
        to: e.to,
        relation_type: e.relation_type,
        layer: e.layer,
      });
    }
  }
  return collected.length > 0 ? { count: collected.length, edges: collected } : null;
}

/**
 * Defensive: any repo in scope.repoSet without an accepted baseline is
 * surfaced explicitly. Todo 7 blocks earlier via SliceMaterializationError;
 * if a scope reaches here uncovered we never mask it.
 *
 * @param {object|undefined} scope
 * @returns {string[]}
 */
function computeMissingBaselines(scope) {
  if (!scope) return [];
  const repoSet = scope.repoSet;
  const baselines = scope.l0_baselines;
  if (!repoSet || !Array.isArray(baselines)) return [];
  const accepted = new Set(
    baselines
      .map((b) => (b && typeof b.logical_repo === "string") ? b.logical_repo : "")
      .filter(Boolean),
  );
  const missingSet = new Set();
  for (const repo of iterateRepos(repoSet)) {
    if (typeof repo === "string" && repo !== "" && !accepted.has(repo)) missingSet.add(repo);
  }
  return [...missingSet].sort(compareRaw);
}

/** Coerce a repo set to an iterable list of values. */
function iterateRepos(coll) {
  if (!coll) return [];
  if (Array.isArray(coll)) return coll;
  if (coll instanceof Set) return [...coll];
  if (typeof coll[Symbol.iterator] === "function") return [...coll];
  return [];
}

/**
 * @param {number} nodeCount
 * @param {number} edgeCount
 * @param {object|undefined} policy
 */
function exceedsSafetyCeiling(nodeCount, edgeCount, policy) {
  const ceilings = policy && typeof policy === "object" ? policy.safety_ceilings : undefined;
  if (!ceilings) return false;
  if (typeof ceilings.max_nodes === "number" && nodeCount > ceilings.max_nodes) return true;
  if (typeof ceilings.max_edges === "number" && edgeCount > ceilings.max_edges) return true;
  return false;
}

/**
 * Project scope to the provenance summary. Identity fields only — never
 * timestamps or raw payloads.
 *
 * @param {object|undefined} scope
 */
function buildProvenance(scope) {
  if (!scope) {
    return { l0_baselines: [], l1_edge_set_hash: "", l2_bindings: [] };
  }
  const baselines = Array.isArray(scope.l0_baselines)
    ? scope.l0_baselines.map((b) => ({
        namespace: b?.namespace,
        logical_repo: b?.logical_repo,
        candidate_id: b?.candidate_id,
        source_revision: b?.source_revision,
        canonical_graph_hash: b?.canonical_graph_hash,
      }))
    : [];
  return {
    l0_baselines: baselines,
    l1_edge_set_hash:
      typeof scope.l1_edge_set_hash === "string" ? scope.l1_edge_set_hash : "",
    l2_bindings: Array.isArray(scope.l2_bindings)
      ? scope.l2_bindings.map((b) => ({
          journey_id: b?.journey_id,
          bind_id: b?.bind_id,
          journey_hash: b?.journey_hash,
        }))
      : [],
  };
}
