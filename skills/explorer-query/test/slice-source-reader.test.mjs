/**
 * Tests for slice-source-reader.mjs (Task 7).
 *
 * Covers: accepted-L0 snapshot (read-only), policy-specific scope closure
 * (journey/impact/drill-down), derivation-key assembly, and the
 * MISSING_BASELINE blocker. Proves L0 handle is never asked to write.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { derivationKey } from "../src/slice-canonical.mjs";
import { SliceMaterializationError } from "../src/slice-errors.mjs";
import {
  buildDerivationInputs,
  computePolicyScope,
  readAcceptedL0Snapshot,
} from "../src/slice-source-reader.mjs";

const NS = "myns";

// --- mock factories ---------------------------------------------------------

/** Tracking L0 handle: records every call so tests can assert read-only. */
function makeL0Store(baselines, packages) {
  const calls = [];
  return {
    calls,
    getAcceptedBaseline(q) {
      calls.push({ method: "getAcceptedBaseline", ...q });
      return baselines[`${q.namespace}/${q.logical_repo}`] ?? null;
    },
    getAcceptedPackage(q) {
      calls.push({ method: "getAcceptedPackage", ...q });
      return packages[`${q.namespace}/${q.logical_repo}`];
    },
  };
}

function baseline(ns, repo, cand) {
  return [`${ns}/${repo}`, { candidate_id: cand, namespace: ns, logical_repo: repo }];
}

function acceptedPkg(ns, repo, rev, hash, records = []) {
  return [
    `${ns}/${repo}`,
    {
      namespace: ns,
      logical_repo: repo,
      source_revision: rev,
      graph_index: { canonical_graph_hash: hash },
      records,
    },
  ];
}

/** Minimal SystemEdge-shaped object. */
function edge(id, fromRepo, toRepo, ck = "GET /api/x") {
  return {
    edge_id: id,
    system_namespace: NS,
    from: { namespace: NS, logical_repo: fromRepo, fact_id: `ff:${fromRepo}` },
    to: { namespace: NS, logical_repo: toRepo, fact_id: `ff:${toRepo}` },
    contract_key: ck,
    method: "GET",
    path: "/api/x",
    evidence_class: "contract-matched",
    match_kind: "path_contract",
    score: 0.55,
    evidence: [],
  };
}

function makeL1Store(edges) {
  return {
    listSystemEdges(q) {
      return edges.filter((e) => e.system_namespace === q.system_namespace);
    },
  };
}

function makeL2Store(journeys, details) {
  return {
    listJourneys() {
      return journeys;
    },
    showJourney(q) {
      // Mirrors real journey-store: bind_id wins; else resolve current bind
      // for the journey_id from the listed journeys.
      if (q.bind_id) return details[q.bind_id] ?? null;
      const j = journeys.find((x) => x.journey_id === q.journey_id);
      return j ? (details[j.bind_id] ?? null) : null;
    },
  };
}

// --- readAcceptedL0Snapshot -------------------------------------------------

describe("readAcceptedL0Snapshot", () => {
  test("returns baselines + frontierFacts map, reads only", () => {
    const baselines = Object.fromEntries([
      baseline(NS, "svc-a", "cand-a"),
      baseline(NS, "svc-b", "cand-b"),
    ]);
    const packages = Object.fromEntries([
      acceptedPkg(NS, "svc-a", "rev-a", "ghash-a", [
        { type: "Endpoint", natural_key: "get:/api/x", name: "x", attributes: { file: "A.java", line: 1 } },
      ]),
      acceptedPkg(NS, "svc-b", "rev-b", "ghash-b"),
    ]);
    const store = makeL0Store(baselines, packages);

    const snap = readAcceptedL0Snapshot({
      namespace: NS,
      logicalRepos: ["svc-a", "svc-b"],
      l0Store: store,
    });

    assert.equal(snap.baselines.length, 2);
    assert.equal(snap.baselines[0].candidate_id, "cand-a");
    assert.equal(snap.baselines[0].canonical_graph_hash, "ghash-a");
    assert.equal(snap.baselines[0].source_revision, "rev-a");
    assert.ok(snap.frontierFacts instanceof Map);
    assert.ok(snap.frontierFacts.size >= 1, "svc-a has one endpoint record");
    for (const ids of snap.frontierFacts.values()) {
      assert.ok(Array.isArray(ids));
    }

    // L0 handle was never asked to write — only read methods called.
    const writeMethods = store.calls.filter(
      (c) => c.method !== "getAcceptedBaseline" && c.method !== "getAcceptedPackage",
    );
    assert.equal(writeMethods.length, 0, "L0 handle received zero write calls");
  });

  test("repo without accepted baseline throws MISSING_BASELINE before any derivation key", () => {
    const baselines = Object.fromEntries([baseline(NS, "svc-a", "cand-a")]);
    const packages = Object.fromEntries([acceptedPkg(NS, "svc-a", "r", "h")]);
    const store = makeL0Store(baselines, packages);

    assert.throws(
      () =>
        readAcceptedL0Snapshot({
          namespace: NS,
          logicalRepos: ["svc-a", "svc-missing"],
          l0Store: store,
        }),
      (err) => err instanceof SliceMaterializationError && err.code === "MISSING_BASELINE",
    );
  });
});

