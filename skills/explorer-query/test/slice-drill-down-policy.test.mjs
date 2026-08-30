/**
 * Tests for slice-traversal-drill-down.mjs (Task 11) — drill-down@1 policy.
 *
 * Acceptance (plan Todo 11):
 *  - hops 0/1/2 enter; hop 3 does NOT enter and generates policy_boundary.
 *  - max_hops=3 produces a different options_hash, derivation identity and
 *    output than max_hops=2.
 *  - input order (relations/seeds reshuffled) does NOT change output bytes.
 *
 * Plan-locked invariants (Scope #5, drill-down card):
 *  - EXPOSES and CALLS forward only; reverse and UNKNOWN never enter.
 *  - max_hops=2 default; max_hops is an explicit option that enters
 *    options_hash; a frontier reached at the hop limit becomes a
 *    `policy_boundary` miss, NEVER silent truncation.
 *  - distance per node is tracked (sibling `distances` map, mirroring the
 *    impact adapter's `classification` sibling — node schema stays
 *    closed-shape per context-slice.schema.json).
 *  - Pack budgets are NEVER used to stop traversal (adapter takes no budget).
 *  - visited-set by stable record ID; cyclic graphs terminate.
 *  - canonical ordering via raw code-unit compare; never localeCompare.
 *
 * Hermetic: synthetic relations/edges/anchors; no DB, filesystem, or network.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveAnchors } from "../src/slice-anchor-resolver.mjs";
import {
  traverseForward,
  materializeJourneySlice,
  materializeImpactSlice,
} from "../src/slice-traversal.mjs";
import { materializeDrillDownSlice } from "../src/slice-traversal-drill-down.mjs";
import { getPolicy, normalizeOptions, optionsHash } from "../src/slice-policies.mjs";
import { stableStringify } from "../../explorer-l0/src/stable-json.mjs";

const NS = "ns";
const DRILL_DOWN_POLICY = getPolicy("drill-down", 1);

// --- hermetic fixture factories (mirror journey/impact test patterns) -------

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
    source_engine: {
      name: "t",
      profile: "p",
      adapter_version: "1",
      artifact_manifest_id: "manifest:t",
    },
    evidence: [
      {
        kind: "artifact",
        manifest_id: "manifest:t",
        artifact_path: "src/a.ts",
        content_sha256: "a".repeat(64),
        range: { start_line: 1, end_line: 2 },
      },
    ],
  };
}

function record(id, name, status = "comprovado") {
  return { id, namespace: NS, type: "method", name, status, attributes: {} };
}

function ffMap(entries) {
  return new Map(entries);
}

function l0Seed(fact_id, repo = "svc-a") {
  return { kind: "l0_fact", namespace: NS, logical_repo: repo, fact_id };
}

/** Drill-down policy with explicit max_hops override (default = card itself). */
function drillPolicy(maxHops) {
  if (maxHops === undefined) return DRILL_DOWN_POLICY;
  return { ...DRILL_DOWN_POLICY, max_hops: maxHops };
}

/**
 * Linear chain fixture: svc EXPOSES m1, m1 CALLS m2, m2 CALLS m3, m3 CALLS m4.
 * Seed = svc (hop 0). With max_hops=2: m1=hop1, m2=hop2 IN; m3=hop3 OUT.
 */
function chainFixture() {
  const ff = ffMap([
    ["ff:svc", ["r:svc"]],
    ["ff:m1", ["r:m1"]],
    ["ff:m2", ["r:m2"]],
    ["ff:m3", ["r:m3"]],
    ["ff:m4", ["r:m4"]],
  ]);
  const relations = [
    rel("rel:svc-m1", "r:svc", "EXPOSES", "r:m1"),
    rel("rel:m1-m2", "r:m1", "CALLS", "r:m2"),
    rel("rel:m2-m3", "r:m2", "CALLS", "r:m3"),
    rel("rel:m3-m4", "r:m3", "CALLS", "r:m4"),
  ];
  const records = [
    record("r:svc", "BillingService"),
    record("r:m1", "handleCharge"),
    record("r:m2", "validateCard"),
    record("r:m3", "saveReceipt"),
    record("r:m4", "notifyERP"),
  ];
  return { ff, relations, records };
}

