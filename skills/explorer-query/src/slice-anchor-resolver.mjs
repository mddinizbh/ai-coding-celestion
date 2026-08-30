/**
 * Slice anchor resolver — resolves Slice seeds (l0_fact / l1_edge / l2_journey)
 * to their L0 anchor record IDs using the `Map<fact_id, record_id[]>` produced
 * by `readAcceptedL0Snapshot` (Todo 7, slice-source-reader.mjs).
 *
 * Plan-locked rules (persistent-context-slice-engine-v2, Scope #5 + #6):
 *  - Anchor resolution is EXPLICIT map lookup ONLY (`frontierFacts.get(fact_id)`).
 *    NEVER match by file path, name similarity, or any heuristic.
 *  - Journey steps are visited IN ORDER (preserve gaps). Every gap becomes a
 *    `no_matching_edge` miss; no anchor is ever invented.
 *  - When a fact maps to multiple record_ids, ALL are visited in the canonical
 *    order already established by the map (Todo 7 sorted via raw code-unit
 *    compare); the resolver does NOT re-sort.
 *  - Misses are DATA (returned in `misses[]`), never thrown — only genuine
 *    infra failures (malformed input) throw. Miss reasons emitted here:
 *    `unresolved_fact_anchor` and `no_matching_edge` (closed enum, Scope #6).
 *  - L1 is cross-repo only (matcher.mjs:89-99). The resolver READS L1 edges; it
 *    never creates, validates, or reorders them.
 *
 * Input `scope` is the output of `computePolicyScope` (Todo 7) optionally
 * enriched by the orchestrator (Todo 13) with `step_edges` on l2Bindings
 * entries so journey steps can be iterated. The resolver consumes whatever the
 * scope carries; it does not fetch journey details itself.
 */

import { compareRaw } from "./slice-canonical.mjs";

/**
 * Resolve Slice seeds to L0 anchor record IDs.
 *
 * @param {{
 *   seeds: object[],
 *   frontierFacts: Map<string, string[]>,
 *   scope: { edges?: object[], l2Bindings?: object[] },
 * }} input
 * @returns {{
 *   anchors: { seed: object, step_id?: string, record_ids: string[], layer: "l0"|"l1"|"l2", status: "resolved"|"miss" }[],
 *   misses:  { seed: object, step_id?: string, reason: "unresolved_fact_anchor"|"no_matching_edge", detail: object }[],
 * }}
 */
export function resolveAnchors({ seeds, frontierFacts, scope }) {
  if (!frontierFacts || typeof frontierFacts.get !== "function") {
    throw new TypeError("frontierFacts must be a Map<fact_id, record_id[]>");
  }
  const sc = scope || {};
  const edgeById = new Map((sc.edges || []).map((e) => [e.edge_id, e]));
  const l2Bindings = sc.l2Bindings || [];

  const anchors = [];
  const misses = [];

  for (const seed of seeds) {
    if (seed.kind === "l0_fact") {
      resolveL0(seed, frontierFacts, anchors, misses);
    } else if (seed.kind === "l1_edge") {
      resolveL1(seed, frontierFacts, edgeById, anchors, misses);
    } else if (seed.kind === "l2_journey") {
      resolveL2(seed, frontierFacts, l2Bindings, edgeById, anchors, misses);
    }
  }
  return { anchors, misses };
}

/** l0_fact: direct map lookup by fact_id. */
function resolveL0(seed, frontierFacts, anchors, misses) {
  const recordIds = frontierFacts.get(seed.fact_id);
  if (recordIds !== undefined) {
    anchors.push({ seed, record_ids: [...recordIds], layer: "l0", status: "resolved" });
    return;
  }
  anchors.push({ seed, record_ids: [], layer: "l0", status: "miss" });
  misses.push({
    seed,
    reason: "unresolved_fact_anchor",
    detail: { fact_id: seed.fact_id },
  });
}

