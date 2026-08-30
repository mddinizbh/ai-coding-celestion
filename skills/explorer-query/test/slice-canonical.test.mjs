import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sha256Text, stableStringify } from "../../explorer-l0/src/stable-json.mjs";
import {
  CANONICAL_PAYLOAD_FIELDS,
  SliceDeterminismError,
  canonicalEdgeId,
  canonicalMissId,
  canonicalNodeId,
  canonicalSlicePayload,
  compareRaw,
  derivationKey,
  edgeSetHash,
  optionsHash,
  projectCanonical,
  seedSetHash,
  sliceHash,
  sortById,
} from "../src/slice-canonical.mjs";

// --- Shared fixtures ---------------------------------------------------------

/** @returns {object[]} seeds in canonical-friendly shape (l0 + l1 + l2) */
function sampleSeeds() {
  return [
    { kind: "l0_fact", namespace: "ns-a", logical_repo: "repo-a", fact_id: "fact-1" },
    { kind: "l1_edge", system_namespace: "ns-sys", edge_id: "edge-2" },
    { kind: "l2_journey", system_namespace: "ns-sys", journey_id: "j-1", bind_id: "b-1" },
  ];
}

function sampleEdges() {
  return [
    { edge_id: "edge-z", system_namespace: "ns-sys", contract_key: "GET /a" },
    { edge_id: "edge-a", system_namespace: "ns-sys", contract_key: "POST /b" },
  ];
}

function sampleBaselines() {
  return [
    {
      namespace: "ns-a",
      logical_repo: "repo-a",
      candidate_id: "cand-1",
      source_revision: "rev-1",
      canonical_graph_hash: "hash-1",
    },
  ];
}

function sampleBindings() {
  return [{ journey_id: "j-1", bind_id: "b-1", journey_hash: "jhash-1" }];
}

/** Base derivation-key struct (per plan Scope Must-have #3). */
function baseDerivationStruct() {
  return {
    engine_version: "explorer@1.0.0",
    slice_schema_version: 1,
    system_namespace: "ns-sys",
    policy: { name: "journey", version: 1, options_hash: optionsHash({ max_hops: 2 }) },
    seeds: sampleSeeds(),
    l0_baselines: sampleBaselines(),
    l1: { system_namespace: "ns-sys", edge_set_hash: edgeSetHash(sampleEdges()) },
    l2_bindings: sampleBindings(),
  };
}

/** Materialized slice payload including an audit envelope sibling. */
function baseMaterialized() {
  return {
    schema_version: 1,
    engine_version: "explorer@1.0.0",
    system_namespace: "ns-sys",
    policy: { name: "journey", version: 1, options_hash: optionsHash({ max_hops: 2 }) },
    seeds: sampleSeeds(),
    seed_set_hash: seedSetHash(sampleSeeds()),
    nodes: [
      { id: "node-b", kind: "record" },
      { id: "node-a", kind: "record" },
    ],
    edges: sampleEdges(),
    edge_set_hash: edgeSetHash(sampleEdges()),
    misses: [{ id: "miss-1", reason: "no_matching_edge" }],
    l0_baselines: sampleBaselines(),
    l1: { system_namespace: "ns-sys", edge_set_hash: edgeSetHash(sampleEdges()) },
    l2_bindings: sampleBindings(),
    coverage: { nodes: 2, edges: 2, misses: 1 },
    // audit envelope (sibling, not canonical):
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
    materialization_ms: 42,
  };
}

// --- Tests -------------------------------------------------------------------

describe("raw compare + sortById", () => {
  test("compareRaw uses code-unit ordering, never localeCompare", () => {
    // 'Z' (U+005A) < 'a' (U+0061) under code-unit compare; localeCompare may differ.
    assert.equal(compareRaw("Z", "a"), -1);
    assert.equal(compareRaw("a", "Z"), 1);
    assert.equal(compareRaw("same", "same"), 0);
  });

  test("sortById is stable ascending by raw ID, never by score", () => {
    const items = [
      { id: "c", score: 0.99 },
      { id: "a", score: 0.1 },
      { id: "b", score: 0.5 },
    ];
    const sorted = sortById(items, canonicalNodeId);
    assert.deepEqual(
      sorted.map((i) => i.id),
      ["a", "b", "c"],
    );
    // original input must not be mutated
    assert.equal(items[0].id, "c");
  });

  test("canonicalEdgeId/canonicalMissId pick the right stable id", () => {
    assert.equal(canonicalEdgeId({ edge_id: "e1" }), "e1");
    assert.equal(canonicalEdgeId({ id: "fallback" }), "fallback");
    assert.equal(canonicalMissId({ id: "m1" }), "m1");
  });
});