/** Resolve a single l0_fact seed via the anchor resolver. */
function resolve(ff, factId, repo = "svc-a") {
  return resolveAnchors({
    seeds: [l0Seed(factId, repo)],
    frontierFacts: ff,
    scope: { edges: [], l2Bindings: [] },
  });
}

// --- characterization: Todo 9/10 unchanged ---------------------------------

describe("characterization — Todo 9/10 adapters unchanged", () => {
  test("traverseForward core still follows forward CALLS", () => {
    const { visitedIds, followedRelations } = traverseForward({
      seedRecordIds: ["r:a"],
      relations: [rel("rel:1", "r:a", "CALLS", "r:b")],
      allowlist: new Set(["CALLS", "EXPOSES"]),
    });
    assert.deepEqual([...visitedIds].sort(cmp), ["r:a", "r:b"]);
    assert.equal(followedRelations.length, 1);
  });

  test("materializeJourneySlice still produces nodes/edges/misses", () => {
    const ff = ffMap([["ff:a", ["r:a"]]]);
    const { anchors, misses } = resolve(ff, "ff:a");
    const result = materializeJourneySlice({
      anchors,
      anchorMisses: misses,
      relations: [rel("rel:ab", "r:a", "CALLS", "r:b")],
      records: [record("r:a", "A"), record("r:b", "B")],
      l1Edges: [],
      policy: getPolicy("journey", 1),
    });
    assert.equal(result.nodes.length, 2);
    assert.equal(result.edges.length, 1);
  });

  test("materializeImpactSlice still classifies seed", () => {
    const ff = ffMap([["ff:a", ["r:a"]]]);
    const { anchors } = resolve(ff, "ff:a");
    const result = materializeImpactSlice({
      anchors,
      anchorMisses: [],
      relations: [],
      records: [record("r:a", "A")],
      l1Edges: [],
      l2Bindings: [],
      frontierFacts: ff,
      policy: getPolicy("impact", 1),
    });
    assert.equal(result.classification["r:a"], "seed");
  });
});

// --- drill-down@1: hop semantics -------------------------------------------

describe("materializeDrillDownSlice — hop 0/1/2 in, hop 3 boundary (default max_hops=2)", () => {
  test("linear chain: svc, m1, m2 visited; m3 is policy_boundary; m4 unreached", () => {
    const { ff, relations, records } = chainFixture();
    const { anchors, misses } = resolve(ff, "ff:svc");
    const result = materializeDrillDownSlice({
      anchors,
      anchorMisses: misses,
      relations,
      records,
      l1Edges: [],
      policy: drillPolicy(),
    });

    const visited = result.nodes.map((n) => n.id).sort(cmp);
    assert.deepEqual(visited, ["r:m1", "r:m2", "r:svc"], "hops 0,1,2 only");

    const boundaries = result.misses.filter((m) => m.miss_reason === "policy_boundary");
    assert.equal(boundaries.length, 1, "exactly one boundary for hop 3");
    assert.equal(boundaries[0].target_id, "r:m3");
    assert.equal(boundaries[0].kind, "miss");
    assert.ok(
      boundaries[0].detail.includes("max_hops=2"),
      "boundary detail references the hop limit",
    );

    // m4 is never reached (m3 not visited → its adjacency never processed).
    const allTargets = result.misses.map((m) => m.target_id);
    assert.ok(!allTargets.includes("r:m4"), "m4 is not mentioned at all");

    // Distances sibling map.
    assert.equal(result.distances["r:svc"], 0);
    assert.equal(result.distances["r:m1"], 1);
    assert.equal(result.distances["r:m2"], 2);
    assert.equal(result.distances["r:m3"], undefined, "m3 not in distances");
  });

  test("seed at hop 0 always included even with no forward edges", () => {
    const ff = ffMap([["ff:lonely", ["r:lonely"]]]);
    const { anchors, misses } = resolve(ff, "ff:lonely");
    const result = materializeDrillDownSlice({
      anchors,
      anchorMisses: misses,
      relations: [],
      records: [record("r:lonely", "Lonely")],
      l1Edges: [],
      policy: drillPolicy(),
    });
    assert.deepEqual(result.nodes.map((n) => n.id), ["r:lonely"]);
    assert.equal(result.distances["r:lonely"], 0);
    assert.equal(result.misses.length, 0);
  });
});

