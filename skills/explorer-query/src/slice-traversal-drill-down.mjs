/**
 * slice-traversal-drill-down.mjs — drill-down@1 adapter for the persistent
 * Context Slice engine.
 *
 * Plan-locked rules (persistent-context-slice-engine-v2, Scope #5 + Todo 11):
 *  - drill-down@1: forward EXPOSES and CALLS only; max_hops=2 by default.
 *  - max_hops is an EXPLICIT policy option: it enters options_hash (via
 *    slice-policies.normalizeOptions/optionsHash) and therefore the derivation
 *    key. A different max_hops produces a different Slice identity.
 *  - A frontier reached at the hop limit becomes a `policy_boundary` miss —
 *    NEVER silent truncation. hop 3 with max_hops=2 is out; max_hops=3
 *    includes it and yields different output.
 *  - Pack budgets are NEVER used to stop traversal: the adapter takes no
 *    budget argument; max_hops is the only traversal stop condition.
 *  - Off-allowlist relations encountered going forward are also surfaced as
 *    `policy_boundary` misses (consistent with journey@1). Unknown and reverse
 *    relations never enter and are never reinterpreted.
 *  - Visited-set by stable record ID: each node is visited once. Cyclic
 *    graphs terminate.
 *  - Canonical ordering uses raw code-unit compare; never localeCompare, never
 *    score. The adjacency list is sorted by to_record so traversal order is
 *    deterministic regardless of relation array order.
 *  - Distance per node is tracked as a sibling `distances` map
 *    (Record<record_id, hop>), mirroring impact@1's `classification` sibling.
 *    The node object itself stays closed-shape per context-slice.schema.json
 *    (no `distance` field on the node — that would require a schema bump).
 *
 * Reuses `mapAnchorMiss` from slice-traversal.mjs (Todo 9) so anchor misses
 * (unresolved_fact_anchor, no_matching_edge) project identically across all
 * three adapters. Reuses `compareRaw` from slice-canonical.mjs (Todo 2).
 *
 * Module stays under 250 pure LOC (plan MUST DO). The hop-limited BFS lives
 * here rather than in slice-traversal.mjs to keep that module under the
 * ceiling after journey (Todo 9) and impact (Todo 10) already landed.
 */

import { compareRaw } from "./slice-canonical.mjs";
import { mapAnchorMiss } from "./slice-traversal.mjs";

/**
 * Materialize a drill-down@1 Slice subgraph:
 * `{ nodes, edges, misses, distances }`.
 *
 * Hop semantics: seed record IDs are hop 0. Each followed allowlist relation
 * increments the hop by 1. A neighbor reached at hop `h+1 > max_hops` is NOT
 * visited and generates exactly one `policy_boundary` miss (deduped by target
 * ID). L1 edges in scope are emitted as cross_service edges (seed anchors),
 * matching the journey adapter; they do not participate in hop counting.
 *
 * @param {{
 *   anchors: {status:string, record_ids:string[]}[],
 *   anchorMisses: {reason:string, step_id?:string, detail?:object}[],
 *   relations: Array<{id:string, from_record:string, relation_type:string, to_record:string}>,
 *   records: {id:string, name?:string, status?:string}[],
 *   l1Edges: {from:{fact_id:string}, to:{fact_id:string}}[],
 *   policy: {allowlist?:string[], max_hops?:number, default_options?:{max_hops?:number}},
 * }} input
 * @returns {{nodes:object[], edges:object[], misses:object[], distances:Record<string,number>}}
 */
