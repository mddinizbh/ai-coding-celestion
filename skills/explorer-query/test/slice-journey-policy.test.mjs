/**
 * Tests for slice-traversal.mjs (Task 9) — journey@1 policy.
 *
 * Two layers tested:
 *  1. Characterization: resolveAnchors (Task 8) still works unchanged — proves
 *     the journey adapter's input contract is not broken by new code.
 *  2. Journey traversal: traverseForward core + materializeJourneySlice adapter.
 *
 * Acceptance (plan Todo 9):
 *  - Cyclic graph terminates (visited-set by stable ID).
 *  - Step order is stable.
 *  - CALLS/EXPOSES forward enter.
 *  - Reverse/UNKNOWN do NOT enter.
 *  - Gap and boundary have correct miss reason.
 *
 * Hermetic: synthetic relations/edges/anchors; no DB, no filesystem, no network.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveAnchors } from "../src/slice-anchor-resolver.mjs";
import { traverseForward, materializeJourneySlice } from "../src/slice-traversal.mjs";
import { getPolicy } from "../src/slice-policies.mjs";

const NS = "ns";
const ALLOW = new Set(["CALLS", "EXPOSES"]);
const JOURNEY_POLICY = getPolicy("journey", 1);

// --- hermetic fixture factories --------------------------------------------

/** Raw code-unit compare — mirrors slice-canonical.compareRaw. */
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * L0 relation (forward from_record -> to_record). Only fields the traversal
 * reads are semantically meaningful; the rest satisfies the relation contract
 * shape so the output can be consumed by canonical/coverage modules.
 */
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

/** L0 record for node metadata. */
function record(id, name, status = "comprovado") {
  return { id, namespace: NS, type: "method", name, status, attributes: {} };
}

/** frontierFacts Map<fact_id, record_id[]>. */
function ffMap(entries) {
  return new Map(entries);
}

/** Minimal SystemEdge-shape (only fields the adapter reads). */
function edge(edge_id, fromFact, toFact, fromRepo = "svc-a", toRepo = "svc-b") {
  return {
    edge_id,
    system_namespace: NS,
    from: { namespace: NS, logical_repo: fromRepo, fact_id: fromFact },
    to: { namespace: NS, logical_repo: toRepo, fact_id: toFact },
  };
}

/** l2Bindings entry with step_edges. */
function bind(journey_id, bind_id, journey_hash, step_edges = []) {
  return { journey_id, bind_id, journey_hash, step_edges };
}

function l2Seed(journey_id, bind_id) {
  const seed = { kind: "l2_journey", system_namespace: NS, journey_id };
  if (bind_id) seed.bind_id = bind_id;
  return seed;
}

function l0Seed(fact_id, repo = "svc-a") {
  return { kind: "l0_fact", namespace: NS, logical_repo: repo, fact_id };
}

function scopeObj(edges = [], l2Bindings = []) {
  return { edges, l2Bindings };
}

// --- characterization: resolveAnchors unchanged (Task 8 baseline) -----------

describe("characterization — resolveAnchors unchanged (Task 8 baseline)", () => {
  test("l0_fact resolves via explicit map lookup", () => {
    const ff = ffMap([["ff:a", ["r:a1", "r:a2"]]]);
    const { anchors, misses } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: scopeObj(),
    });
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].status, "resolved");
    assert.deepEqual(anchors[0].record_ids, ["r:a1", "r:a2"]);
    assert.equal(misses.length, 0);
  });

  test("l2_journey 2 bound steps + 1 gap preserves step order", () => {
    const e1 = edge("l1:e1", "ff:a", "ff:b");
    const e2 = edge("l1:e2", "ff:b", "ff:c");
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:b", ["r:b"]], ["ff:c", ["r:c"]]]);
    const b = bind("l2:j1", "l2:b1", "h1", [
      { step_id: "s1", edge_id: "l1:e1", step_status: "bound" },
      { step_id: "s2", edge_id: "l1:e2", step_status: "bound" },
      { step_id: "s3", edge_id: "__gap__", step_status: "gap" },
    ]);
    const { anchors, misses } = resolveAnchors({
      seeds: [l2Seed("l2:j1")],
      frontierFacts: ff,
      scope: scopeObj([e1, e2], [b]),
    });
    assert.deepEqual(
      anchors.map((a) => a.step_id),
      ["s1", "s2", "s3"],
      "step order preserved",
    );
    assert.equal(misses.length, 1);
    assert.equal(misses[0].reason, "no_matching_edge");
    assert.equal(misses[0].step_id, "s3");
  });
});