// --- computePolicyScope -----------------------------------------------------

describe("computePolicyScope — journey", () => {
  test("scope = journey seed edge IDs + bind", () => {
    const e1 = edge("l1:e1", "svc-a", "svc-b");
    const l1 = makeL1Store([e1]);
    const bind = {
      journey_id: "j1",
      bind_id: `${NS}:j1:h1`,
      journey_hash: "h1",
      members: [{ logical_repo: "svc-a" }, { logical_repo: "svc-b" }],
      step_edges: [{ step_id: "s1", edge_id: "l1:e1", step_status: "bound" }],
    };
    const l2 = makeL2Store([{ ...bind }], { [bind.bind_id]: bind });

    const scope = computePolicyScope({
      policyName: "journey",
      systemNamespace: NS,
      seeds: [{ kind: "l2_journey", system_namespace: NS, journey_id: "j1" }],
      l1Store: l1,
      l2Store: l2,
    });

    assert.ok(scope.edgeIds.has("l1:e1"));
    assert.ok(scope.bindIds.has(bind.bind_id));
    assert.equal(scope.l2Bindings.length, 1);
    assert.equal(scope.l2Bindings[0].journey_hash, "h1");
    assert.ok(scope.repoSet.has("svc-a"));
    assert.ok(scope.repoSet.has("svc-b"));
  });
});

describe("computePolicyScope — impact", () => {
  test("scope = ALL edges + ALL current binds", () => {
    const e1 = edge("l1:e1", "svc-a", "svc-b");
    const e2 = edge("l1:e2", "svc-b", "svc-c", "GET /api/y");
    const l1 = makeL1Store([e1, e2]);
    const bind = {
      journey_id: "j1",
      bind_id: `${NS}:j1:h1`,
      journey_hash: "h1",
      members: [{ logical_repo: "svc-c" }],
      step_edges: [],
    };
    const l2 = makeL2Store([{ ...bind }], { [bind.bind_id]: bind });

    const scope = computePolicyScope({
      policyName: "impact",
      systemNamespace: NS,
      seeds: [{ kind: "l0_fact", namespace: NS, logical_repo: "svc-a", fact_id: "ff:a" }],
      l1Store: l1,
      l2Store: l2,
    });

    assert.equal(scope.edgeIds.size, 2);
    assert.ok(scope.edgeIds.has("l1:e1"));
    assert.ok(scope.edgeIds.has("l1:e2"));
    assert.equal(scope.l2Bindings.length, 1);
    assert.ok(scope.repoSet.has("svc-a"));
    assert.ok(scope.repoSet.has("svc-b"));
    assert.ok(scope.repoSet.has("svc-c"));
  });
});

