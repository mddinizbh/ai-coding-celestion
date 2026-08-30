/**
 * slice-traversal.mjs — reusable ordered forward traversal core + journey@1
 * adapter for the persistent Context Slice engine.
 *
 * Plan-locked rules (persistent-context-slice-engine-v2, Scope #5):
 *  - journey@1: starts from the ordered L2 bound steps, includes each linked
 *    L1 edge, resolves both fact_ids to L0 via the origins map / anchor
 *    resolver, then traverses ONLY forward L0 relations whose type is in the
 *    policy allowlist (default CALLS, EXPOSES).
 *  - Visited-set by stable record ID: each node is visited exactly once.
 *    Cyclic graphs terminate.
 *  - Direction is strictly forward (from_record -> to_record). Reverse
 *    traversal and unknown relation types NEVER enter.
 *  - Relations whose type is outside the allowlist (encountered going forward
 *    from a visited node) produce a `policy_boundary` miss — NEVER silent
 *    truncation. This distinguishes a policy boundary from a graph end.
 *  - Canonical ordering uses raw code-unit compare; never localeCompare, never
 *    score. The adjacency list is sorted by to_record so traversal order is
 *    deterministic regardless of relation array order.
 *  - Journey gaps (step_status !== "bound") are preserved as
 *    `no_matching_edge` misses emitted by the anchor resolver; the adapter
 *    forwards them without alteration.
 *
 * The core `traverseForward` is reusable: impact@1 (Todo 10) will call it for
 * the forward leg and add a reverse leg; drill-down@1 (Todo 11) will wrap it
 * with a hop counter. The mechanics (visited set, ordered BFS, boundary
 * detection) are the shared foundation.
 */

import { compareRaw } from "./slice-canonical.mjs";

/**
 * Ordered forward traversal over L0 relations.
 *
 * Builds a forward adjacency index (from_record -> [relations]), sorts each
 * node's neighbors by to_record (raw code-unit compare), then runs a BFS
 * seeded by `seedRecordIds`. Each node is visited once (visited-set by stable
 * ID). Relations whose type is in the allowlist are followed; off-allowlist
 * forward relations become boundary entries. Unknown types and reverse edges
 * never enter. Cyclic graphs terminate because the visited set prevents
 * re-enqueueing.
 *
 * @param {{
 *   seedRecordIds: string[],
 *   relations: Array<{id:string, from_record:string, relation_type:string, to_record:string}>,
 *   allowlist: Set<string>,
 * }} input
 * @returns {{
 *   visitedIds: string[],
 *   followedRelations: object[],
 *   boundaries: {record_id:string, relation_id:string, relation_type:string, blocked_id:string}[],
 * }}
 */
export function traverseForward({ seedRecordIds, relations, allowlist }) {
  if (!Array.isArray(seedRecordIds) || !Array.isArray(relations)) {
    throw new TypeError("traverseForward requires { seedRecordIds, relations, allowlist }");
  }
  if (!(allowlist instanceof Set)) {
    throw new TypeError("allowlist must be a Set<string> of relation types");
  }

  // Forward adjacency: from_record -> [relation, ...].
  const adjacency = new Map();
  for (const r of relations) {
    const from = r?.from_record;
    if (typeof from !== "string") continue;
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from).push(r);
  }
  // Deterministic neighbor order: sort by to_record (raw code-unit compare).
  for (const list of adjacency.values()) {
    list.sort((a, b) => compareRaw(a.to_record ?? "", b.to_record ?? ""));
  }

  const visited = new Set();
  const visitedIds = [];
  const followedRelations = [];
  const boundaries = [];
  const queue = [];

  // Seed the queue (dedup, preserve input order).
  for (const id of seedRecordIds) {
    if (typeof id === "string" && !visited.has(id)) {
      visited.add(id);
      visitedIds.push(id);
      queue.push(id);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const neighbors = adjacency.get(current);
    if (!neighbors) continue;
    for (const r of neighbors) {
      const type = r.relation_type;
      const to = r.to_record;
      if (typeof type !== "string" || typeof to !== "string") continue;
      if (allowlist.has(type)) {
        followedRelations.push(r);
        if (!visited.has(to)) {
          visited.add(to);
          visitedIds.push(to);
          queue.push(to);
        }
      } else {
        boundaries.push({
          record_id: current,
          relation_id: r.id,
          relation_type: type,
          blocked_id: to,
        });
      }
    }
  }

  return { visitedIds, followedRelations, boundaries };
}