export function materializeDrillDownSlice({
  anchors, anchorMisses, relations, records, l1Edges, policy,
}) {
  const allowlist = new Set(policy?.allowlist || ["EXPOSES", "CALLS"]);
  const maxHops = policy?.max_hops ?? policy?.default_options?.max_hops ?? 2;
  if (!Number.isInteger(maxHops) || maxHops <= 0) {
    throw new Error("drill-down policy requires max_hops to be a positive integer");
  }
  const recordById = new Map((records || []).map((r) => [r.id, r]));

  // Forward adjacency: from_record -> [relation], sorted by to_record.
  const adjacency = new Map();
  for (const r of relations || []) {
    if (typeof r.from_record !== "string") continue;
    if (!adjacency.has(r.from_record)) adjacency.set(r.from_record, []);
    adjacency.get(r.from_record).push(r);
  }
  for (const list of adjacency.values()) {
    list.sort((a, b) => compareRaw(a.to_record ?? "", b.to_record ?? ""));
  }

  // Seed record IDs from resolved anchors (dedup, preserve anchor order).
  const seedRecordIds = [];
  const seenSeed = new Set();
  for (const a of anchors || []) {
    if (a?.status !== "resolved") continue;
    for (const rid of a.record_ids || []) {
      if (typeof rid === "string" && !seenSeed.has(rid)) {
        seenSeed.add(rid);
        seedRecordIds.push(rid);
      }
    }
  }

  // Hop-limited BFS.
  const visited = new Set();
  /** @type {Record<string, number>} */
  const distances = {};
  const followedRelations = new Map();
  const boundaries = [];
  const boundarySeen = new Set();
  /** @type {{id:string, hop:number}[]} */
  const queue = [];

  for (const id of seedRecordIds) {
    visited.add(id);
    distances[id] = 0;
    queue.push({ id, hop: 0 });
  }

  while (queue.length > 0) {
    const { id: current, hop } = queue.shift();
    const neighbors = adjacency.get(current);
    if (!neighbors) continue;
    for (const r of neighbors) {
      const type = r.relation_type;
      const to = r.to_record;
      if (typeof type !== "string" || typeof to !== "string") continue;

      if (!allowlist.has(type)) {
        // Off-allowlist forward relation — policy_boundary (deduped by target).
        if (visited.has(to) || boundarySeen.has(to)) continue;
        boundarySeen.add(to);
        boundaries.push({
          record_id: current, relation_type: type, blocked_id: to,
          detail: `relation '${type}' at ${current} is outside the drill-down allowlist`,
        });
        continue;
      }

      followedRelations.set(r.id, r);
      if (visited.has(to)) continue;
      if (hop + 1 <= maxHops) {
        visited.add(to);
        distances[to] = hop + 1;
        queue.push({ id: to, hop: hop + 1 });
      } else if (!boundarySeen.has(to)) {
        // Hop limit reached — policy_boundary, never silent truncation.
        boundarySeen.add(to);
        boundaries.push({
          record_id: current, relation_type: type, blocked_id: to,
          detail: `hop ${hop + 1} beyond max_hops=${maxHops} from ${current} via ${type}`,
        });
      }
    }
  }

  const nodeIds = [...visited].sort(compareRaw);
  const nodes = nodeIds.map((id) => {
    const rec = recordById.get(id);
    return {
      kind: "node",
      id,
      label: rec?.name || id,
      layer: "l0",
      status: rec?.status || "hipótese",
    };
  });

  const followedSorted = [...followedRelations.values()].sort((a, b) =>
    compareRaw(a.id ?? "", b.id ?? ""),
  );
  const edges = [
    ...followedSorted.map((r) => ({
      kind: "edge",
      from: r.from_record,
      to: r.to_record,
      relation_type: r.relation_type,
      layer: "l0",
      status: r.status || "hipótese",
    })),
    ...(l1Edges || []).map((e) => ({
      kind: "edge",
      from: e.from.fact_id,
      to: e.to.fact_id,
      relation_type: "cross_service",
      layer: "l1",
      status: "hipótese",
    })),
  ];

  // Distances sibling map built in canonical (sorted) key order so two runs
  // produce byte-identical output regardless of BFS visitation order.
  /** @type {Record<string, number>} */
  const distancesSorted = {};
  for (const id of nodeIds) distancesSorted[id] = distances[id];

  const misses = [
    ...(anchorMisses || []).map((m) => mapAnchorMiss(m)),
    ...boundaries.map((b) => ({
      kind: "miss",
      miss_reason: "policy_boundary",
      target_id: b.blocked_id,
      detail: b.detail,
    })),
  ];

  return { nodes, edges, misses, distances: distancesSorted };
}