describe("materializeDrillDownSlice — max_hops=3 changes output", () => {
  test("max_hops=3 includes hop 3 (m3) and moves the boundary to hop 4 (m4)", () => {
    const { ff, relations, records } = chainFixture();
    const { anchors, misses } = resolve(ff, "ff:svc");
    const result = materializeDrillDownSlice({
      anchors,
      anchorMisses: misses,
      relations,
      records,
      l1Edges: [],
      policy: drillPolicy(3),
    });

    const visited = result.nodes.map((n) => n.id).sort(cmp);
    assert.deepEqual(visited, ["r:m1", "r:m2", "r:m3", "r:svc"], "hops 0,1,2,3");

    // m3 is no longer a boundary target — it is visited within hops.
    const boundaries = result.misses.filter((m) => m.miss_reason === "policy_boundary");
    assert.equal(boundaries.length, 1, "exactly one boundary, now for hop 4");
    assert.equal(boundaries[0].target_id, "r:m4", "m4 is the new hop-4 boundary");
    assert.ok(boundaries[0].detail.includes("max_hops=3"));

    assert.equal(result.distances["r:m3"], 3);
    assert.equal(result.distances["r:m4"], undefined, "m4 not in distances");
  });

  test("options_hash differs for max_hops=2 vs max_hops=3 (policy identity)", () => {
    const opts2 = normalizeOptions("drill-down", { max_hops: 2 });
    const opts3 = normalizeOptions("drill-down", { max_hops: 3 });
    const hash2 = optionsHash("drill-down", 1, opts2);
    const hash3 = optionsHash("drill-down", 1, opts3);
    assert.notEqual(hash2, hash3, "different max_hops => different options_hash");
    assert.match(hash2, /^[a-f0-9]{64}$/);
    assert.match(hash3, /^[a-f0-9]{64}$/);
  });

  test("max_hops=2 vs max_hops=3 produce different slice bytes", () => {
    const { ff, relations, records } = chainFixture();
    const { anchors, misses } = resolve(ff, "ff:svc");

    const r2 = materializeDrillDownSlice({
      anchors, anchorMisses: misses, relations, records, l1Edges: [], policy: drillPolicy(2),
    });
    const r3 = materializeDrillDownSlice({
      anchors, anchorMisses: misses, relations, records, l1Edges: [], policy: drillPolicy(3),
    });
    assert.notEqual(
      stableStringify(r2),
      stableStringify(r3),
      "max_hops change MUST alter the materialized slice",
    );
  });
});

// --- drill-down@1: determinism (input order independence) -------------------

describe("materializeDrillDownSlice — input order does not change bytes", () => {
  test("shuffled relations produce byte-identical output", () => {
    const { ff, relations, records } = chainFixture();
    const { anchors, misses } = resolve(ff, "ff:svc");

    // Reverse the relations array — adjacency build + sort must normalize.
    const reversedRelations = [...relations].reverse();
    const r1 = materializeDrillDownSlice({
      anchors, anchorMisses: misses, relations, records, l1Edges: [], policy: drillPolicy(),
    });
    const r2 = materializeDrillDownSlice({
      anchors, anchorMisses: misses,
      relations: reversedRelations, records, l1Edges: [], policy: drillPolicy(),
    });
    assert.equal(stableStringify(r1), stableStringify(r2));
  });

  test("same input twice produces byte-identical output (no clock drift)", () => {
    const { ff, relations, records } = chainFixture();
    const { anchors, misses } = resolve(ff, "ff:svc");
    const args = { anchors, anchorMisses: misses, relations, records, l1Edges: [], policy: drillPolicy() };
    const r1 = materializeDrillDownSlice(args);
    const r2 = materializeDrillDownSlice(args);
    assert.equal(stableStringify(r1), stableStringify(r2));
  });
});

// --- drill-down@1: relation invariants -------------------------------------