// --- traverseForward core invariants ---------------------------------------

describe("traverseForward — core invariants", () => {
  test("CALLS forward is followed", () => {
    const { visitedIds, followedRelations } = traverseForward({
      seedRecordIds: ["r:a"],
      relations: [rel("rel:1", "r:a", "CALLS", "r:b")],
      allowlist: ALLOW,
    });
    assert.deepEqual([...visitedIds].sort(cmp), ["r:a", "r:b"]);
    assert.equal(followedRelations.length, 1);
    assert.equal(followedRelations[0].relation_type, "CALLS");
  });

  test("EXPOSES forward is followed", () => {
    const { followedRelations } = traverseForward({
      seedRecordIds: ["r:a"],
      relations: [rel("rel:2", "r:a", "EXPOSES", "r:b")],
      allowlist: ALLOW,
    });
    assert.equal(followedRelations.length, 1);
    assert.equal(followedRelations[0].relation_type, "EXPOSES");
  });

  test("reverse relation is NOT followed (incoming edge ignored)", () => {
    // Edge B->A exists; we start from A. The edge is incoming to A; we never
    // examine incoming edges (forward-only traversal).
    const { visitedIds, followedRelations, boundaries } = traverseForward({
      seedRecordIds: ["r:a"],
      relations: [rel("rel:3", "r:b", "CALLS", "r:a")],
      allowlist: ALLOW,
    });
    assert.deepEqual(visitedIds, ["r:a"]);
    assert.equal(followedRelations.length, 0);
    assert.equal(boundaries.length, 0);
  });

  test("UNKNOWN relation does NOT enter — policy_boundary emitted (not silent)", () => {
    const { visitedIds, followedRelations, boundaries } = traverseForward({
      seedRecordIds: ["r:a"],
      relations: [rel("rel:4", "r:a", "UNKNOWN", "r:c")],
      allowlist: ALLOW,
    });
    assert.deepEqual(visitedIds, ["r:a"]);
    assert.equal(followedRelations.length, 0);
    assert.equal(boundaries.length, 1);
    assert.equal(boundaries[0].relation_type, "UNKNOWN");
    assert.equal(boundaries[0].blocked_id, "r:c");
    assert.equal(boundaries[0].record_id, "r:a");
  });

  test("cyclic graph terminates — each node visited exactly once", () => {
    const { visitedIds, followedRelations, boundaries } = traverseForward({
      seedRecordIds: ["r:a"],
      relations: [
        rel("rel:ab", "r:a", "CALLS", "r:b"),
        rel("rel:bc", "r:b", "CALLS", "r:c"),
        rel("rel:ca", "r:c", "CALLS", "r:a"),
      ],
      allowlist: ALLOW,
    });
    assert.equal(visitedIds.length, 3);
    assert.equal(new Set(visitedIds).size, 3);
    assert.deepEqual([...visitedIds].sort(cmp), ["r:a", "r:b", "r:c"]);
    assert.equal(followedRelations.length, 3);
    assert.equal(boundaries.length, 0);
  });

  test("off-allowlist known relation emits policy_boundary, not silent truncation", () => {
    const { visitedIds, boundaries } = traverseForward({
      seedRecordIds: ["r:a"],
      relations: [
        rel("rel:ab", "r:a", "CALLS", "r:b"),
        rel("rel:bd", "r:b", "CONTAINS", "r:d"),
      ],
      allowlist: ALLOW,
    });
    assert.deepEqual([...visitedIds].sort(cmp), ["r:a", "r:b"]);
    assert.equal(boundaries.length, 1);
    assert.equal(boundaries[0].relation_type, "CONTAINS");
    assert.equal(boundaries[0].record_id, "r:b");
    assert.equal(boundaries[0].blocked_id, "r:d");
  });

  test("raw code-unit order: uppercase Z sorts before lowercase a (never locale)", () => {
    const { visitedIds } = traverseForward({
      seedRecordIds: ["r:seed"],
      relations: [
        rel("rel:1", "r:seed", "CALLS", "r:a"),
        rel("rel:2", "r:seed", "CALLS", "r:Z"),
      ],
      allowlist: ALLOW,
    });
    // Adjacency sorted by to_record raw code-unit: 'Z' (0x5A) < 'a' (0x61).
    // localeCompare would reverse these under many locales.
    assert.deepEqual(visitedIds, ["r:seed", "r:Z", "r:a"]);
  });

  test("stable: same input always produces same visited + followed sequence", () => {
    const relations = [
      rel("rel:ac", "r:a", "CALLS", "r:c"),
      rel("rel:ab", "r:a", "CALLS", "r:b"),
    ];
    const r1 = traverseForward({ seedRecordIds: ["r:a"], relations, allowlist: ALLOW });
    const r2 = traverseForward({ seedRecordIds: ["r:a"], relations, allowlist: ALLOW });
    assert.deepEqual(r1.visitedIds, r2.visitedIds);
    assert.deepEqual(
      r1.followedRelations.map((r) => r.id),
      r2.followedRelations.map((r) => r.id),
    );
  });

  test("multiple seeds — all visited, no duplicate even with overlap", () => {
    const { visitedIds } = traverseForward({
      seedRecordIds: ["r:a", "r:b"],
      relations: [rel("rel:ab", "r:a", "CALLS", "r:b")],
      allowlist: ALLOW,
    });
    assert.deepEqual(visitedIds, ["r:a", "r:b"]);
    assert.equal(new Set(visitedIds).size, 2);
  });

  test("no forward relations at seed — visits only the seed", () => {
    const { visitedIds, followedRelations } = traverseForward({
      seedRecordIds: ["r:lonely"],
      relations: [],
      allowlist: ALLOW,
    });
    assert.deepEqual(visitedIds, ["r:lonely"]);
    assert.equal(followedRelations.length, 0);
  });
});

