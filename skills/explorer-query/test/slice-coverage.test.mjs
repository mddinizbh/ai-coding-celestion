/**
 * Tests for slice-coverage.mjs (Task 12 — fresh implementation, TDD).
 *
 * Plan-locked enums (Scope #6 + relation.schema.json sourceStatus):
 *   miss_reason: no_matching_edge | no_accepted_l0 | unresolved_fact_anchor |
 *                unresolved_dispatch | policy_boundary | index_missing
 *   status:      comprovado | hipótese | contradição | stale
 *   layer:       l0 | l1 | l2
 *
 * `complete_relative_to_index` is TRUE iff NO index_missing, NO unresolved
 * anchor/dispatch, NO no_accepted_l0, NO missing baselines and NO safety
 * ceiling breach. `policy_boundary` and `no_matching_edge` are graph/policy
 * facts — they do NOT flip completeness.
 *
 * Factual status is IMMUTABLE: `by_status` reflects the ORIGINAL factual
 * statuses from the indexed records, never the traversal-mutated values.
 * Never promote hipótese to comprovado.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { computeCoverage } from "../src/slice-coverage.mjs";

const SHA = "a".repeat(64);

// --- fixtures ---------------------------------------------------------------

const NODE = (id, layer, status) => ({
  kind: "node", id, label: id, layer, status,
});
const EDGE = (from, to, layer, status, relation_type = "CALLS", extra = {}) => ({
  kind: "edge", from, to, relation_type, layer, status, ...extra,
});
const MISS = (miss_reason, target_id, detail = "d") => ({
  kind: "miss", miss_reason, target_id, detail,
});

function policy(ceilings) {
  return {
    name: "journey",
    version: 1,
    safety_ceilings: ceilings || { max_nodes: 100000, max_edges: 200000 },
  };
}

function scope({ repoSet = ["a"], baselines = ["a"], l1Hash = SHA, l2 = [] } = {}) {
  return {
    repoSet: repoSet instanceof Set ? repoSet : new Set(repoSet),
    l0_baselines: baselines.map((r) => ({
      namespace: "ns", logical_repo: r, candidate_id: "c",
      source_revision: "r", canonical_graph_hash: SHA,
    })),
    l1_edge_set_hash: l1Hash,
    l2_bindings: l2,
  };
}

// --- miss bucketing ---------------------------------------------------------

describe("slice-coverage computeCoverage — miss bucketing", () => {
  test("1 bound + 1 gap → no_matching_edge miss; slice still complete", () => {
    const nodes = [NODE("svc:a", "l1", "comprovado"), NODE("svc:b", "l1", "comprovado")];
    const edges = [EDGE("svc:a", "svc:b", "l1", "comprovado")];
    const misses = [MISS("no_matching_edge", "svc:c")];
    const cov = computeCoverage({
      nodes, edges, misses, policy: policy(), scope: scope(), factualStatuses: [],
    });
    assert.equal(cov.counts.by_reason.no_matching_edge, 1);
    assert.equal(cov.counts.misses, 1);
    assert.equal(cov.complete_relative_to_index, true, "gap is a graph fact, not an index gap");
  });

  test("dynamic-dispatch edge → dispatch_uncertainty, NOT unresolved_dispatch miss", () => {
    const nodes = [NODE("svc:a", "l1", "comprovado"), NODE("svc:b", "l1", "comprovado")];
    const edges = [EDGE("svc:a", "svc:b", "l1", "comprovado", "CALLS", { dispatch: "dynamic" })];
    const cov = computeCoverage({
      nodes, edges, misses: [], policy: policy(), scope: scope(), factualStatuses: [],
    });
    assert.equal(cov.dispatch_uncertainty.count, 1);
    assert.equal(cov.dispatch_uncertainty.edges.length, 1);
    assert.equal(
      cov.counts.by_reason.unresolved_dispatch, 0,
      "dynamic-but-resolved is uncertainty, not a miss",
    );
    assert.equal(cov.complete_relative_to_index, true);
  });

  test("dispatch_uncertainty is null when no edge declares dynamic dispatch", () => {
    const nodes = [NODE("svc:a", "l1", "comprovado"), NODE("svc:b", "l1", "comprovado")];
    const edges = [EDGE("svc:a", "svc:b", "l1", "comprovado")];
    const cov = computeCoverage({
      nodes, edges, misses: [], policy: policy(), scope: scope(), factualStatuses: [],
    });
    assert.equal(cov.dispatch_uncertainty, null);
  });

  test("dispatch_uncertainty carries edge identity fields, no timestamps", () => {
    const e = EDGE("a", "b", "l1", "comprovado", "CALLS", { dispatch: "dynamic" });
    const cov = computeCoverage({
      nodes: [NODE("a", "l1", "comprovado")], edges: [e], misses: [],
      policy: policy(), scope: scope(), factualStatuses: [],
    });
    const out = cov.dispatch_uncertainty.edges[0];
    assert.equal(out.from, "a");
    assert.equal(out.to, "b");
    assert.equal(out.relation_type, "CALLS");
    assert.equal(out.layer, "l1");
    // No clock fields smuggled in.
    assert.deepEqual(Object.keys(out).sort(), ["from", "layer", "relation_type", "to"]);
  });
});

// --- counts -----------------------------------------------------------------

describe("slice-coverage computeCoverage — counts", () => {
  test("counts sum nodes/edges/misses and bucket by layer", () => {
    const nodes = [
      NODE("a", "l0", "comprovado"),
      NODE("b", "l0", "comprovado"),
      NODE("c", "l1", "comprovado"),
    ];
    const edges = [
      EDGE("a", "b", "l0", "comprovado"),
      EDGE("b", "c", "l1", "comprovado"),
    ];
    const misses = [MISS("no_matching_edge", "x")];
    const cov = computeCoverage({
      nodes, edges, misses, policy: policy(), scope: scope(), factualStatuses: [],
    });
    assert.equal(cov.counts.nodes, 3);
    assert.equal(cov.counts.edges, 2);
    assert.equal(cov.counts.misses, 1);
    assert.deepEqual({ ...cov.counts.by_layer }, { l0: 2, l1: 1, l2: 0 });
  });

  test("by_status reflects ORIGINAL factualStatuses, never promotes hipótese", () => {
    const factualStatuses = [
      { id: "a", status: "comprovado" },
      { id: "b", status: "comprovado" },
      { id: "c", status: "hipótese" },
    ];
    // Traversal "resolved" the hipótese node — mutated node carries comprovado,
    // but factualStatuses is the indexed truth and MUST win.
    const nodes = [
      NODE("a", "l0", "comprovado"),
      NODE("b", "l0", "comprovado"),
      NODE("c", "l0", "comprovado"),
    ];
    const cov = computeCoverage({
      nodes, edges: [], misses: [], policy: policy(), scope: scope(), factualStatuses,
    });
    assert.equal(cov.counts.by_status.comprovado, 2);
    assert.equal(cov.counts.by_status["hipótese"], 1);
    assert.equal(cov.counts.by_status.contradição, 0);
    assert.equal(cov.counts.by_status.stale, 0);
  });

  test("by_status falls back to node+edge statuses when factualStatuses absent", () => {
    const nodes = [NODE("a", "l0", "stale"), NODE("b", "l0", "contradição")];
    const edges = [EDGE("a", "b", "l0", "comprovado")];
    const cov = computeCoverage({
      nodes, edges, misses: [], policy: policy(), scope: scope(),
    });
    assert.equal(cov.counts.by_status.comprovado, 1);
    assert.equal(cov.counts.by_status.stale, 1);
    assert.equal(cov.counts.by_status.contradição, 1);
  });

  test("explicit empty factualStatuses yields zero counts (NOT fallback)", () => {
    const nodes = [NODE("a", "l0", "comprovado"), NODE("b", "l0", "comprovado")];
    const cov = computeCoverage({
      nodes, edges: [], misses: [], policy: policy(), scope: scope(), factualStatuses: [],
    });
    assert.equal(cov.counts.by_status.comprovado, 0);
    assert.equal(cov.counts.by_status["hipótese"], 0);
    assert.equal(cov.counts.by_status.contradição, 0);
    assert.equal(cov.counts.by_status.stale, 0);
  });

  test("by_reason closed enum initialises all six reasons to zero", () => {
    const cov = computeCoverage({
      nodes: [], edges: [], misses: [], policy: policy(), scope: scope(), factualStatuses: [],
    });
    const expected = [
      "no_matching_edge", "no_accepted_l0", "unresolved_fact_anchor",
      "unresolved_dispatch", "policy_boundary", "index_missing",
    ];
    assert.deepEqual(Object.keys(cov.counts.by_reason).sort(), [...expected].sort());
    for (const r of expected) assert.equal(cov.counts.by_reason[r], 0);
  });

  test("factualStatuses accepts Map and Record shapes", () => {
    const cov1 = computeCoverage({
      nodes: [], edges: [], misses: [], policy: policy(), scope: scope(),
      factualStatuses: new Map([["a", "comprovado"], ["b", "hipótese"]]),
    });
    assert.equal(cov1.counts.by_status.comprovado, 1);
    assert.equal(cov1.counts.by_status["hipótese"], 1);

    const cov2 = computeCoverage({
      nodes: [], edges: [], misses: [], policy: policy(), scope: scope(),
      factualStatuses: { a: "comprovado", b: "contradição" },
    });
    assert.equal(cov2.counts.by_status.comprovado, 1);
    assert.equal(cov2.counts.by_status.contradição, 1);
  });
});

// --- completeness -----------------------------------------------------------

describe("slice-coverage computeCoverage — completeness", () => {
  test("index_missing miss → complete=false", () => {
    const misses = [MISS("index_missing", "svc:x")];
    const cov = computeCoverage({
      nodes: [], edges: [], misses, policy: policy(), scope: scope(), factualStatuses: [],
    });
    assert.equal(cov.complete_relative_to_index, false);
    assert.equal(cov.counts.by_reason.index_missing, 1);
  });

  test("unresolved_fact_anchor miss → complete=false", () => {
    const misses = [MISS("unresolved_fact_anchor", "l0:ff:http_inbound:1")];
    const cov = computeCoverage({
      nodes: [], edges: [], misses, policy: policy(), scope: scope(), factualStatuses: [],
    });
    assert.equal(cov.complete_relative_to_index, false);
    assert.equal(cov.counts.by_reason.unresolved_fact_anchor, 1);
  });

  test("unresolved_dispatch miss → complete=false", () => {
    const misses = [MISS("unresolved_dispatch", "l0:method:hot")];
    const cov = computeCoverage({
      nodes: [], edges: [], misses, policy: policy(), scope: scope(), factualStatuses: [],
    });
    assert.equal(cov.complete_relative_to_index, false);
    assert.equal(cov.counts.by_reason.unresolved_dispatch, 1);
  });

  test("no_accepted_l0 miss → complete=false", () => {
    const misses = [MISS("no_accepted_l0", "svc:y")];
    const cov = computeCoverage({
      nodes: [], edges: [], misses, policy: policy(), scope: scope(), factualStatuses: [],
    });
    assert.equal(cov.complete_relative_to_index, false);
    assert.equal(cov.counts.by_reason.no_accepted_l0, 1);
  });

  test("policy_boundary miss does NOT make slice incomplete", () => {
    const misses = [MISS("policy_boundary", "svc:edge")];
    const cov = computeCoverage({
      nodes: [], edges: [], misses, policy: policy(), scope: scope(), factualStatuses: [],
    });
    assert.equal(cov.complete_relative_to_index, true, "policy_boundary is a policy edge, not an index gap");
    assert.equal(cov.counts.by_reason.policy_boundary, 1);
    assert.equal(cov.policy_boundary_count, 1);
  });

  test("no_matching_edge miss does NOT make slice incomplete", () => {
    const misses = [MISS("no_matching_edge", "svc:gap")];
    const cov = computeCoverage({
      nodes: [], edges: [], misses, policy: policy(), scope: scope(), factualStatuses: [],
    });
    assert.equal(cov.complete_relative_to_index, true, "no_matching_edge is a graph gap, not an index gap");
  });

  test("index_missing + unresolved_dispatch together → complete=false and both reasons listed", () => {
    const misses = [
      MISS("index_missing", "svc:unindexed"),
      MISS("unresolved_dispatch", "l0:method:hot"),
    ];
    const cov = computeCoverage({
      nodes: [], edges: [], misses, policy: policy(), scope: scope(), factualStatuses: [],
    });
    assert.equal(cov.complete_relative_to_index, false);
    assert.equal(cov.counts.by_reason.index_missing, 1);
    assert.equal(cov.counts.by_reason.unresolved_dispatch, 1);
  });

  test("missing baseline (repo in scope without accepted baseline) → complete=false + listed", () => {
    const cov = computeCoverage({
      nodes: [], edges: [], misses: [],
      policy: policy(), scope: scope({ repoSet: ["a", "b"], baselines: ["a"] }),
      factualStatuses: [],
    });
    assert.equal(cov.complete_relative_to_index, false);
    assert.deepEqual(cov.missing_baselines, ["b"]);
  });

  test("missing_baselines accepts Array repoSet and dedups", () => {
    const cov = computeCoverage({
      nodes: [], edges: [], misses: [],
      policy: policy(),
      scope: {
        repoSet: ["b", "a", "b"],
        l0_baselines: [{ logical_repo: "a", namespace: "ns", candidate_id: "c", source_revision: "r", canonical_graph_hash: SHA }],
        l1_edge_set_hash: SHA,
        l2_bindings: [],
      },
      factualStatuses: [],
    });
    assert.deepEqual(cov.missing_baselines, ["b"]);
  });

  test("missing_baselines sorted by raw code-unit compare (uppercase before lowercase)", () => {
    const cov = computeCoverage({
      nodes: [], edges: [], misses: [],
      policy: policy(),
      scope: scope({ repoSet: ["alpha", "Bravo", "charlie"], baselines: [] }),
      factualStatuses: [],
    });
    // Raw code-unit: 'B' (66) < 'a' (97) < 'c' (99) — NOT locale-order.
    assert.deepEqual(cov.missing_baselines, ["Bravo", "alpha", "charlie"]);
  });

  test("safety ceiling exceeded (nodes) → complete=false", () => {
    const nodes = [NODE("a", "l0", "comprovado"), NODE("b", "l0", "comprovado")];
    const cov = computeCoverage({
      nodes, edges: [], misses: [],
      policy: policy({ max_nodes: 1, max_edges: 100000 }),
      scope: scope(), factualStatuses: [],
    });
    assert.equal(cov.complete_relative_to_index, false);
  });

  test("safety ceiling exceeded (edges) → complete=false", () => {
    const cov = computeCoverage({
      nodes: [], edges: [EDGE("a", "b", "l0", "comprovado")], misses: [],
      policy: policy({ max_nodes: 100000, max_edges: 0 }),
      scope: scope(), factualStatuses: [],
    });
    assert.equal(cov.complete_relative_to_index, false);
  });

  test("happy complete-relative-to-index with dispatch_uncertainty", () => {
    const nodes = [
      NODE("svc:a", "l1", "comprovado"),
      NODE("svc:b", "l1", "comprovado"),
      NODE("svc:c", "l1", "comprovado"),
    ];
    const edges = [
      EDGE("svc:a", "svc:b", "l1", "comprovado", "CALLS", { dispatch: "dynamic" }),
      EDGE("svc:b", "svc:c", "l1", "comprovado", "EXPOSES"),
    ];
    const cov = computeCoverage({
      nodes, edges, misses: [], policy: policy(), scope: scope(),
      factualStatuses: [
        { id: "svc:a", status: "comprovado" },
        { id: "svc:b", status: "comprovado" },
        { id: "svc:c", status: "comprovado" },
      ],
    });
    assert.equal(cov.complete_relative_to_index, true);
    assert.equal(cov.dispatch_uncertainty.count, 1);
    assert.equal(cov.dispatch_uncertainty.edges[0].from, "svc:a");
    assert.equal(cov.policy_boundary_count, 0);
    assert.deepEqual(cov.missing_baselines, []);
  });

  test("failure case: index_missing + unresolved_dispatch (acceptance requirement)", () => {
    const misses = [
      MISS("index_missing", "svc:unindexed"),
      MISS("unresolved_dispatch", "l0:method:hot:choosePartner"),
    ];
    const cov = computeCoverage({
      nodes: [NODE("a", "l0", "comprovado")], edges: [], misses,
      policy: policy(), scope: scope(), factualStatuses: [{ id: "a", status: "comprovado" }],
    });
    assert.equal(cov.complete_relative_to_index, false);
    assert.equal(cov.counts.by_reason.index_missing, 1);
    assert.equal(cov.counts.by_reason.unresolved_dispatch, 1);
    assert.equal(cov.counts.misses, 2);
  });
});

// --- provenance -------------------------------------------------------------

describe("slice-coverage computeCoverage — provenance", () => {
  test("provenance carries l0_baselines, l1_edge_set_hash and l2_bindings", () => {
    const l2 = [{ journey_id: "l2:journey:j1", bind_id: "l2:bind:b1", journey_hash: "b".repeat(32) }];
    const cov = computeCoverage({
      nodes: [], edges: [], misses: [],
      policy: policy(), scope: scope({ l2 }),
      factualStatuses: [],
    });
    assert.equal(cov.provenance.l0_baselines.length, 1);
    assert.equal(cov.provenance.l0_baselines[0].logical_repo, "a");
    assert.equal(cov.provenance.l1_edge_set_hash, SHA);
    assert.equal(cov.provenance.l2_bindings.length, 1);
    assert.equal(cov.provenance.l2_bindings[0].journey_id, "l2:journey:j1");
  });

  test("coverage object shape matches Todo 1 contract fields", () => {
    const cov = computeCoverage({
      nodes: [NODE("a", "l0", "comprovado")],
      edges: [], misses: [],
      policy: policy(), scope: scope(), factualStatuses: [],
    });
    const expectedKeys = [
      "counts", "complete_relative_to_index", "dispatch_uncertainty",
      "policy_boundary_count", "missing_baselines", "provenance",
    ].sort();
    assert.deepEqual(Object.keys(cov).sort(), expectedKeys);
    const expectedCountKeys = ["nodes", "edges", "misses", "by_layer", "by_status", "by_reason"].sort();
    assert.deepEqual(Object.keys(cov.counts).sort(), expectedCountKeys);
    const expectedReasons = [
      "no_matching_edge", "no_accepted_l0", "unresolved_fact_anchor",
      "unresolved_dispatch", "policy_boundary", "index_missing",
    ].sort();
    assert.deepEqual(Object.keys(cov.counts.by_reason).sort(), expectedReasons);
  });

  test("provenance has empty defaults when scope is undefined", () => {
    const cov = computeCoverage({
      nodes: [], edges: [], misses: [], policy: policy(),
      factualStatuses: [],
    });
    assert.deepEqual(cov.provenance.l0_baselines, []);
    assert.equal(cov.provenance.l1_edge_set_hash, "");
    assert.deepEqual(cov.provenance.l2_bindings, []);
    assert.deepEqual(cov.missing_baselines, []);
  });

  test("coverage output carries no timestamp/clock fields anywhere", () => {
    const cov = computeCoverage({
      nodes: [NODE("a", "l0", "comprovado")],
      edges: [EDGE("a", "b", "l0", "comprovado")],
      misses: [MISS("no_matching_edge", "x")],
      policy: policy(),
      scope: scope(),
      factualStatuses: [{ id: "a", status: "comprovado" }],
    });
    const json = JSON.stringify(cov);
    assert.ok(!/_(at|ms|time)"/.test(json), "no clock fields in coverage JSON: " + json);
    assert.ok(!/"created_at"|"updated_at"|"materialization_ms"|"generated_at"/.test(json));
  });
});
