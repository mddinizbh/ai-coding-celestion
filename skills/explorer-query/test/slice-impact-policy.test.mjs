/**
 * Tests for slice-traversal.mjs (Task 10) — impact@1 policy.
 *
 * Acceptance (plan Todo 10):
 *  - fixture proves blast radius upstream/downstream/cross-service + journey
 *  - rebind moving a journey from edge A to B changes associations emitted
 *  - same-repo stays L0
 *  - data_dependency only for explicitly typed relation, never by name
 *
 * Additional invariants (plan Scope #5):
 *  - L0 CALLS/EXPOSES traversed in BOTH directions from seed.
 *  - L1 cross-service edges traversed in BOTH directions.
 *  - edge→journey associations from current L2 binds; only stable IDs.
 *  - associations carry edge_id, journey_id, step_id — never timestamps.
 *  - visited-set per stable ID; cyclic graphs terminate.
 *  - canonical ordering via raw code-unit compare; never localeCompare.
 *  - layer/original IDs preserved.
 *
 * Hermetic: synthetic relations/edges/anchors; no DB, filesystem, or network.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveAnchors } from "../src/slice-anchor-resolver.mjs";
import { traverseForward, materializeImpactSlice } from "../src/slice-traversal.mjs";
import { getPolicy } from "../src/slice-policies.mjs";

const NS = "ns";
const IMPACT_POLICY = getPolicy("impact", 1);

// --- hermetic fixture factories (mirror journey test patterns) -------------

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** L0 relation. Only fields the traversal reads are semantically meaningful. */
function rel(id, from, type, to, status = "comprovado") {
  return {
    id,
    namespace: NS,
    from_record: from,
    relation_type: type,
    to_record: to,
    status,
    source_revision: "rev-1",
    source_engine: { name: "t", profile: "p", adapter_version: "1", artifact_manifest_id: "manifest:t" },
    evidence: [
      { kind: "artifact", manifest_id: "manifest:t", artifact_path: "src/a.ts", content_sha256: "a".repeat(64), range: { start_line: 1, end_line: 2 } },
    ],
  };
}

function record(id, name, status = "comprovado") {
  return { id, namespace: NS, type: "method", name, status, attributes: {} };
}

function ffMap(entries) {
  return new Map(entries);
}

/** Minimal SystemEdge-shape. */
function edge(edge_id, fromFact, toFact, fromRepo = "svc-a", toRepo = "svc-b") {
  return {
    edge_id,
    system_namespace: NS,
    from: { namespace: NS, logical_repo: fromRepo, fact_id: fromFact },
    to: { namespace: NS, logical_repo: toRepo, fact_id: toFact },
  };
}

/** l2Bindings entry with step_edges (enriched by orchestrator). */
function bind(journey_id, bind_id, journey_hash, step_edges = []) {
  return { journey_id, bind_id, journey_hash, step_edges };
}

function l0Seed(fact_id, repo = "svc-a") {
  return { kind: "l0_fact", namespace: NS, logical_repo: repo, fact_id };
}

function l1Seed(edge_id) {
  return { kind: "l1_edge", system_namespace: NS, edge_id };
}

// --- characterization: traverseForward core unchanged (Task 9 baseline) ----

describe("characterization — traverseForward core unchanged (Task 9 baseline)", () => {
  test("forward CALLS is followed; reverse is ignored by core", () => {
    const { visitedIds, followedRelations } = traverseForward({
      seedRecordIds: ["r:a"],
      relations: [rel("rel:1", "r:a", "CALLS", "r:b")],
      allowlist: new Set(["CALLS", "EXPOSES"]),
    });
    assert.deepEqual([...visitedIds].sort(cmp), ["r:a", "r:b"]);
    assert.equal(followedRelations.length, 1);
  });
});

// --- impact@1: classification & blast radius --------------------------------