// --- materializeJourneySlice — journey@1 adapter ---------------------------

describe("materializeJourneySlice — journey@1 adapter", () => {
  test("2-step happy journey: ordered nodes, L0+L1 edges, zero misses", () => {
    const ff = ffMap([
      ["ff:a", ["r:a"]],
      ["ff:b", ["r:b"]],
      ["ff:c", ["r:c"]],
    ]);
    const e1 = edge("l1:e1", "ff:a", "ff:b");
    const e2 = edge("l1:e2", "ff:b", "ff:c");
    const { anchors, misses: anchorMisses } = resolveAnchors({
      seeds: [l2Seed("l2:j1")],
      frontierFacts: ff,
      scope: scopeObj([e1, e2], [
        bind("l2:j1", "l2:b1", "h1", [
          { step_id: "s1", edge_id: "l1:e1", step_status: "bound" },
          { step_id: "s2", edge_id: "l1:e2", step_status: "bound" },
        ]),
      ]),
    });
    const relations = [rel("rel:aa2", "r:a", "CALLS", "r:a2")];
    const records = [
      record("r:a", "handleA"),
      record("r:a2", "helperA2"),
      record("r:b", "handleB"),
      record("r:c", "handleC"),
    ];
    const result = materializeJourneySlice({
      anchors,
      anchorMisses,
      relations,
      records,
      l1Edges: [e1, e2],
      policy: JOURNEY_POLICY,
    });

    // Nodes: seeds (r:a, r:b, r:c) + traversal target (r:a2).
    const nodeIds = result.nodes.map((n) => n.id).sort(cmp);
    assert.deepEqual(nodeIds, ["r:a", "r:a2", "r:b", "r:c"]);

    // All nodes have the contract shape.
    for (const n of result.nodes) {
      assert.equal(n.kind, "node");
      assert.ok(n.id.includes(":"), "node id must be a canonicalId");
      assert.ok(n.label.length > 0);
      assert.equal(n.layer, "l0");
    }

    // Edges: 1 L0 CALLS + 2 L1 cross_service.
    const l0Edges = result.edges.filter((e) => e.layer === "l0");
    const l1Result = result.edges.filter((e) => e.layer === "l1");
    assert.equal(l0Edges.length, 1);
    assert.equal(l0Edges[0].relation_type, "CALLS");
    assert.equal(l0Edges[0].from, "r:a");
    assert.equal(l0Edges[0].to, "r:a2");
    assert.equal(l1Result.length, 2);
    assert.equal(l1Result[0].relation_type, "cross_service");

    // No misses (both steps bound, no gaps, no boundaries).
    assert.equal(result.misses.length, 0);
  });

  test("journey with gap: no_matching_edge miss preserved", () => {
    const ff = ffMap([["ff:a", ["r:a"]]]);
    const e1 = edge("l1:e1", "ff:a", "ff:b");
    const { anchors, misses: anchorMisses } = resolveAnchors({
      seeds: [l2Seed("l2:j1")],
      frontierFacts: ff,
      scope: scopeObj([e1], [
        bind("l2:j1", "l2:b1", "h1", [
          { step_id: "s1", edge_id: "l1:e1", step_status: "bound" },
          { step_id: "s2", edge_id: "__gap__", step_status: "gap" },
        ]),
      ]),
    });
    const result = materializeJourneySlice({
      anchors,
      anchorMisses,
      relations: [],
      records: [record("r:a", "handleA")],
      l1Edges: [e1],
      policy: JOURNEY_POLICY,
    });
    const gapMisses = result.misses.filter((m) => m.miss_reason === "no_matching_edge");
    assert.ok(gapMisses.length >= 1);
    assert.equal(gapMisses[0].kind, "miss");
    assert.ok(gapMisses[0].target_id.includes(":"), "target_id must be canonicalId");
    assert.ok(gapMisses[0].detail.length > 0);
  });

  test("cycle + UNKNOWN: terminates without duplicate, boundary recorded", () => {
    const ff = ffMap([["ff:a", ["r:a"]]]);
    const { anchors, misses: anchorMisses } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: scopeObj(),
    });
    const relations = [
      rel("rel:ab", "r:a", "CALLS", "r:b"),
      rel("rel:ba", "r:b", "CALLS", "r:a"),
      rel("rel:ac", "r:a", "UNKNOWN", "r:c"),
    ];
    const records = [record("r:a", "handleA"), record("r:b", "handleB")];
    const result = materializeJourneySlice({
      anchors,
      anchorMisses,
      relations,
      records,
      l1Edges: [],
      policy: JOURNEY_POLICY,
    });

    const nodeIds = result.nodes.map((n) => n.id);
    assert.equal(nodeIds.length, new Set(nodeIds).size, "no duplicate nodes");
    assert.ok(!nodeIds.includes("r:c"), "UNKNOWN target not visited");

    const boundaries = result.misses.filter((m) => m.miss_reason === "policy_boundary");
    assert.equal(boundaries.length, 1);
    assert.equal(boundaries[0].target_id, "r:c");
    assert.equal(boundaries[0].kind, "miss");

    const l0Edges = result.edges.filter((e) => e.layer === "l0");
    assert.equal(l0Edges.length, 2, "both CALLS edges followed");
  });

  test("unresolved anchor: unresolved_fact_anchor miss in output", () => {
    const ff = ffMap([]);
    const { anchors, misses: anchorMisses } = resolveAnchors({
      seeds: [l0Seed("ff:ghost")],
      frontierFacts: ff,
      scope: scopeObj(),
    });
    const result = materializeJourneySlice({
      anchors,
      anchorMisses,
      relations: [],
      records: [],
      l1Edges: [],
      policy: JOURNEY_POLICY,
    });
    assert.equal(result.nodes.length, 0);
    const unresolved = result.misses.filter((m) => m.miss_reason === "unresolved_fact_anchor");
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].target_id, "ff:ghost");
    assert.equal(unresolved[0].kind, "miss");
  });

  test("contract shape: every node/edge/miss has required fields", () => {
    const ff = ffMap([["ff:a", ["r:a"]]]);
    const { anchors, misses: anchorMisses } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: scopeObj(),
    });
    const result = materializeJourneySlice({
      anchors,
      anchorMisses,
      relations: [rel("rel:1", "r:a", "EXPOSES", "r:b")],
      records: [record("r:a", "A"), record("r:b", "B")],
      l1Edges: [],
      policy: JOURNEY_POLICY,
    });
    for (const n of result.nodes) {
      assert.equal(n.kind, "node");
      assert.ok(typeof n.id === "string" && n.id.length > 2);
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
});