/** l1_edge: resolve both endpoints via the map; union in canonical order. */
function resolveL1(seed, frontierFacts, edgeById, anchors, misses) {
  const e = edgeById.get(seed.edge_id);
  if (!e) {
    anchors.push({ seed, record_ids: [], layer: "l1", status: "miss" });
    misses.push({ seed, reason: "no_matching_edge", detail: { edge_id: seed.edge_id } });
    return;
  }
  const fromIds = frontierFacts.get(e.from.fact_id);
  const toIds = frontierFacts.get(e.to.fact_id);
  if (fromIds === undefined || toIds === undefined) {
    anchors.push({ seed, record_ids: [], layer: "l1", status: "miss" });
    misses.push({
      seed,
      reason: "unresolved_fact_anchor",
      detail: {
        edge_id: seed.edge_id,
        fact_id: fromIds === undefined ? e.from.fact_id : e.to.fact_id,
      },
    });
    return;
  }
  anchors.push({ seed, record_ids: unionCanonical(fromIds, toIds), layer: "l1", status: "resolved" });
}

/**
 * l2_journey: find the bind in scope.l2Bindings, then iterate step_edges IN
 * ORDER. Each bound step contributes record_ids; each gap (or malformed
 * `__gap__` bound step, or edge not in scope) becomes a `no_matching_edge`
 * miss. Step order is preserved in the anchors array.
 */
function resolveL2(seed, frontierFacts, l2Bindings, edgeById, anchors, misses) {
  const bindEntry = l2Bindings.find(
    (b) => b.journey_id === seed.journey_id && (!seed.bind_id || b.bind_id === seed.bind_id),
  );
  if (!bindEntry) {
    // Journey's bind is not in scope — no edge to anchor to.
    anchors.push({ seed, record_ids: [], layer: "l2", status: "miss" });
    misses.push({
      seed,
      reason: "no_matching_edge",
      detail: { journey_id: seed.journey_id, ...(seed.bind_id ? { bind_id: seed.bind_id } : {}) },
    });
    return;
  }

  const steps = bindEntry.step_edges || [];
  for (const step of steps) {
    const isBound = step.step_status === "bound" && step.edge_id && step.edge_id !== "__gap__";
    if (!isBound) {
      anchors.push({ seed, step_id: step.step_id, record_ids: [], layer: "l2", status: "miss" });
      misses.push({
        seed,
        step_id: step.step_id,
        reason: "no_matching_edge",
        detail: { step_id: step.step_id },
      });
      continue;
    }
    resolveStep(seed, step, frontierFacts, edgeById, anchors, misses);
  }
}

/** Resolve a single bound journey step's edge endpoints. */
function resolveStep(seed, step, frontierFacts, edgeById, anchors, misses) {
  const e = edgeById.get(step.edge_id);
  if (!e) {
    anchors.push({ seed, step_id: step.step_id, record_ids: [], layer: "l2", status: "miss" });
    misses.push({
      seed,
      step_id: step.step_id,
      reason: "no_matching_edge",
      detail: { step_id: step.step_id, edge_id: step.edge_id },
    });
    return;
  }
  const fromIds = frontierFacts.get(e.from.fact_id);
  const toIds = frontierFacts.get(e.to.fact_id);
  if (fromIds === undefined || toIds === undefined) {
    anchors.push({ seed, step_id: step.step_id, record_ids: [], layer: "l2", status: "miss" });
    misses.push({
      seed,
      step_id: step.step_id,
      reason: "unresolved_fact_anchor",
      detail: {
        step_id: step.step_id,
        edge_id: step.edge_id,
        fact_id: fromIds === undefined ? e.from.fact_id : e.to.fact_id,
      },
    });
    return;
  }
  anchors.push({
    seed,
    step_id: step.step_id,
    record_ids: unionCanonical(fromIds, toIds),
    layer: "l2",
    status: "resolved",
  });
}

/**
 * Union two record_id arrays, deduplicated and sorted by raw code-unit compare
 * (the canonical order established by slice-canonical.mjs `compareRaw`). Each
 * input array is already canonically sorted by Todo 7; the dedup+sort here is
 * the cross-fact merge that keeps the combined set canonical.
 */
function unionCanonical(a, b) {
  const set = new Set([...a, ...b]);
  return [...set].sort(compareRaw);
}
