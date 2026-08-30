/**
 * Build a context pack: L2? → L1 hops → code pointers (from edge evidence).
 * Hermetic: operates on in-memory edges / journey bind result.
 *
 * ADR 0009 (id_version=2): every Pack carries a deterministic `pack_id` of
 * the form `pack:<64-hex>` derived from the canonical pack body EXCLUDING the
 * non-canonical `generated_at` envelope. Same pack body ⇒ same pack_id; a
 * layered identity version bump invalidates it via the upstream edge_ids.
 */

import { sha256Text, stableStringify } from "../../explorer-l0/src/stable-json.mjs";
import { ID_VERSION, makePackId } from "../../explorer-l0/src/layered-id.mjs";
import { compareRaw, sortById } from "./slice-canonical.mjs";
import { SliceMaterializationError } from "./slice-errors.mjs";
import { recordMetric } from "./slice-metrics.mjs";

/**
 * @param {{
 *   system_namespace: string,
 *   question?: string,
 *   journey?: object,
 *   edges: object[],
 *   projections?: object[],
 * }} input
 */
export function buildContextPack(input) {
  const edges = Array.isArray(input.edges) ? input.edges : [];
  /** @type {object[]} */
  let hops = [];

  if (input.journey && Array.isArray(input.journey.bound)) {
    for (const step of input.journey.bound) {
      if (step.status !== "bound") {
        hops.push({
          step_id: step.step_id,
          trigger: step.trigger,
          status: "gap",
          edges: [],
        });
        continue;
      }
      const stepEdges = (step.edges || []).map((se) => {
        const full = edges.find((e) => e.edge_id === se.edge_id) || se;
        return summarizeEdge(full);
      });
      hops.push({
        step_id: step.step_id,
        trigger: step.trigger,
        status: "ok",
        edges: stepEdges,
      });
    }
  } else {
    // no journey: all edges as unordered hops (filtered by question keywords lightly)
    let filtered = edges;
    const q = (input.question || "").toLowerCase();
    if (q) {
      const hits = edges.filter((e) =>
        JSON.stringify(e).toLowerCase().includes(q.split(/\s+/)[0] || q),
      );
      if (hits.length) filtered = hits;
    }
    hops = [
      {
        step_id: "all-edges",
        trigger: "http-sync",
        status: "ok",
        edges: filtered.map(summarizeEdge),
      },
    ];
  }

  const code_pointers = [];
  const seen = new Set();
  for (const h of hops) {
    for (const e of h.edges || []) {
      for (const p of e.code_pointers || []) {
        const k = `${p.repo}|${p.file}|${p.line}`;
        if (seen.has(k)) continue;
        seen.add(k);
        code_pointers.push(p);
      }
    }
  }

  // ADR 0009: deterministic pack_id derived from the canonical body (no
  // generated_at, no clock fields). Same body ⇒ same pack_id.
  const packBody = {
    id_version: ID_VERSION,
    version: 1,
    system_namespace: input.system_namespace,
    question: input.question || null,
    journey_id: input.journey?.journey_id || null,
    journey_status: input.journey?.status || null,
    hop_count: hops.length,
    hops,
    code_pointers,
    projections: input.projections || [],
  };
  const packHash = sha256Text(stableStringify(packBody));
  const pack_id = makePackId(packHash);

  return {
    pack_id,
    id_version: ID_VERSION,
    version: 1,
    system_namespace: input.system_namespace,
    question: input.question || null,
    journey_id: input.journey?.journey_id || null,
    journey_status: input.journey?.status || null,
    hop_count: hops.length,
    hops,
    code_pointers,
    projections: input.projections || [],
    generated_at: new Date().toISOString(),
  };
}

/**
 * @param {object} e
 */
function summarizeEdge(e) {
  const evidence = Array.isArray(e.evidence) ? e.evidence : [];
  const code_pointers = evidence.map((ev) => ({
    side: ev.side,
    repo: ev.side === "from" ? e.from?.logical_repo : e.to?.logical_repo,
    file: ev.file,
    line: ev.line,
    revision: ev.revision,
    snippet: ev.snippet,
  }));
  return {
    edge_id: e.edge_id,
    from: e.from?.logical_repo || e.from,
    to: e.to?.logical_repo || e.to,
    contract_key: e.contract_key,
    match_kind: e.match_kind,
    score: e.score,
    config_key: e.config_key,
    code_pointers,
  };
}

