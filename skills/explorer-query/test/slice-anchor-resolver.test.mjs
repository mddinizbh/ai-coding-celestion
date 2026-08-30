/**
 * Tests for slice-anchor-resolver.mjs (Task 8).
 *
 * Proves the three seed kinds resolve to L0 anchor record IDs via the
 * `Map<fact_id, record_id[]>` produced by Todo 7. Anchor resolution is
 * EXPLICIT map lookup only — never file/name similarity. Journey step order
 * and gaps are preserved; every gap becomes a `no_matching_edge` miss.
 *
 * Hermetic: synthetic frontierFacts Map + scope object; no DB, no filesystem.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveAnchors } from "../src/slice-anchor-resolver.mjs";

const NS = "ns";

// --- hermetic fixture factories --------------------------------------------

/** Build a frontierFacts Map<fact_id, record_id[]> from entries. */
function ffMap(entries) {
  return new Map(entries);
}

function l0Seed(fact_id, repo = "svc-a") {
  return { kind: "l0_fact", namespace: NS, logical_repo: repo, fact_id };
}

function l1Seed(edge_id) {
  return { kind: "l1_edge", system_namespace: NS, edge_id };
}

function l2Seed(journey_id, bind_id) {
  const seed = { kind: "l2_journey", system_namespace: NS, journey_id };
  if (bind_id) seed.bind_id = bind_id;
  return seed;
}

/** Minimal SystemEdge-shape object (only the fields the resolver reads). */
function edge(edge_id, fromFact, toFact, fromRepo = "svc-a", toRepo = "svc-b") {
  return {
    edge_id,
    system_namespace: NS,
    from: { namespace: NS, logical_repo: fromRepo, fact_id: fromFact },
    to: { namespace: NS, logical_repo: toRepo, fact_id: toFact },
  };
}

/** l2Bindings entry; step_edges optional (resolver reads it when present). */
function bind(journey_id, bind_id, journey_hash, step_edges = []) {
  return { journey_id, bind_id, journey_hash, step_edges };
}

/** Build a scope object: { edges, l2Bindings }. */
function scope(edges = [], l2Bindings = []) {
  return { edges, l2Bindings };
}

// --- l0_fact seed -----------------------------------------------------------

describe("resolveAnchors — l0_fact", () => {
  test("fact in map → resolved with record_ids", () => {
    const ff = ffMap([["ff:a", ["rec-a1", "rec-a2"]]]);
    const { anchors, misses } = resolveAnchors({
      seeds: [l0Seed("ff:a")],
      frontierFacts: ff,
      scope: scope(),
    });
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].status, "resolved");
    assert.equal(anchors[0].layer, "l0");
    assert.deepEqual(anchors[0].record_ids, ["rec-a1", "rec-a2"]);
    assert.equal(misses.length, 0);
  });

  test("fact NOT in map → miss unresolved_fact_anchor", () => {
    const ff = ffMap([["ff:a", ["rec-a1"]]]);
    const { anchors, misses } = resolveAnchors({
      seeds: [l0Seed("ff:ghost")],
      frontierFacts: ff,
      scope: scope(),
    });
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].status, "miss");
    assert.deepEqual(anchors[0].record_ids, []);
    assert.equal(misses.length, 1);
    assert.equal(misses[0].reason, "unresolved_fact_anchor");
    assert.equal(misses[0].seed.fact_id, "ff:ghost");
  });
});

// --- l1_edge seed -----------------------------------------------------------

describe("resolveAnchors — l1_edge", () => {
  test("both endpoints in map → resolved with union of record_ids, canonical order", () => {
    const e = edge("l1:e1", "ff:from", "ff:to");
    const ff = ffMap([
      ["ff:from", ["rec-from"]],
      ["ff:to", ["rec-to1", "rec-to2"]],
    ]);
    const { anchors, misses } = resolveAnchors({
      seeds: [l1Seed("l1:e1")],
      frontierFacts: ff,
      scope: scope([e]),
    });
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].status, "resolved");
    assert.equal(anchors[0].layer, "l1");
    // Union sorted by raw code-unit compare: "rec-from" < "rec-to1" < "rec-to2".
    assert.deepEqual(anchors[0].record_ids, ["rec-from", "rec-to1", "rec-to2"]);
    assert.equal(misses.length, 0);
  });

  test("one endpoint missing → miss unresolved_fact_anchor", () => {
    const e = edge("l1:e1", "ff:from", "ff:to");
    const ff = ffMap([["ff:from", ["rec-from"]]]); // ff:to absent
    const { anchors, misses } = resolveAnchors({
      seeds: [l1Seed("l1:e1")],
      frontierFacts: ff,
      scope: scope([e]),
    });
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].status, "miss");
    assert.equal(misses.length, 1);
    assert.equal(misses[0].reason, "unresolved_fact_anchor");
    assert.equal(misses[0].detail.fact_id, "ff:to");
  });

  test("edge_id not in scope → miss no_matching_edge", () => {
    const ff = ffMap([["ff:from", ["rec-from"]]]);
    const { anchors, misses } = resolveAnchors({
      seeds: [l1Seed("l1:absent")],
      frontierFacts: ff,
      scope: scope([]), // no edges in scope
    });
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].status, "miss");
    assert.equal(misses.length, 1);
    assert.equal(misses[0].reason, "no_matching_edge");
    assert.equal(misses[0].detail.edge_id, "l1:absent");
  });
});

// --- l2_journey seed --------------------------------------------------------