describe("proof 1 — clocks do not affect canonical payload or slice hash", () => {
  test("varying created_at/updated_at/materialization_ms yields byte-identical canonical JSON", () => {
    const m1 = baseMaterialized();
    const m2 = {
      ...baseMaterialized(),
      created_at: "2099-12-31T23:59:59.999Z",
      updated_at: "2099-12-31T23:59:59.999Z",
      materialization_ms: 9999,
    };
    const c1 = canonicalSlicePayload(m1);
    const c2 = canonicalSlicePayload(m2);

    // clock fields must be stripped from canonical output
    assert.equal(c1.created_at, undefined);
    assert.equal(c1.updated_at, undefined);
    assert.equal(c1.materialization_ms, undefined);

    const j1 = Buffer.from(stableStringify(c1), "utf8");
    const j2 = Buffer.from(stableStringify(c2), "utf8");
    assert.equal(
      Buffer.compare(j1, j2),
      0,
      "canonical JSON bytes must be identical regardless of clock",
    );
    assert.equal(sliceHash(c1), sliceHash(c2));
    assert.match(sliceHash(c1), /^[0-9a-f]{64}$/);
  });
});

describe("proof 2 — insertion order does not affect hashes", () => {
  test("seedSetHash is stable under seed reordering", () => {
    const a = sampleSeeds();
    const b = [a[2], a[0], a[1]];
    assert.equal(seedSetHash(a), seedSetHash(b));
  });

  test("edgeSetHash is stable under edge reordering and ignores score/created_at", () => {
    const ordered = sampleEdges();
    const shuffled = [
      { ...ordered[1], score: 0.99, created_at: "x" },
      { ...ordered[0], score: 0.1, created_at: "y" },
    ];
    assert.equal(edgeSetHash(ordered), edgeSetHash(shuffled));
  });

  test("derivationKey is stable under seeds/baselines/binds/edges reordering", () => {
    const base = baseDerivationStruct();
    const shuffled = {
      ...base,
      seeds: [...base.seeds].reverse(),
      l0_baselines: [...base.l0_baselines].reverse(),
      l2_bindings: [...base.l2_bindings].reverse(),
      l1: { ...base.l1, edge_set_hash: edgeSetHash([...sampleEdges()].reverse()) },
    };
    assert.equal(derivationKey(base), derivationKey(shuffled));
    assert.match(derivationKey(base), /^[0-9a-f]{64}$/);
  });
});

describe("proof 3 — each derivation-key field isolatedly changes the key", () => {
  const cases = [
    ["engine_version", () => ({ engine_version: "explorer@1.0.1" })],
    ["slice_schema_version", () => ({ slice_schema_version: 2 })],
    ["system_namespace", () => ({ system_namespace: "ns-other" })],
    ["policy.name", () => ({ policy: { name: "impact", version: 1, options_hash: optionsHash({ max_hops: 2 }) } })],
    ["policy.version", () => ({ policy: { name: "journey", version: 2, options_hash: optionsHash({ max_hops: 2 }) } })],
    ["policy.options_hash", () => ({ policy: { name: "journey", version: 1, options_hash: optionsHash({ max_hops: 5 }) } })],
    ["seeds[0].fact_id", () => ({ seeds: [{ kind: "l0_fact", namespace: "ns-a", logical_repo: "repo-a", fact_id: "fact-OTHER" }, ...sampleSeeds().slice(1)] })],
    ["l0_baselines[0].namespace", () => ({ l0_baselines: [{ ...sampleBaselines()[0], namespace: "ns-X" }] })],
    ["l0_baselines[0].logical_repo", () => ({ l0_baselines: [{ ...sampleBaselines()[0], logical_repo: "repo-X" }] })],
    ["l0_baselines[0].candidate_id", () => ({ l0_baselines: [{ ...sampleBaselines()[0], candidate_id: "cand-X" }] })],
    ["l0_baselines[0].source_revision", () => ({ l0_baselines: [{ ...sampleBaselines()[0], source_revision: "rev-X" }] })],
    ["l0_baselines[0].canonical_graph_hash", () => ({ l0_baselines: [{ ...sampleBaselines()[0], canonical_graph_hash: "hash-X" }] })],
    ["l1.system_namespace", () => ({ l1: { system_namespace: "ns-sys-OTHER", edge_set_hash: edgeSetHash(sampleEdges()) } })],
    ["l1.edge_set_hash", () => ({ l1: { system_namespace: "ns-sys", edge_set_hash: edgeSetHash([{ edge_id: "edge-NEW", system_namespace: "ns-sys" }]) } })],
    ["l2_bindings[0].journey_id", () => ({ l2_bindings: [{ ...sampleBindings()[0], journey_id: "j-X" }] })],
    ["l2_bindings[0].bind_id", () => ({ l2_bindings: [{ ...sampleBindings()[0], bind_id: "b-X" }] })],
    ["l2_bindings[0].journey_hash", () => ({ l2_bindings: [{ ...sampleBindings()[0], journey_hash: "jhash-X" }] })],
  ];

  for (const [label, mutator] of cases) {
    test(`changing ${label} produces a different derivation key`, () => {
      const base = baseDerivationStruct();
      const baseKey = derivationKey(base);
      const variant = { ...base, ...mutator() };
      const variantKey = derivationKey(variant);
      assert.notEqual(baseKey, variantKey, `key must change when ${label} changes`);
    });
  }
});