// =============================================================================
// Context Pack v2 — deterministic, budgeted projection of a complete Slice.
//
// Plan-locked rules (persistent-context-slice-engine-v2, Scope #7 + Todo 14):
//   - Input: a COMPLETE canonical Slice + {max_nodes, max_edges, max_chars}.
//     Budgets apply ONLY here, never at traversal/materializer (Locked #6).
//   - v1 uses max_chars as a deterministic estimator; it makes NO model
//     tokenization promise.
//   - Selection order: mandatory seed nodes first, then ascending distance
//     from seed, then descending score (secondary), then ID ascending
//     (final tiebreak, raw code-unit compare — never localeCompare, never
//     score as the primary/canonical key).
//   - Edges only enter when BOTH endpoints are selected.
//   - Output always carries slice_hash, derivation_summary, seeds, requested/
//     used budget, coverage_summary, truncated. Same Slice + same budget =>
//     byte-identical canonical Pack (clock-free).
//   - generated_at lives ONLY in a non-hashed CLI envelope, never inside the
//     canonical Pack. The legacy buildContextPack above keeps its own envelope.
//   - A budget unable to contain the mandatory seeds is a typed semantic
//     error (SliceMaterializationError, exit 2) — never a silently invalid
//     Pack. Malformed budgets are caller bugs (TypeError, exit 1).
// =============================================================================

const HASH64 = /^[a-f0-9]{64}$/;

/**
 * Validate a single budget field: must be a non-negative integer.
 * @param {unknown} v
 * @param {string} name
 * @returns {number}
 */
function validateBudgetField(v, name) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new TypeError(`budget.${name} must be a non-negative integer`);
  }
  return v;
}

/**
 * Deterministic char-cost estimator: length of the stable-stringified item.
 * Order-independent (stableStringify sorts keys). No model tokenization.
 * @param {unknown} item
 * @returns {number}
 */
function charCost(item) {
  return stableStringify(item).length;
}

/**
 * Seed sort key mirroring slice-canonical's private seedKey tuple so the Pack
 * seeds array is byte-stable regardless of input order.
 * @param {Record<string, unknown>} s
 * @returns {string}
 */
function packSeedKey(s) {
  const ns = s.system_namespace ?? s.namespace ?? "";
  const repo = s.logical_repo ?? "";
  const id = s.fact_id ?? s.edge_id ?? s.journey_id ?? s.id ?? "";
  return [s.kind ?? "", ns, repo, id, s.bind_id ?? ""].join("\u0000");
}

/**
 * BFS distance from seed node IDs over Slice edges (undirected, min hops).
 * Unreachable nodes get distance Infinity. Deterministic regardless of edge
 * order (neighbors visited in raw-ID order).
 *
 * @param {object[]} nodes
 * @param {object[]} edges
 * @param {Set<string>} seedIds
 * @returns {Map<string, number>}
 */
function computeDistances(nodes, edges, seedIds) {
  /** @type {Map<string, string[]>} */
  const adj = new Map();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  }
  for (const list of adj.values()) list.sort(compareRaw);
  const dist = new Map();
  const queue = [];
  for (const id of [...seedIds].sort(compareRaw)) {
    if (!dist.has(id)) {
      dist.set(id, 0);
      queue.push(id);
    }
  }
  while (queue.length) {
    const cur = queue.shift();
    const d = dist.get(cur);
    for (const nb of adj.get(cur) || []) {
      if (!dist.has(nb)) {
        dist.set(nb, d + 1);
        queue.push(nb);
      }
    }
  }
  return dist;
}

/**
 * Rank nodes: seeds first (mandatory), then ascending distance, descending
 * score (v1 nodes are scoreless => 0), then ascending ID (raw compare).
 * @param {object[]} nodes
 * @param {Set<string>} seedIds
 * @param {Map<string, number>} dist
 * @returns {object[]}
 */
function rankNodes(nodes, seedIds, dist) {
  return [...nodes].sort((a, b) => {
    const aSeed = seedIds.has(a.id);
    const bSeed = seedIds.has(b.id);
    if (aSeed !== bSeed) return aSeed ? -1 : 1;
    const da = dist.get(a.id) ?? Infinity;
    const db = dist.get(b.id) ?? Infinity;
    if (da !== db) return da < db ? -1 : 1;
    const sa = typeof a.score === "number" ? a.score : 0;
    const sb = typeof b.score === "number" ? b.score : 0;
    if (sa !== sb) return sa > sb ? -1 : 1;
    return compareRaw(a.id, b.id);
  });
}

/**
 * Project a complete canonical Slice into a budgeted Context Pack.
 *
 * @param {{
 *   slice: {
 *     nodes?: object[],
 *     edges?: object[],
 *     misses?: object[],
 *     seeds?: object[],
 *     system_namespace: string,
 *     engine_version: string,
 *     schema_version: number,
 *     policy: { name: string, version: number|string, options_hash: string },
 *   },
 *   sliceHash: string,
 *   derivationKey: string,
 *   budget: { max_nodes: number, max_edges: number, max_chars: number },
 * }} input
 * @returns {{
 *   pack_id: string, slice_hash: string, derivation_summary: object,
 *   seeds: object[], budget: { requested: number, used: number },
 *   coverage_summary: { nodes: number, edges: number, misses: number },
 *   truncated: boolean,
 * }}
 */