/**
 * Materialize a journey@1 Slice subgraph: { nodes, edges, misses }.
 *
 * Starts from the resolved anchor record IDs (produced by the anchor resolver,
 * Todo 8), includes each linked L1 edge as a cross-service edge, and traverses
 * forward L0 relations in the policy allowlist. Journey gaps and unresolved
 * anchors from the anchor resolver are forwarded as misses. Policy boundaries
 * from the traversal core are appended as `policy_boundary` misses.
 *
 * Output conforms to the context-slice.schema.json node/edge/miss shapes.
 *
 * @param {{
 *   anchors: {status:string, record_ids:string[]}[],
 *   anchorMisses: {reason:string, step_id?:string, detail?:object}[],
 *   relations: object[],
 *   records: {id:string, name?:string, status?:string}[],
 *   l1Edges: {from:{fact_id:string}, to:{fact_id:string}}[],
 *   policy: {allowlist?:string[]},
 * }} input
 * @returns {{nodes:object[], edges:object[], misses:object[]}}
 */
export function materializeJourneySlice({ anchors, anchorMisses, relations, records, l1Edges, policy }) {
  const allowlist = new Set(policy?.allowlist || ["CALLS", "EXPOSES"]);
  const recordById = new Map((records || []).map((r) => [r.id, r]));

  // Collect seed record IDs from resolved anchors (dedup, preserve anchor order).
  const seedRecordIds = [];
  const seen = new Set();
  for (const a of anchors || []) {
    if (a?.status !== "resolved") continue;
    for (const rid of a.record_ids || []) {
      if (typeof rid === "string" && !seen.has(rid)) {
        seen.add(rid);
        seedRecordIds.push(rid);
      }
    }
  }

  const { visitedIds, followedRelations, boundaries } = traverseForward({
    seedRecordIds,
    relations: relations || [],
    allowlist,
  });

  const nodes = visitedIds.map((id) => {
    const rec = recordById.get(id);
    return {
      kind: "node",
      id,
      label: rec?.name || id,
      layer: "l0",
      status: rec?.status || "hipótese",
    };
  });

  const edges = [
    ...followedRelations.map((r) => ({
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

  const misses = [
    ...(anchorMisses || []).map((m) => mapAnchorMiss(m)),
    ...boundaries.map((b) => ({
      kind: "miss",
      miss_reason: "policy_boundary",
      target_id: b.blocked_id,
      detail: `relation '${b.relation_type}' at ${b.record_id} is outside the journey allowlist`,
    })),
  ];

  return { nodes, edges, misses };
}

/**
 * Materialize an impact@1 Slice subgraph: { nodes, edges, misses, associations,
 * classification }.
 *
 * Plan Scope #5 — impact@1 semantics:
 *  - Starts from any seed (resolved anchors from the anchor resolver).
 *  - Traverses L0 CALLS/EXPOSES in BOTH directions (forward = downstream,
 *    reverse = upstream) via a unified BFS seeded by the resolved record IDs.
 *  - Traverses L1 cross-service edges in BOTH directions (outbound and
 *    inbound) by matching a visited record's fact_id against L1 endpoints;
 *    the other endpoint's records become cross_service nodes.
 *  - Emits edge→journey associations from the current L2 binds (step_edges).
 *    Associations carry ONLY stable IDs (edge_id, journey_id, step_id) —
 *    never timestamps.
 *  - Classifies each node as seed|upstream|downstream|cross_service|
 *    data_dependency. data_dependency is emitted ONLY when the indexed
 *    relation type is explicitly in the policy's data_relation_kinds —
 *    NEVER inferred by name. In v1 data_relation_kinds is empty.
 *  - Same-repo calls stay L0 (L1 edges are cross-repo by construction per
 *    matcher.mjs:89-99); the adapter never promotes intra-repo to L1.
 *  - Visited-set by stable record ID: cyclic graphs terminate. Canonical
 *    ordering via raw code-unit compare; never localeCompare.
 *
 * `frontierFacts` (Map<fact_id, record_id[]>) is required to bridge L1
 * fact_ids to L0 record_ids — the same map produced by the source reader.
 *
 * @param {{
 *   anchors: {status:string, record_ids:string[]}[],
 *   anchorMisses: {reason:string, step_id?:string, detail?:object}[],
 *   relations: object[],
 *   records: {id:string, name?:string, status?:string}[],
 *   l1Edges: {edge_id:string, from:{fact_id:string}, to:{fact_id:string}}[],
 *   l2Bindings: {journey_id:string, step_edges?:{step_id:string, edge_id:string, step_status:string}[]}[],
 *   frontierFacts: Map<string, string[]>,
 *   policy: {allowlist?:string[], data_relation_kinds?:string[]},
 * }} input
 * @returns {{nodes:object[], edges:object[], misses:object[], associations:object[], classification:Record<string,string>}}
 */
export function materializeImpactSlice({
  anchors, anchorMisses, relations, records, l1Edges, l2Bindings, frontierFacts, policy,
}) {
  const allowlist = new Set(policy?.allowlist || ["CALLS", "EXPOSES"]);
  const dataRelationKinds = new Set(policy?.data_relation_kinds || []);
  const recordById = new Map((records || []).map((r) => [r.id, r]));
  const ff = frontierFacts || new Map();

  // Unified L0 adjacency: record_id -> [{rel, next, cls}] for both directions.
  // Forward (from->to) marks downstream; reverse (to->from) marks upstream.
  const l0Adj = new Map();
  for (const r of relations || []) {
    if (typeof r.from_record !== "string" || typeof r.to_record !== "string") continue;
    pushAdj(l0Adj, r.from_record, { rel: r, next: r.to_record, cls: "downstream" });
    pushAdj(l0Adj, r.to_record, { rel: r, next: r.from_record, cls: "upstream" });
  }
  for (const list of l0Adj.values()) list.sort((a, b) => compareRaw(a.next, b.next));

  // L1 fact adjacency: fact_id -> [{edge, other_fact_id}] for both directions.
  const l1ByFact = new Map();
  for (const e of l1Edges || []) {
    const ffId = e.from?.fact_id, tfId = e.to?.fact_id;
    if (typeof ffId !== "string" || typeof tfId !== "string") continue;
    pushAdj(l1ByFact, ffId, { edge: e, other_fact_id: tfId });
    pushAdj(l1ByFact, tfId, { edge: e, other_fact_id: ffId });
  }

  const recordToFact = new Map();
  for (const [factId, recIds] of ff) for (const rid of recIds) recordToFact.set(rid, factId);

  // Seed record IDs from resolved anchors (dedup, preserve anchor order).
  const seedRecordIds = [];
  const seenSeed = new Set();
  for (const a of anchors || []) {
    if (a?.status !== "resolved") continue;
    for (const rid of a.record_ids || []) {
      if (typeof rid === "string" && !seenSeed.has(rid)) { seenSeed.add(rid); seedRecordIds.push(rid); }
    }
  }

  const visited = new Set();
  const classification = {};
  const followedRelations = new Map();
  const followedL1 = new Map();
  const queue = [];

  const enqueue = (id, cls) => {
    if (visited.has(id)) return;
    visited.add(id);
    if (!(id in classification)) classification[id] = cls;
    queue.push(id);
  };
  for (const id of seedRecordIds) { visited.add(id); classification[id] = "seed"; queue.push(id); }

  // Unified BFS: L0 bidirectional + L1 cross-service, classified on first reach.
  while (queue.length > 0) {
    const current = queue.shift();
    for (const { rel, next, cls } of l0Adj.get(current) || []) {
      if (!allowlist.has(rel.relation_type)) continue;
      followedRelations.set(rel.id, rel);
      enqueue(next, cls);
    }
    const currentFact = recordToFact.get(current);
    if (currentFact) {
      for (const { edge: e, other_fact_id } of l1ByFact.get(currentFact) || []) {
        followedL1.set(e.edge_id, e);
        for (const next of ff.get(other_fact_id) || []) enqueue(next, "cross_service");
      }
    }
  }

  // data_dependency: ONLY for explicitly typed relations (empty in v1).
  for (const r of followedRelations.values()) {
    if (!dataRelationKinds.has(r.relation_type)) continue;
    if (r.from_record in classification) classification[r.from_record] = "data_dependency";
    if (r.to_record in classification) classification[r.to_record] = "data_dependency";
  }

  const nodes = [...visited].sort(compareRaw).map((id) => ({
    kind: "node", id, label: recordById.get(id)?.name || id, layer: "l0",
    status: recordById.get(id)?.status || "hipótese",
  }));
  const edges = [
    ...[...followedRelations.values()].map((r) => ({
      kind: "edge", from: r.from_record, to: r.to_record,
      relation_type: r.relation_type, layer: "l0", status: r.status || "hipótese",
    })),
    ...[...followedL1.values()].map((e) => ({
      kind: "edge", from: e.from.fact_id, to: e.to.fact_id,
      relation_type: "cross_service", layer: "l1", status: "hipótese",
    })),
  ];

  // Edge→journey associations: stable IDs ONLY (never timestamps).
  const associations = (l2Bindings || []).flatMap((b) =>
    (b.step_edges || [])
      .filter((s) => s.step_status === "bound" && s.edge_id && s.edge_id !== "__gap__")
      .map((s) => ({ edge_id: s.edge_id, journey_id: b.journey_id, step_id: s.step_id })),
  );
  associations.sort((a, b) =>
    compareRaw(`${a.edge_id}\u0000${a.journey_id}\u0000${a.step_id}`, `${b.edge_id}\u0000${b.journey_id}\u0000${b.step_id}`),
  );

  return { nodes, edges, misses: [...(anchorMisses || []).map(mapAnchorMiss)], associations, classification };
}

/** Push a value into a Map<key, array> adjacency list. */
function pushAdj(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

/**
 * Map an anchor-resolver miss to the contract miss shape.
 * Ensures target_id matches the canonicalId pattern (contains a colon).
 *
 * Exported so the drill-down adapter (slice-traversal-drill-down.mjs, Todo 11)
 * can reuse the exact same anchor-miss projection without duplicating it.
 *
 * @param {{reason:string, step_id?:string, detail?:object}} m
 */
export function mapAnchorMiss(m) {
  const d = m.detail || {};
  let targetId;
  if (d.fact_id) targetId = d.fact_id;
  else if (d.edge_id) targetId = d.edge_id;
  else if (d.journey_id) targetId = d.journey_id;
  else if (m.step_id) targetId = `step:${m.step_id}`;
  else targetId = "unknown:target";

  const parts = [m.reason];
  if (m.step_id) parts.push(`step ${m.step_id}`);
  if (d.fact_id) parts.push(`fact ${d.fact_id}`);
  if (d.edge_id) parts.push(`edge ${d.edge_id}`);

  return { kind: "miss", miss_reason: m.reason, target_id: targetId, detail: parts.join(" ") };
}