describe("materializeImpactSlice — impact@1 blast radius", () => {
  test("upstream caller reached via reverse CALLS", () => {
    // B calls A; seed=A. B is upstream of A.
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:b", ["r:b"]]]);
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [], l2Bindings: [] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [rel("rel:ba", "r:b", "CALLS", "r:a")],
      records: [record("r:a", "handleA"), record("r:b", "callerB")],
      l1Edges: [],
      l2Bindings: [],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    assert.ok(result.classification["r:a"] === "seed");
    assert.ok(result.classification["r:b"] === "upstream");
  });

  test("downstream callee reached via forward CALLS", () => {
    // A calls C; seed=A. C is downstream of A.
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:c", ["r:c"]]]);
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [], l2Bindings: [] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [rel("rel:ac", "r:a", "CALLS", "r:c")],
      records: [record("r:a", "handleA"), record("r:c", "calleeC")],
      l1Edges: [],
      l2Bindings: [],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    assert.equal(result.classification["r:a"], "seed");
    assert.equal(result.classification["r:c"], "downstream");
  });

  test("cross-service endpoint reached via L1 edge", () => {
    // Seed=A in svc-a; L1 edge ff:a(svc-a) -> ff:d(svc-b). D is cross_service.
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:d", ["r:d"]]]);
    const e1 = edge("l1:e1", "ff:a", "ff:d", "svc-a", "svc-b");
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [e1], l2Bindings: [] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [],
      records: [record("r:a", "handleA"), record("r:d", "serviceD")],
      l1Edges: [e1],
      l2Bindings: [],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    assert.equal(result.classification["r:a"], "seed");
    assert.equal(result.classification["r:d"], "cross_service");
    const l1Edges = result.edges.filter((e) => e.layer === "l1");
    assert.equal(l1Edges.length, 1);
    assert.equal(l1Edges[0].relation_type, "cross_service");
  });

  test("full blast radius: upstream + downstream + cross_service in one fixture", () => {
    // svc-a: A (seed), B calls A (upstream), A calls C (downstream)
    // svc-b: D reached via L1 ff:a -> ff:d (cross_service)
    const ff = ffMap([
      ["ff:a", ["r:a"]],
      ["ff:b", ["r:b"]],
      ["ff:c", ["r:c"]],
      ["ff:d", ["r:d"]],
    ]);
    const e1 = edge("l1:e1", "ff:a", "ff:d", "svc-a", "svc-b");
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [e1], l2Bindings: [] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [
        rel("rel:ba", "r:b", "CALLS", "r:a"),
        rel("rel:ac", "r:a", "CALLS", "r:c"),
      ],
      records: [
        record("r:a", "handleA"),
        record("r:b", "callerB"),
        record("r:c", "calleeC"),
        record("r:d", "serviceD"),
      ],
      l1Edges: [e1],
      l2Bindings: [],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    assert.equal(result.classification["r:a"], "seed");
    assert.equal(result.classification["r:b"], "upstream");
    assert.equal(result.classification["r:c"], "downstream");
    assert.equal(result.classification["r:d"], "cross_service");

    // Node IDs are deterministic (raw code-unit sorted).
    const nodeIds = result.nodes.map((n) => n.id);
    assert.deepEqual(nodeIds, [...nodeIds].sort(cmp), "nodes in canonical order");
  });
});

// --- impact@1: edge→journey associations ------------------------------------