export function projectContextPack(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("projectContextPack requires an input object");
  }
  const { slice, sliceHash, derivationKey, budget } = input;
  if (!slice || typeof slice !== "object") throw new TypeError("slice required");
  if (typeof sliceHash !== "string" || !HASH64.test(sliceHash)) {
    throw new TypeError("sliceHash must be 64-char lowercase hex SHA-256");
  }
  if (typeof derivationKey !== "string" || !HASH64.test(derivationKey)) {
    throw new TypeError("derivationKey must be 64-char lowercase hex SHA-256");
  }
  if (!budget || typeof budget !== "object") {
    throw new TypeError("budget {max_nodes,max_edges,max_chars} required");
  }
  const maxNodes = validateBudgetField(budget.max_nodes, "max_nodes");
  const maxEdges = validateBudgetField(budget.max_edges, "max_edges");
  const maxChars = validateBudgetField(budget.max_chars, "max_chars");

  const nodes = Array.isArray(slice.nodes) ? slice.nodes : [];
  const edges = Array.isArray(slice.edges) ? slice.edges : [];
  const misses = Array.isArray(slice.misses) ? slice.misses : [];
  const seedsIn = Array.isArray(slice.seeds) ? slice.seeds : [];
  if (seedsIn.length === 0) {
    throw new SliceMaterializationError("slice must carry at least one seed");
  }

  // Mandatory seed nodes: l0_fact seeds whose record_id is present in nodes.
  const nodeIds = new Set(nodes.map((n) => n.id));
  const seedNodeIds = new Set();
  for (const s of seedsIn) {
    if (s && s.kind === "l0_fact" && nodeIds.has(s.record_id)) {
      seedNodeIds.add(s.record_id);
    }
  }
  const dist = computeDistances(nodes, edges, seedNodeIds);
  const ranked = rankNodes(nodes, seedNodeIds, dist);

  // --- Mandatory seeds must fit, else typed semantic error (not invalid Pack).
  if (seedNodeIds.size > maxNodes) {
    throw new SliceMaterializationError(
      "budget max_nodes cannot contain mandatory seed nodes",
      { code: "BUDGET_BELOW_SEEDS" },
    );
  }
  let seedChars = 0;
  for (const id of seedNodeIds) {
    const n = nodes.find((x) => x.id === id);
    if (n) seedChars += charCost(n);
  }
  if (seedChars > maxChars) {
    throw new SliceMaterializationError(
      "budget max_chars cannot contain mandatory seed nodes",
      { code: "BUDGET_BELOW_SEEDS" },
    );
  }

  // --- Select nodes: seeds first (mandatory), then ranked non-seeds.
  /** @type {Set<string>} */
  const selectedNodes = new Set();
  let usedChars = 0;
  let truncated = false;
  for (const n of ranked) {
    if (seedNodeIds.has(n.id)) {
      selectedNodes.add(n.id);
      usedChars += charCost(n);
    }
  }
  for (const n of ranked) {
    if (selectedNodes.has(n.id)) continue;
    if (selectedNodes.size >= maxNodes) {
      truncated = true;
      break;
    }
    const cost = charCost(n);
    if (usedChars + cost > maxChars) {
      truncated = true;
      break;
    }
    selectedNodes.add(n.id);
    usedChars += cost;
  }

  // --- Edges enter only when both endpoints are selected (id-ascending order).
  const eligibleEdges = edges
    .filter((e) => selectedNodes.has(e.from) && selectedNodes.has(e.to))
    .sort((a, b) =>
      compareRaw(`${a.from}->${a.to}`, `${b.from}->${b.to}`),
    );
  let selectedEdges = 0;
  for (const e of eligibleEdges) {
    if (selectedEdges >= maxEdges) {
      truncated = true;
      break;
    }
    const cost = charCost(e);
    if (usedChars + cost > maxChars) {
      truncated = true;
      break;
    }
    selectedEdges += 1;
    usedChars += cost;
  }
  if (selectedEdges < eligibleEdges.length) truncated = true;
  if (selectedNodes.size < nodes.length) truncated = true;

  const derivationSummary = {
    derivation_key: derivationKey,
    engine_version: slice.engine_version,
    slice_schema_version: slice.schema_version,
    system_namespace: slice.system_namespace,
    // Project policy to schema-compliant types (context-pack.schema.json
    // pins version as a nonEmptyString; the materializer emits a number).
    // The descriptor is a summary, not the re-keyed struct, so this coercion
    // never alters the already-computed derivation_key.
    policy: {
      name: String(slice.policy?.name),
      version: String(slice.policy?.version),
      options_hash: String(slice.policy?.options_hash),
    },
  };
  const seeds = sortById(seedsIn, packSeedKey);

  const body = {
    slice_hash: sliceHash,
    derivation_summary: derivationSummary,
    seeds,
    budget: { requested: maxChars, used: usedChars },
    coverage_summary: {
      nodes: selectedNodes.size,
      edges: selectedEdges,
      misses: misses.length,
    },
    truncated,
  };
  const pack_id = makePackId(sha256Text(stableStringify(body)));
  recordMetric(input.metrics, "pack_truncated", truncated ? 1 : 0);
  return { pack_id, ...body };
}