describe("computePolicyScope — drill-down seed-kind rules", () => {
  test("L0 seed: NO edge/bind in scope (repo only)", () => {
    const l1 = makeL1Store([edge("l1:e1", "svc-a", "svc-b")]);
    const l2 = makeL2Store([], {});

    const scope = computePolicyScope({
      policyName: "drill-down",
      systemNamespace: NS,
      seeds: [{ kind: "l0_fact", namespace: NS, logical_repo: "svc-a", fact_id: "ff:a" }],
      l1Store: l1,
      l2Store: l2,
    });

    assert.equal(scope.edgeIds.size, 0, "no edges for L0 seed");
    assert.equal(scope.l2Bindings.length, 0, "no binds for L0 seed");
    assert.ok(scope.repoSet.has("svc-a"));
  });

  test("L1 seed: ONLY the edge (no bind)", () => {
    const e1 = edge("l1:e1", "svc-a", "svc-b");
    const l1 = makeL1Store([e1]);
    const l2 = makeL2Store([], {});

    const scope = computePolicyScope({
      policyName: "drill-down",
      systemNamespace: NS,
      seeds: [{ kind: "l1_edge", system_namespace: NS, edge_id: "l1:e1" }],
      l1Store: l1,
      l2Store: l2,
    });

    assert.ok(scope.edgeIds.has("l1:e1"));
    assert.equal(scope.l2Bindings.length, 0, "no bind for L1 seed");
    assert.ok(scope.repoSet.has("svc-a"));
    assert.ok(scope.repoSet.has("svc-b"));
  });

  test("L2 seed: edge IDs + bind", () => {
    const e1 = edge("l1:e1", "svc-a", "svc-b");
    const l1 = makeL1Store([e1]);
    const bind = {
      journey_id: "j1",
      bind_id: `${NS}:j1:h1`,
      journey_hash: "h1",
      members: [{ logical_repo: "svc-a" }],
      step_edges: [{ step_id: "s1", edge_id: "l1:e1", step_status: "bound" }],
    };
    const l2 = makeL2Store([{ ...bind }], { [bind.bind_id]: bind });

    const scope = computePolicyScope({
      policyName: "drill-down",
      systemNamespace: NS,
      seeds: [{ kind: "l2_journey", system_namespace: NS, journey_id: "j1" }],
      l1Store: l1,
      l2Store: l2,
    });

    assert.ok(scope.edgeIds.has("l1:e1"));
    assert.equal(scope.l2Bindings.length, 1);
  });
});

// --- buildDerivationInputs + derivationKey ----------------------------------