describe("materializeDrillDownSlice — forward allowlist enforced", () => {
  test("EXPOSES forward is followed", () => {
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:b", ["r:b"]]]);
    const { anchors, misses } = resolve(ff, "ff:a");
    const result = materializeDrillDownSlice({
      anchors, anchorMisses: misses,
      relations: [rel("rel:ab", "r:a", "EXPOSES", "r:b")],
      records: [record("r:a", "A"), record("r:b", "B")],
      l1Edges: [],
      policy: drillPolicy(),
    });
    assert.ok(result.nodes.map((n) => n.id).includes("r:b"));
    assert.equal(result.distances["r:b"], 1);
  });

  test("CALLS forward is followed", () => {
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:b", ["r:b"]]]);
    const { anchors, misses } = resolve(ff, "ff:a");
    const result = materializeDrillDownSlice({
      anchors, anchorMisses: misses,
      relations: [rel("rel:ab", "r:a", "CALLS", "r:b")],
      records: [record("r:a", "A"), record("r:b", "B")],
      l1Edges: [],
      policy: drillPolicy(),
    });
    assert.ok(result.nodes.map((n) => n.id).includes("r:b"));
    assert.equal(result.distances["r:b"], 1);
  });

  test("reverse relation is NOT followed (forward-only)", () => {
    // Edge B->A exists; seed=A. The edge is incoming to A; we never examine
    // incoming edges (forward-only adjacency on from_record).
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:b", ["r:b"]]]);
    const { anchors, misses } = resolve(ff, "ff:a");
    const result = materializeDrillDownSlice({
      anchors, anchorMisses: misses,
      relations: [rel("rel:ba", "r:b", "CALLS", "r:a")],
      records: [record("r:a", "A"), record("r:b", "B")],
      l1Edges: [],
      policy: drillPolicy(),
    });
    assert.deepEqual(result.nodes.map((n) => n.id), ["r:a"]);
    assert.equal(result.misses.length, 0, "no boundary — reverse edge never examined");
  });

  test("UNKNOWN relation does NOT enter — policy_boundary emitted, not silent", () => {
    const ff = ffMap([["ff:a", ["r:a"]], ["ff:c", ["r:c"]]]);
    const { anchors, misses } = resolve(ff, "ff:a");
    const result = materializeDrillDownSlice({
      anchors, anchorMisses: misses,
      relations: [rel("rel:ac", "r:a", "UNKNOWN", "r:c")],
      records: [record("r:a", "A"), record("r:c", "C")],
      l1Edges: [],
      policy: drillPolicy(),
    });
    assert.deepEqual(result.nodes.map((n) => n.id), ["r:a"]);
    const boundaries = result.misses.filter((m) => m.miss_reason === "policy_boundary");
    assert.equal(boundaries.length, 1);
    assert.equal(boundaries[0].target_id, "r:c");
    assert.ok(boundaries[0].detail.includes("UNKNOWN"));
  });

  test("cyclic graph terminates — each node visited once", () => {
    const ff = ffMap([
      ["ff:a", ["r:a"]],
      ["ff:b", ["r:b"]],
      ["ff:c", ["r:c"]],
    ]);
    const { anchors, misses } = resolve(ff, "ff:a");
    const result = materializeDrillDownSlice({
      anchors, anchorMisses: misses,
      relations: [
        rel("rel:ab", "r:a", "CALLS", "r:b"),
        rel("rel:bc", "r:b", "CALLS", "r:c"),
        rel("rel:ca", "r:c", "CALLS", "r:a"),
      ],
      records: [record("r:a", "A"), record("r:b", "B"), record("r:c", "C")],
      l1Edges: [],
      policy: drillPolicy(),
    });
    const ids = result.nodes.map((n) => n.id);
    assert.equal(ids.length, new Set(ids).size, "no duplicate nodes");
    assert.deepEqual(ids, [...ids].sort(cmp), "canonical order");
  });
});

// --- drill-down@1: contract shape & misses ---------------------------------