describe("materializeImpactSlice — edge→journey associations", () => {
  test("association emitted for bound step referencing an L1 edge", () => {
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:d", ["r:d"]]]);
    const e1 = edge("l1:e1", "ff:a", "ff:d", "svc-a", "svc-b");
    const b = bind("l2:j1", "l2:b1", "h1", [
      { step_id: "s1", edge_id: "l1:e1", step_status: "bound" },
    ]);
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [e1], l2Bindings: [b] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [],
      records: [record("r:a", "handleA"), record("r:d", "serviceD")],
      l1Edges: [e1],
      l2Bindings: [b],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    assert.ok(Array.isArray(result.associations));
    assert.equal(result.associations.length, 1);
    const a = result.associations[0];
    assert.equal(a.edge_id, "l1:e1");
    assert.equal(a.journey_id, "l2:j1");
    assert.equal(a.step_id, "s1");
    // Stable IDs ONLY — no timestamp keys smuggled in.
    const keys = Object.keys(a).sort(cmp);
    assert.deepEqual(keys, ["edge_id", "journey_id", "step_id"]);
  });

  test("rebind from edge A to B changes emitted association", () => {
    const ff = ffMap([
      ["ff:a", ["r:a"]],
      ["ff:d", ["r:d"]],
      ["ff:e", ["r:e"]],
    ]);
    const e1 = edge("l1:e1", "ff:a", "ff:d", "svc-a", "svc-b");
    const e2 = edge("l1:e2", "ff:a", "ff:e", "svc-a", "svc-c");

    // Bind 1: journey on edge e1.
    const b1 = bind("l2:j1", "l2:b1", "h1", [
      { step_id: "s1", edge_id: "l1:e1", step_status: "bound" },
    ]);
    const { anchors: anchors1 } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [e1, e2], l2Bindings: [b1] },
    });
    const result1 = materializeImpactSlice({
      anchors: anchors1,
      anchorMisses: [],
      relations: [],
      records: [record("r:a", "handleA"), record("r:d", "d"), record("r:e", "e")],
      l1Edges: [e1, e2],
      l2Bindings: [b1],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    assert.equal(result1.associations.length, 1);
    assert.equal(result1.associations[0].edge_id, "l1:e1");

    // Bind 2: SAME journey rebind to edge e2 (new bind_id + journey_hash).
    const b2 = bind("l2:j1", "l2:b2", "h2", [
      { step_id: "s1", edge_id: "l1:e2", step_status: "bound" },
    ]);
    const { anchors: anchors2 } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [e1, e2], l2Bindings: [b2] },
    });
    const result2 = materializeImpactSlice({
      anchors: anchors2,
      anchorMisses: [],
      relations: [],
      records: [record("r:a", "handleA"), record("r:d", "d"), record("r:e", "e")],
      l1Edges: [e1, e2],
      l2Bindings: [b2],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    assert.equal(result2.associations.length, 1);
    assert.equal(result2.associations[0].edge_id, "l1:e2");
    assert.notEqual(
      result1.associations[0].edge_id,
      result2.associations[0].edge_id,
      "rebind changed the associated edge",
    );
  });

  test("associations sorted deterministically by edge_id, journey_id, step_id", () => {
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:d", ["r:d"]]]);
    const e1 = edge("l1:e1", "ff:a", "ff:d", "svc-a", "svc-b");
    const e2 = edge("l1:e2", "ff:d", "ff:a", "svc-b", "svc-a");
    const b = bind("l2:j1", "l2:b1", "h1", [
      { step_id: "s2", edge_id: "l1:e2", step_status: "bound" },
      { step_id: "s1", edge_id: "l1:e1", step_status: "bound" },
    ]);
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [e1, e2], l2Bindings: [b] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [],
      records: [record("r:a", "handleA"), record("r:d", "serviceD")],
      l1Edges: [e1, e2],
      l2Bindings: [b],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    const keys = result.associations.map((a) =>
      `${a.edge_id}\u0000${a.journey_id}\u0000${a.step_id}`,
    );
    assert.deepEqual(keys, [...keys].sort(cmp), "associations canonically sorted");
  });
});

// --- impact@1: same-repo stays L0 -------------------------------------------

describe("materializeImpactSlice — same-repo stays L0", () => {
  test("intra-repo CALLS produces L0 edges, never L1", () => {
    // A and C are in the SAME repo (svc-a). A calls C.
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:c", ["r:c"]]]);
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [], l2Bindings: [] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [rel("rel:ac", "r:a", "CALLS", "r:c")],
      records: [record("r:a", "handleA"), record("r:c", "calleeC")],
      l1Edges: [],
      l2Bindings: [],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    const l0Edges = result.edges.filter((e) => e.layer === "l0");
    const l1Edges = result.edges.filter((e) => e.layer === "l1");
    assert.equal(l0Edges.length, 1);
    assert.equal(l1Edges.length, 0, "same-repo call is NOT promoted to L1");
    // All nodes remain L0.
    for (const n of result.nodes) {
      assert.equal(n.layer, "l0");
    }
  });
});