describe("proof 4 — forbidden canonical fields throw SliceDeterminismError", () => {
  test("smuggled generated_at at top-level is rejected", () => {
    const smuggled = { ...baseMaterialized(), generated_at: "2026-01-01T00:00:00.000Z" };
    assert.throws(
      () => canonicalSlicePayload(smuggled),
      (err) => err instanceof SliceDeterminismError && /generated_at/.test(err.message),
    );
  });

  test("unknown top-level field (not audit, not allowlisted) is rejected", () => {
    const bad = { ...baseMaterialized(), surprise_field: "boom" };
    assert.throws(
      () => canonicalSlicePayload(bad),
      SliceDeterminismError,
    );
  });

  test("nested *_at field inside canonical output is rejected (fail-closed)", () => {
    const nested = {
      ...baseMaterialized(),
      nodes: [{ id: "n1", kind: "record", created_at: "2026-01-01T00:00:00.000Z" }],
    };
    assert.throws(
      () => canonicalSlicePayload(nested),
      (err) => err instanceof SliceDeterminismError && /created_at/.test(err.message),
    );
  });

  test("projectCanonical respects a custom allowlist (allowlisted kept, audit dropped, unknown throws)", () => {
    // allowlisted key kept, audit field recognised and dropped
    const out = projectCanonical({ a: 1, created_at: "x" }, new Set(["a"]));
    assert.deepEqual(out, { a: 1 });
    // any non-allowlisted, non-audit key throws (consistent fail-closed)
    assert.throws(
      () => projectCanonical({ a: 1, z: 9 }, new Set(["a"])),
      SliceDeterminismError,
    );
    assert.throws(
      () => projectCanonical({ a: 1, b: 2 }, new Set(["a"])),
      SliceDeterminismError,
    );
  });

  test("CANONICAL_PAYLOAD_FIELDS is a non-empty frozen allowlist", () => {
    assert.ok(CANONICAL_PAYLOAD_FIELDS.size > 0);
    // created_at/updated_at/materialization_ms/score are NOT canonical
    for (const banned of ["created_at", "updated_at", "materialization_ms", "score"]) {
      assert.equal(CANONICAL_PAYLOAD_FIELDS.has(banned), false, `${banned} must not be canonical`);
    }
  });

  test("sliceHash refuses payloads containing clock fields", () => {
    assert.throws(
      () => sliceHash({ ...canonicalSlicePayload(baseMaterialized()), created_at: "x" }),
      SliceDeterminismError,
    );
  });
});

describe("optionsHash + sha256 helper consistency", () => {
  test("optionsHash sorts keys and is order-independent", () => {
    assert.equal(optionsHash({ a: 1, b: 2 }), optionsHash({ b: 2, a: 1 }));
    // matches the underlying sha256Text(stableStringify(...)) exactly
    assert.equal(optionsHash({ a: 1 }), sha256Text(stableStringify({ a: 1 })));
  });
});