describe("materializeDrillDownSlice — contract shape and anchor misses", () => {
  test("unresolved anchor forwards miss without inventing nodes", () => {
    const ff = ffMap([]);
    const { anchors, misses } = resolve(ff, "ff:ghost");
    const result = materializeDrillDownSlice({
      anchors, anchorMisses: misses,
      relations: [], records: [], l1Edges: [],
      policy: drillPolicy(),
    });
    assert.equal(result.nodes.length, 0);
    const unresolved = result.misses.filter((m) => m.miss_reason === "unresolved_fact_anchor");
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].target_id, "ff:ghost");
  });

  test("every node has exactly {kind,id,label,layer,status} (closed schema)", () => {
    const { ff, relations, records } = chainFixture();
    const { anchors, misses } = resolve(ff, "ff:svc");
    const result = materializeDrillDownSlice({
      anchors, anchorMisses: misses, relations, records, l1Edges: [],
      policy: drillPolicy(),
    });
    for (const n of result.nodes) {
      assert.equal(n.kind, "node");
      assert.ok(typeof n.id === "string" && n.id.includes(":"));
      assert.ok(typeof n.label === "string" && n.label.length > 0);
      assert.ok(["l0", "l1", "l2"].includes(n.layer));
      assert.ok(["comprovado", "hipótese", "contradição", "stale"].includes(n.status));
      // distance is NOT on the node — it's a sibling map (schema stays closed).
      assert.ok(!("distance" in n), "node must not carry 'distance' (schema-preserved)");
      const keys = Object.keys(n).sort(cmp);
      assert.deepEqual(keys, ["id", "kind", "label", "layer", "status"]);
    }
  });

  test("every edge conforms to the contract; L0 followed edges only (no L1 in scope here)", () => {
    const { ff, relations, records } = chainFixture();
    const { anchors, misses } = resolve(ff, "ff:svc");
    const result = materializeDrillDownSlice({
      anchors, anchorMisses: misses, relations, records, l1Edges: [],
      policy: drillPolicy(),
    });
    for (const e of result.edges) {
      assert.equal(e.kind, "edge");
      assert.ok(typeof e.from === "string" && e.from.includes(":"));
      assert.ok(typeof e.to === "string" && e.to.includes(":"));
      assert.ok(["EXPOSES", "CALLS", "cross_service"].includes(e.relation_type));
      assert.ok(["l0", "l1", "l2"].includes(e.layer));
      assert.ok(["comprovado", "hipótese", "contradição", "stale"].includes(e.status));
    }
    // No L1 edges in scope (pure L0 drill-down).
    assert.equal(result.edges.filter((e) => e.layer === "l1").length, 0);
  });

  test("every miss has {kind,miss_reason,target_id,detail} and closed reason", () => {
    const { ff, relations, records } = chainFixture();
    const { anchors, misses } = resolve(ff, "ff:svc");
    const result = materializeDrillDownSlice({
      anchors, anchorMisses: misses, relations, records, l1Edges: [],
      policy: drillPolicy(),
    });
    for (const m of result.misses) {
      assert.equal(m.kind, "miss");
      assert.ok(
        ["no_matching_edge", "no_accepted_l0", "unresolved_fact_anchor",
          "unresolved_dispatch", "policy_boundary", "index_missing"].includes(m.miss_reason),
      );
      assert.ok(typeof m.target_id === "string" && m.target_id.includes(":"));
      assert.ok(typeof m.detail === "string" && m.detail.length > 0);
    }
  });
});

// --- drill-down@1: no Pack budget stops traversal --------------------------

describe("materializeDrillDownSlice — Pack budget never stops traversal", () => {
  test("adapter accepts no budget argument; max_hops is the only stop condition", () => {
    const { ff, relations, records } = chainFixture();
    const { anchors, misses } = resolve(ff, "ff:svc");
    // No budget field passed anywhere — proves the adapter signature is budget-free.
    const result = materializeDrillDownSlice({
      anchors,
      anchorMisses: misses,
      relations,
      records,
      l1Edges: [],
      policy: drillPolicy(),
    });
    assert.ok(!("budget" in result) && !("max_chars" in result) && !("max_nodes" in result));
    assert.ok(result.nodes.length >= 3, "traversal not budget-capped");
  });
});