// --- impact@1: data_dependency NEVER inferred by name ------------------------

describe("materializeImpactSlice — data_dependency only for typed relation", () => {
  test("node named 'UserRepository' via CALLS is NOT data_dependency", () => {
    // A calls a node named "UserRepository"; relation type is CALLS (not a data kind).
    // data_dependency must NEVER be inferred from the name.
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:repo", ["r:repo"]]]);
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [], l2Bindings: [] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [rel("rel:repo", "r:a", "CALLS", "r:repo")],
      records: [
        record("r:a", "handleA"),
        record("r:repo", "UserRepository"),
      ],
      l1Edges: [],
      l2Bindings: [],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    assert.equal(result.classification["r:repo"], "downstream");
    assert.notEqual(
      result.classification["r:repo"],
      "data_dependency",
      "name containing 'repository' MUST NOT infer data_dependency",
    );
    // No data_dependency classifications in v1 (DATA_RELATION_KINDS is empty).
    const dataDeps = Object.entries(result.classification).filter(
      ([, c]) => c === "data_dependency",
    );
    assert.equal(dataDeps.length, 0, "zero data_dependency in v1");
  });

  test("node named 'database' via EXPOSES is NOT data_dependency", () => {
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:db", ["r:db"]]]);
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [], l2Bindings: [] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [rel("rel:db", "r:a", "EXPOSES", "r:db")],
      records: [record("r:a", "handleA"), record("r:db", "database_helper")],
      l1Edges: [],
      l2Bindings: [],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    assert.notEqual(
      result.classification["r:db"],
      "data_dependency",
      "name containing 'database' MUST NOT infer data_dependency",
    );
  });
});

// --- impact@1: invariants ---------------------------------------------------