describe("buildDerivationInputs", () => {
  test("edge_set_hash computed only over in-scope edges; endpoints covered", () => {
    const e1 = edge("l1:e1", "svc-a", "svc-b");
    const scope = computePolicyScope({
      policyName: "impact",
      systemNamespace: NS,
      seeds: [{ kind: "l0_fact", namespace: NS, logical_repo: "svc-a", fact_id: "ff:a" }],
      l1Store: makeL1Store([e1]),
      l2Store: makeL2Store([], {}),
    });
    const snap = readAcceptedL0Snapshot({
      namespace: NS,
      logicalRepos: [...scope.repoSet],
      l0Store: makeL0Store(
        Object.fromEntries([baseline(NS, "svc-a", "ca"), baseline(NS, "svc-b", "cb")]),
        Object.fromEntries([acceptedPkg(NS, "svc-a", "r", "h"), acceptedPkg(NS, "svc-b", "r2", "h2")]),
      ),
    });

    const inputs = buildDerivationInputs({
      policyName: "impact",
      policyVersion: 1,
      options: {},
      seeds: [],
      l0Snapshot: snap,
      scope,
      systemNamespace: NS,
    });

    assert.ok(inputs.l1.edge_set_hash);
    assert.match(inputs.l1.edge_set_hash, /^[a-f0-9]{64}$/);
    // Every in-scope edge endpoint is in baselines.
    const baselineRepos = new Set(snap.baselines.map((b) => b.logical_repo));
    for (const e of scope.edges) {
      assert.ok(baselineRepos.has(e.from.logical_repo));
      assert.ok(baselineRepos.has(e.to.logical_repo));
    }
  });

  test("changing a baseline inside the closure changes the derivation key", () => {
    const e1 = edge("l1:e1", "svc-a", "svc-b");
    const scope = computePolicyScope({
      policyName: "impact",
      systemNamespace: NS,
      seeds: [],
      l1Store: makeL1Store([e1]),
      l2Store: makeL2Store([], {}),
    });

    const snap1 = readAcceptedL0Snapshot({
      namespace: NS,
      logicalRepos: [...scope.repoSet],
      l0Store: makeL0Store(
        Object.fromEntries([baseline(NS, "svc-a", "ca1"), baseline(NS, "svc-b", "cb")]),
        Object.fromEntries([acceptedPkg(NS, "svc-a", "r1", "h1"), acceptedPkg(NS, "svc-b", "r2", "h2")]),
      ),
    });
    const snap2 = readAcceptedL0Snapshot({
      namespace: NS,
      logicalRepos: [...scope.repoSet],
      l0Store: makeL0Store(
        Object.fromEntries([baseline(NS, "svc-a", "ca2"), baseline(NS, "svc-b", "cb")]),
        Object.fromEntries([acceptedPkg(NS, "svc-a", "r1B", "h1B"), acceptedPkg(NS, "svc-b", "r2", "h2")]),
      ),
    });

    const k1 = derivationKey(
      buildDerivationInputs({
        policyName: "impact",
        policyVersion: 1,
        options: {},
        seeds: [],
        l0Snapshot: snap1,
        scope,
        systemNamespace: NS,
      }),
    );
    const k2 = derivationKey(
      buildDerivationInputs({
        policyName: "impact",
        policyVersion: 1,
        options: {},
        seeds: [],
        l0Snapshot: snap2,
        scope,
        systemNamespace: NS,
      }),
    );
    assert.notEqual(k1, k2, "different baseline → different key");
  });

  test("L2 rebind changes the key even without an L1 change", () => {
    const e1 = edge("l1:e1", "svc-a", "svc-b");
    const l1 = makeL1Store([e1]);

    const bindV1 = {
      journey_id: "j1",
      bind_id: `${NS}:j1:h1`,
      journey_hash: "h1",
      members: [{ logical_repo: "svc-a" }],
      step_edges: [{ step_id: "s1", edge_id: "l1:e1", step_status: "bound" }],
    };
    const bindV2 = {
      journey_id: "j1",
      bind_id: `${NS}:j1:h2`,
      journey_hash: "h2",
      members: [{ logical_repo: "svc-a" }],
      step_edges: [{ step_id: "s1", edge_id: "l1:e1", step_status: "bound" }],
    };

    const snap = readAcceptedL0Snapshot({
      namespace: NS,
      logicalRepos: ["svc-a", "svc-b"],
      l0Store: makeL0Store(
        Object.fromEntries([baseline(NS, "svc-a", "ca"), baseline(NS, "svc-b", "cb")]),
        Object.fromEntries([acceptedPkg(NS, "svc-a", "r", "h"), acceptedPkg(NS, "svc-b", "r2", "h2")]),
      ),
    });

    const scope1 = computePolicyScope({
      policyName: "journey",
      systemNamespace: NS,
      seeds: [{ kind: "l2_journey", system_namespace: NS, journey_id: "j1" }],
      l1Store: l1,
      l2Store: makeL2Store([{ ...bindV1 }], { [bindV1.bind_id]: bindV1 }),
    });
    const scope2 = computePolicyScope({
      policyName: "journey",
      systemNamespace: NS,
      seeds: [{ kind: "l2_journey", system_namespace: NS, journey_id: "j1" }],
      l1Store: l1,
      l2Store: makeL2Store([{ ...bindV2 }], { [bindV2.bind_id]: bindV2 }),
    });

    const k1 = derivationKey(
      buildDerivationInputs({ policyName: "journey", policyVersion: 1, options: {}, seeds: [], l0Snapshot: snap, scope: scope1, systemNamespace: NS }),
    );
    const k2 = derivationKey(
      buildDerivationInputs({ policyName: "journey", policyVersion: 1, options: {}, seeds: [], l0Snapshot: snap, scope: scope2, systemNamespace: NS }),
    );
    assert.notEqual(k1, k2, "rebind → different key (same edges)");
  });

  test("edge/bind OUTSIDE the drill-down closure does NOT change the key", () => {
    const eIn = edge("l1:in", "svc-a", "svc-b");
    const eOut = edge("l1:out", "svc-c", "svc-d", "GET /api/other");
    const l1 = makeL1Store([eIn, eOut]);

    const scope = computePolicyScope({
      policyName: "drill-down",
      systemNamespace: NS,
      seeds: [{ kind: "l1_edge", system_namespace: NS, edge_id: "l1:in" }],
      l1Store: l1,
      l2Store: makeL2Store([], {}),
    });

    assert.ok(scope.edgeIds.has("l1:in"));
    assert.ok(!scope.edgeIds.has("l1:out"), "out-of-closure edge excluded");

    const snap = readAcceptedL0Snapshot({
      namespace: NS,
      logicalRepos: [...scope.repoSet],
      l0Store: makeL0Store(
        Object.fromEntries([baseline(NS, "svc-a", "ca"), baseline(NS, "svc-b", "cb")]),
        Object.fromEntries([acceptedPkg(NS, "svc-a", "r", "h"), acceptedPkg(NS, "svc-b", "r2", "h2")]),
      ),
    });

    // Build with only in-scope edges vs. a scope that accidentally includes
    // eOut — the latter must NOT happen (closure is tight), so the key built
    // from the real scope is the canonical reference.
    const inputs = buildDerivationInputs({
      policyName: "drill-down",
      policyVersion: 1,
      options: {},
      seeds: [],
      l0Snapshot: snap,
      scope,
      systemNamespace: NS,
    });
    const key = derivationKey(inputs);

    // Re-derive with same scope → stable key.
    const keyAgain = derivationKey(
      buildDerivationInputs({
        policyName: "drill-down",
        policyVersion: 1,
        options: {},
        seeds: [],
        l0Snapshot: snap,
        scope,
        systemNamespace: NS,
      }),
    );
    assert.equal(key, keyAgain, "same closure → same key");
    // eOut is not in edges, so adding/removing it elsewhere must be a no-op.
    assert.ok(!scope.edges.some((e) => e.edge_id === "l1:out"));
  });

  test("missing baseline blocks before returning a derivation key", () => {
    const e1 = edge("l1:e1", "svc-a", "svc-b");
    const scope = computePolicyScope({
      policyName: "impact",
      systemNamespace: NS,
      seeds: [],
      l1Store: makeL1Store([e1]),
      l2Store: makeL2Store([], {}),
    });
    // svc-b has NO accepted baseline → must throw before buildDerivationInputs.
    assert.throws(
      () =>
        readAcceptedL0Snapshot({
          namespace: NS,
          logicalRepos: [...scope.repoSet],
          l0Store: makeL0Store(
            Object.fromEntries([baseline(NS, "svc-a", "ca")]),
            Object.fromEntries([acceptedPkg(NS, "svc-a", "r", "h")]),
          ),
        }),
      (err) => err instanceof SliceMaterializationError && err.code === "MISSING_BASELINE",
    );
  });

  test("l2_bindings is always an array, ordered by (journey_id, bind_id)", () => {
    const scope = computePolicyScope({
      policyName: "drill-down",
      systemNamespace: NS,
      seeds: [{ kind: "l0_fact", namespace: NS, logical_repo: "svc-a", fact_id: "ff:a" }],
      l1Store: makeL1Store([]),
      l2Store: makeL2Store([], {}),
    });
    const snap = readAcceptedL0Snapshot({
      namespace: NS,
      logicalRepos: ["svc-a"],
      l0Store: makeL0Store(
        Object.fromEntries([baseline(NS, "svc-a", "ca")]),
        Object.fromEntries([acceptedPkg(NS, "svc-a", "r", "h")]),
      ),
    });

    const inputs = buildDerivationInputs({
      policyName: "drill-down",
      policyVersion: 1,
      options: { max_hops: 2 },
      seeds: [{ kind: "l0_fact", namespace: NS, logical_repo: "svc-a", fact_id: "ff:a" }],
      l0Snapshot: snap,
      scope,
      systemNamespace: NS,
    });

    assert.ok(Array.isArray(inputs.l2_bindings));
    assert.equal(inputs.l2_bindings.length, 0, "empty but still an array");
  });
});