describe("resolveAnchors — l2_journey", () => {
  test("2 bound steps + 1 gap → 2 resolved steps + 1 gap miss; step order preserved", () => {
    const e1 = edge("l1:e1", "ff:a", "ff:b");
    const e2 = edge("l1:e2", "ff:b", "ff:c");
    const ff = ffMap([
      ["ff:a", ["rec-a"]],
      ["ff:b", ["rec-b"]],
      ["ff:c", ["rec-c"]],
    ]);
    const b = bind("j1", "ns:j1:h1", "h1", [
      { step_id: "s1", edge_id: "l1:e1", step_status: "bound" },
      { step_id: "s2", edge_id: "l1:e2", step_status: "bound" },
      { step_id: "s3", edge_id: "__gap__", step_status: "gap" },
    ]);
    const { anchors, misses } = resolveAnchors({
      seeds: [l2Seed("j1")],
      frontierFacts: ff,
      scope: scope([e1, e2], [b]),
    });

    // 3 step-level anchors in source order.
    assert.equal(anchors.length, 3);
    assert.deepEqual(
      anchors.map((a) => a.step_id),
      ["s1", "s2", "s3"],
      "step order preserved in anchors array",
    );
    assert.equal(anchors[0].status, "resolved");
    assert.equal(anchors[1].status, "resolved");
    assert.equal(anchors[2].status, "miss");
    assert.equal(anchors[2].layer, "l2");
    assert.deepEqual(anchors[2].record_ids, []);

    // The gap step is the only miss.
    assert.equal(misses.length, 1);
    assert.equal(misses[0].reason, "no_matching_edge");
    assert.equal(misses[0].step_id, "s3");
  });

  test("journey seed not found in scope.l2Bindings → miss no_matching_edge", () => {
    // No bind in scope for this journey.
    const { anchors, misses } = resolveAnchors({
      seeds: [l2Seed("j-ghost")],
      frontierFacts: ffMap([]),
      scope: scope([], []),
    });
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].status, "miss");
    assert.equal(misses.length, 1);
    assert.equal(misses[0].reason, "no_matching_edge");
    assert.equal(misses[0].seed.journey_id, "j-ghost");
  });

  test("bound step whose fact is missing → step miss unresolved_fact_anchor", () => {
    const e1 = edge("l1:e1", "ff:a", "ff:ghost");
    const ff = ffMap([["ff:a", ["rec-a"]]]); // ff:ghost absent
    const b = bind("j1", "ns:j1:h1", "h1", [
      { step_id: "s1", edge_id: "l1:e1", step_status: "bound" },
    ]);
    const { anchors, misses } = resolveAnchors({
      seeds: [l2Seed("j1")],
      frontierFacts: ff,
      scope: scope([e1], [b]),
    });
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].status, "miss");
    assert.equal(misses.length, 1);
    assert.equal(misses[0].reason, "unresolved_fact_anchor");
    assert.equal(misses[0].detail.fact_id, "ff:ghost");
  });
});

// --- canonical order + no-heuristic guarantees ------------------------------

describe("resolveAnchors — canonical order & no heuristic matching", () => {
  test("one fact mapped to TWO record_ids → both visited in canonical (raw code-unit) order", () => {
    // Map already canonically sorted by Todo 7: "Z" (0x5A) before "a" (0x61).
    // localeCompare would reverse these; asserting exact order catches that.
    const ff = ffMap([["ff:multi", ["Z", "a"]]]);
    const { anchors } = resolveAnchors({
      seeds: [l0Seed("ff:multi")],
      frontierFacts: ff,
      scope: scope(),
    });
    assert.deepEqual(anchors[0].record_ids, ["Z", "a"]);
  });

  test("similar name never anchors — file/name matching is forbidden", () => {
    // fact_id "method:foo" has NO map entry. A record named "foo" elsewhere
    // must NOT be matched by name similarity. Result: unresolved_fact_anchor.
    const ff = ffMap([["method:bar", ["rec-bar"]]]);
    const { anchors, misses } = resolveAnchors({
      seeds: [l0Seed("method:foo")],
      frontierFacts: ff,
      scope: scope(),
    });
    assert.equal(anchors.length, 1);
    assert.equal(anchors[0].status, "miss");
    assert.equal(misses.length, 1);
    assert.equal(misses[0].reason, "unresolved_fact_anchor");
    // No record was invented by name matching.
    assert.deepEqual(anchors[0].record_ids, []);
  });
});

// --- mixed seeds: end-to-end ordering --------------------------------------

describe("resolveAnchors — mixed seeds preserve seed order", () => {
  test("l0 + l1 + l2 seeds resolved in seed order with correct layers", () => {
    const e = edge("l1:e1", "ff:a", "ff:b");
    const ff = ffMap([
      ["ff:a", ["rec-a"]],
      ["ff:b", ["rec-b"]],
      ["ff:solo", ["rec-solo"]],
    ]);
    const b = bind("j1", "ns:j1:h1", "h1", [
      { step_id: "s1", edge_id: "l1:e1", step_status: "bound" },
    ]);
    const seeds = [l0Seed("ff:solo"), l1Seed("l1:e1"), l2Seed("j1")];
    const { anchors } = resolveAnchors({
      seeds,
      frontierFacts: ff,
      scope: scope([e], [b]),
    });
    // l0 → 1 anchor; l1 → 1 anchor; l2 → 1 anchor per step (1 step).
    assert.equal(anchors.length, 3);
    assert.deepEqual(anchors.map((a) => a.layer), ["l0", "l1", "l2"]);
  });
});