describe("materializeImpactSlice — invariants", () => {
  test("cyclic graph terminates — each node visited once", () => {
    // A->B->C->A cycle. Seed A.
    const ff = ffMap([
      ["ff:a", ["r:a"]],
      ["ff:b", ["r:b"]],
      ["ff:c", ["r:c"]],
    ]);
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [], l2Bindings: [] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [
        rel("rel:ab", "r:a", "CALLS", "r:b"),
        rel("rel:bc", "r:b", "CALLS", "r:c"),
        rel("rel:ca", "r:c", "CALLS", "r:a"),
      ],
      records: [
        record("r:a", "handleA"),
        record("r:b", "handleB"),
        record("r:c", "handleC"),
      ],
      l1Edges: [],
      l2Bindings: [],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    const nodeIds = result.nodes.map((n) => n.id);
    assert.equal(nodeIds.length, new Set(nodeIds).size, "no duplicate nodes");
    assert.deepEqual(nodeIds, [...nodeIds].sort(cmp));
  });

  test("bidirectional: both forward and reverse EXPOSES are followed", () => {
    // A exposes B (downstream). C exposes A (upstream). Seed A.
    const ff = ffMap([
      ["ff:a", ["r:a"]],
      ["ff:b", ["r:b"]],
      ["ff:c", ["r:c"]],
    ]);
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [], l2Bindings: [] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [
        rel("rel:ab", "r:a", "EXPOSES", "r:b"),
        rel("rel:ca", "r:c", "EXPOSES", "r:a"),
      ],
      records: [
        record("r:a", "handleA"),
        record("r:b", "handleB"),
        record("r:c", "handleC"),
      ],
      l1Edges: [],
      l2Bindings: [],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    assert.equal(result.classification["r:b"], "downstream");
    assert.equal(result.classification["r:c"], "upstream");
  });

  test("L1 inbound edge: cross_service reached from the 'to' side", () => {
    // L1 edge ff:d(svc-b) -> ff:a(svc-a). Seed=A (svc-a). D is cross_service upstream.
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:d", ["r:d"]]]);
    const e1 = edge("l1:e1", "ff:d", "ff:a", "svc-b", "svc-a");
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [e1], l2Bindings: [] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [],
      records: [record("r:a", "handleA"), record("r:d", "serviceD")],
      l1Edges: [e1],
      l2Bindings: [],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    assert.equal(result.classification["r:d"], "cross_service");
  });

  test("contract shape: nodes/edges conform to schema", () => {
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:c", ["r:c"]]]);
    const e1 = edge("l1:e1", "ff:a", "ff:c", "svc-a", "svc-b");
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [e1], l2Bindings: [] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [rel("rel:ac", "r:a", "CALLS", "r:c2")],
      records: [record("r:a", "handleA"), record("r:c", "handleC"), record("r:c2", "handleC2")],
      l1Edges: [e1],
      l2Bindings: [],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    for (const n of result.nodes) {
      assert.equal(n.kind, "node");
      assert.ok(typeof n.id === "string" && n.id.includes(":"));
      assert.ok(typeof n.label === "string" && n.label.length > 0);
      assert.ok(["l0", "l1", "l2"].includes(n.layer));
      assert.ok(["comprovado", "hipótese", "contradição", "stale"].includes(n.status));
    }
    for (const e of result.edges) {
      assert.equal(e.kind, "edge");
      assert.ok(typeof e.from === "string" && e.from.length > 2);
      assert.ok(typeof e.to === "string" && e.to.length > 2);
      assert.ok(typeof e.relation_type === "string" && e.relation_type.length > 0);
      assert.ok(["l0", "l1", "l2"].includes(e.layer));
      assert.ok(["comprovado", "hipótese", "contradição", "stale"].includes(e.status));
    }
  });

  test("unresolved anchor forwards miss without inventing nodes", () => {
    const ff = ffMap([]);
    const { anchors, misses: anchorMisses } = resolveAnchors({
      seeds: [l0Seed("ff:ghost")],
      frontierFacts: ff,
      scope: { edges: [], l2Bindings: [] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses,
      relations: [],
      records: [],
      l1Edges: [],
      l2Bindings: [],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    assert.equal(result.nodes.length, 0);
    const unresolved = result.misses.filter((m) => m.miss_reason === "unresolved_fact_anchor");
    assert.equal(unresolved.length, 1);
  });

  test("multiple seeds: all classified as seed, no duplicate", () => {
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:b", ["r:b"]]]);
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:a"), l0Seed("ff:b")],
      frontierFacts: ff,
      scope: { edges: [], l2Bindings: [] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [],
      records: [record("r:a", "handleA"), record("r:b", "handleB")],
      l1Edges: [],
      l2Bindings: [],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    assert.equal(result.classification["r:a"], "seed");
    assert.equal(result.classification["r:b"], "seed");
    const nodeIds = result.nodes.map((n) => n.id);
    assert.equal(nodeIds.length, new Set(nodeIds).size);
  });

  test("no L1 edges touching seed: zero cross_service nodes", () => {
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:c", ["r:c"]]]);
    // L1 edge connects ff:x -> ff:y, neither touching seed A.
    const e1 = edge("l1:e1", "ff:x", "ff:y", "svc-c", "svc-d");
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: { edges: [e1], l2Bindings: [] },
    });
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [rel("rel:ac", "r:a", "CALLS", "r:c")],
      records: [record("r:a", "handleA"), record("r:c", "calleeC")],
      l1Edges: [e1],
      l2Bindings: [],
      frontierFacts: ff,
      policy: IMPACT_POLICY,
    });
    const crossService = Object.entries(result.classification).filter(
      ([, c]) => c === "cross_service",
    );
    assert.equal(crossService.length, 0, "untouched L1 edge does not add cross_service");
  });
});
