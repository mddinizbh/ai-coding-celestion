import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openSliceStore } from "../src/slice-store.mjs";
import { SliceCollisionError, SliceStoreError } from "../src/slice-errors.mjs";
import {
  canonicalSlicePayload,
  sliceHash,
  seedSetHash,
  optionsHash,
  edgeSetHash,
} from "../src/slice-canonical.mjs";
import { stableStringify } from "../../explorer-l0/src/stable-json.mjs";

// --- Fixtures ----------------------------------------------------------------

/** @returns {object[]} three seed kinds (l0_fact / l1_edge / l2_journey) */
function sampleSeeds() {
  return [
    { kind: "l0_fact", namespace: "ns-a", logical_repo: "repo-a", fact_id: "fact-1" },
    { kind: "l1_edge", system_namespace: "ns-sys", edge_id: "edge-2" },
    {
      kind: "l2_journey",
      system_namespace: "ns-sys",
      journey_id: "j-1",
      bind_id: "b-1",
    },
  ];
}

function sampleNodes() {
  return [
    { id: "node-b", kind: "record", logical_repo: "repo-a" },
    { id: "node-a", kind: "record", logical_repo: "repo-a" },
  ];
}

function sampleEdges() {
  return [
    { edge_id: "edge-z", system_namespace: "ns-sys", contract_key: "GET /a", from: "node-a", to: "node-b" },
    { edge_id: "edge-a", system_namespace: "ns-sys", contract_key: "POST /b", from: "node-b", to: "node-a" },
  ];
}

function sampleMisses() {
  return [{ id: "miss-1", reason: "no_matching_edge", detail: {} }];
}

function sampleBaselines() {
  return [
    {
      namespace: "ns-a",
      logical_repo: "repo-a",
      candidate_id: "cand-1",
      source_revision: "rev-1",
      canonical_graph_hash: "h-1",
    },
  ];
}

function sampleBindings() {
  return [{ journey_id: "j-1", bind_id: "b-1", journey_hash: "jh-1" }];
}

/**
 * Build a canonical-shape materialized payload. Contains every allowlisted
 * canonical field; NO clocks (those live in the audit envelope sibling).
 */
function buildCanonicalPayload() {
  const seeds = sampleSeeds();
  const nodes = sampleNodes();
  const edges = sampleEdges();
  const misses = sampleMisses();
  return {
    schema_version: 1,
    engine_version: "context-slice-engine/v2",
    system_namespace: "ns-sys",
    policy: { name: "journey", version: 1, options_hash: optionsHash({}) },
    seeds,
    seed_set_hash: seedSetHash(seeds),
    nodes,
    edges,
    edge_set_hash: edgeSetHash(edges),
    misses,
    l0_baselines: sampleBaselines(),
    l1: { system_namespace: "ns-sys", edge_set_hash: edgeSetHash(edges) },
    l2_bindings: sampleBindings(),
    coverage: { nodes: nodes.length, edges: edges.length, misses: misses.length },
  };
}

/**
 * Build a persist input whose canonical payload is already canonicalized and
 * whose sliceHash matches sliceHash(canonicalSlicePayload(payload)). When
 * `overrides.canonicalPayload` is supplied, the hash is derived from THAT
 * payload so derivation_key / slice_id / seed_set_hash stay consistent.
 * @param {object} [overrides]
 */
function buildPersistInput(overrides = {}) {
  const canonicalPayload = overrides.canonicalPayload ?? buildCanonicalPayload();
  const canonical = canonicalSlicePayload(canonicalPayload);
  const hash = sliceHash(canonical);
  return {
    derivationKey: "a".repeat(64),
    sliceHash: hash,
    canonicalPayload,
    provenance: { source: "materializer", source_revision: "rev-1" },
    coverage: canonical.coverage,
    policy: { name: "journey", version: 1 },
    systemNamespace: "ns-sys",
    seedSetHash: canonical.seed_set_hash,
    status: "materialized",
    materializationMs: 42,
    ...overrides,
  };
}

/** @param {InstanceType<typeof import("node:sqlite").DatabaseSync>} db */
function makeCounter(db) {
  return (table) =>
    db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}

// --- Tests -------------------------------------------------------------------

describe("slice-store.persist — idempotency", () => {
  test("first persist returns {created:true} with slice:slice_hash id and populates all tables", () => {
    const store = openSliceStore(":memory:");
    try {
      const input = buildPersistInput();
      const res = store.persist(input);

      assert.equal(res.created, true);
      assert.equal(typeof res.slice_id, "string");
      assert.ok(
        res.slice_id.startsWith("slice:"),
        `expected slice_id prefix 'slice:', got ${res.slice_id}`,
      );
      assert.equal(res.slice_id, `slice:${input.sliceHash}`);

      const count = makeCounter(store._db);
      assert.equal(count("context_slices"), 1, "context_slices row");
      assert.equal(count("context_slice_seeds"), 3, "seeds rows");
      assert.equal(count("context_slice_nodes"), 2, "nodes rows");
      assert.equal(count("context_slice_edges"), 2, "edges rows");
      assert.equal(count("context_slice_misses"), 1, "misses rows");
      assert.equal(count("context_slice_current"), 1, "current pointer row");
    } finally {
      store.close();
    }
  });

  test("second identical persist returns {created:false} with same slice_id and adds NO rows", () => {
    const store = openSliceStore(":memory:");
    try {
      const input = buildPersistInput();
      const first = store.persist(input);
      const countAfterFirst = makeCounter(store._db);

      const seedsBefore = countAfterFirst("context_slice_seeds");
      const slicesBefore = countAfterFirst("context_slices");

      const second = store.persist(input);
      assert.equal(second.created, false);
      assert.equal(second.slice_id, first.slice_id);

      const countAfterSecond = makeCounter(store._db);
      assert.equal(countAfterSecond("context_slices"), slicesBefore, "no new slice row");
      assert.equal(
        countAfterSecond("context_slice_seeds"),
        seedsBefore,
        "no new child rows",
      );
    } finally {
      store.close();
    }
  });
});

describe("slice-store.persist — divergent collision", () => {
  test("same derivationKey + divergent canonical payload throws SliceCollisionError and writes ZERO rows", () => {
    const store = openSliceStore(":memory:");
    try {
      const input = buildPersistInput();
      store.persist(input);

      // Build a divergent payload: mutate a node id. Keep derivationKey + sliceHash
      // fixed to force the collision path (derivation_key UNIQUE hit, bytes differ).
      const divergentPayload = buildCanonicalPayload();
      const canonical = canonicalSlicePayload(divergentPayload);
      // mutate one node's id AFTER canonicalization so canonical bytes differ
      canonical.nodes[0] = { ...canonical.nodes[0], id: "node-MUTATED" };

      const countBefore = makeCounter(store._db);
      const slicesBefore = countBefore("context_slices");
      const seedsBefore = countBefore("context_slice_seeds");
      const nodesBefore = countBefore("context_slice_nodes");
      const currentBefore = countBefore("context_slice_current");

      assert.throws(
        () =>
          store.persist({
            ...input,
            canonicalPayload: canonical,
            // keep sliceHash stale intentionally to isolate the derivation-key collision
          }),
        (err) => {
          assert.ok(err instanceof SliceCollisionError, "must be SliceCollisionError");
          // message must name the derivation key, NOT leak payload bytes
          assert.ok(
            err.message.includes(input.derivationKey),
            `message must name derivation key: ${err.message}`,
          );
          assert.ok(
            !err.message.includes("node-MUTATED"),
            `message must not leak payload: ${err.message}`,
          );
          return true;
        },
      );

      const countAfter = makeCounter(store._db);
      assert.equal(countAfter("context_slices"), slicesBefore, "no new slice");
      assert.equal(countAfter("context_slice_seeds"), seedsBefore, "no new seeds");
      assert.equal(countAfter("context_slice_nodes"), nodesBefore, "no new nodes");
      assert.equal(countAfter("context_slice_current"), currentBefore, "no new current");
    } finally {
      store.close();
    }
  });
});

describe("slice-store.persist — transactional rollback", () => {
  test("mid-persist failure (dropped child table) rolls back parent + sibling children, ZERO new rows", () => {
    const store = openSliceStore(":memory:");
    try {
      // Drop a child table to force an INSERT failure mid-transaction AFTER the
      // parent row + earlier children are written inside BEGIN IMMEDIATE.
      store._db.exec("DROP TABLE context_slice_nodes");

      const input = buildPersistInput();
      assert.throws(
        () => store.persist(input),
        (err) => err instanceof SliceStoreError,
      );

      // Parent INSERT and all sibling child INSERTs must be rolled back.
      const count = makeCounter(store._db);
      assert.equal(count("context_slices"), 0, "parent rolled back");
      assert.equal(count("context_slice_seeds"), 0, "seeds rolled back");
      assert.equal(count("context_slice_edges"), 0, "edges rolled back");
      assert.equal(count("context_slice_misses"), 0, "misses rolled back");
      assert.equal(count("context_slice_current"), 0, "current rolled back");
    } finally {
      store.close();
    }
  });
});

describe("slice-store — current pointer", () => {
  test("setCurrent then getCurrent returns {slice_id, derivation_key} of the targeted slice", () => {
    const store = openSliceStore(":memory:");
    try {
      const input = buildPersistInput();
      const { slice_id } = store.persist(input);

      // getCurrent reflects the pointer set during persist
      const cur1 = store.getCurrent({
        systemNamespace: input.systemNamespace,
        policyName: input.policy.name,
        seedSetHash: input.seedSetHash,
      });
      assert.deepEqual(cur1, {
        slice_id,
        derivation_key: input.derivationKey,
      });

      // persist a SECOND slice under a different key, then point current back
      const input2 = buildPersistInput({
        derivationKey: "b".repeat(64),
        seedSetHash: "set-b",
        canonicalPayload: {
          ...buildCanonicalPayload(),
          seed_set_hash: "set-b",
        },
      });
      const { slice_id: slice2 } = store.persist(input2);

      // two distinct pointers (different seed_set_hash)
      const cur2 = store.getCurrent({
        systemNamespace: input2.systemNamespace,
        policyName: input2.policy.name,
        seedSetHash: input2.seedSetHash,
      });
      assert.equal(cur2.slice_id, slice2);

      // explicit setCurrent re-points to the first
      store.setCurrent({
        systemNamespace: input.systemNamespace,
        policyName: input.policy.name,
        seedSetHash: input.seedSetHash,
        sliceId: slice2,
      });
      const cur3 = store.getCurrent({
        systemNamespace: input.systemNamespace,
        policyName: input.policy.name,
        seedSetHash: input.seedSetHash,
      });
      assert.equal(cur3.slice_id, slice2);

      // getCurrent on unknown pointer returns null
      const cur4 = store.getCurrent({
        systemNamespace: "ghost",
        policyName: "journey",
        seedSetHash: "none",
      });
      assert.equal(cur4, null);
    } finally {
      store.close();
    }
  });
});

describe("slice-store.read / readByHash — byte-equivalent reconstruction", () => {
  test("read({derivationKey}) canonical bytes equal the persisted input's canonical bytes", () => {
    const store = openSliceStore(":memory:");
    try {
      const input = buildPersistInput();
      store.persist(input);

      const readBack = store.read({ derivationKey: input.derivationKey });
      assert.ok(readBack, "read must return the payload");

      const readCanonical = stableStringify(canonicalSlicePayload(readBack));
      const inputCanonical = stableStringify(
        canonicalSlicePayload(input.canonicalPayload),
      );
      assert.equal(
        readCanonical === inputCanonical,
        true,
        "canonical bytes must be byte-equivalent",
      );
    } finally {
      store.close();
    }
  });

  test("readByHash({sliceHash}) returns the same byte-equivalent payload", () => {
    const store = openSliceStore(":memory:");
    try {
      const input = buildPersistInput();
      store.persist(input);

      const readBack = store.readByHash({ sliceHash: input.sliceHash });
      assert.ok(readBack, "readByHash must return the payload");

      const readCanonical = stableStringify(canonicalSlicePayload(readBack));
      const inputCanonical = stableStringify(
        canonicalSlicePayload(input.canonicalPayload),
      );
      assert.equal(readCanonical, inputCanonical, "byte-equivalent via hash");
    } finally {
      store.close();
    }
  });

  test("read on unknown key returns null (no throw)", () => {
    const store = openSliceStore(":memory:");
    try {
      assert.equal(store.read({ derivationKey: "unknown" }), null);
      assert.equal(store.readByHash({ sliceHash: "unknown" }), null);
    } finally {
      store.close();
    }
  });
});

describe("slice-store.list — namespace/policy enumeration", () => {
  test("list returns slice summaries ordered by created_at", () => {
    const store = openSliceStore(":memory:");
    try {
      const input1 = buildPersistInput();
      store.persist(input1);
      const input2 = buildPersistInput({
        derivationKey: "c".repeat(64),
        seedSetHash: "set-c",
        canonicalPayload: { ...buildCanonicalPayload(), seed_set_hash: "set-c" },
      });
      store.persist(input2);

      const list = store.list({
        systemNamespace: "ns-sys",
        policyName: "journey",
      });
      assert.equal(list.length, 2);
      for (const row of list) {
        assert.ok("slice_id" in row);
        assert.ok("slice_hash" in row);
        assert.ok("derivation_key" in row);
        assert.ok("created_at" in row);
      }
      assert.deepEqual(
        list.map((r) => r.derivation_key),
        [input1.derivationKey, input2.derivationKey],
      );
    } finally {
      store.close();
    }
  });
});

describe("slice-store.persist — input validation", () => {
  test("missing required fields throw SliceStoreError before touching the DB", () => {
    const store = openSliceStore(":memory:");
    try {
      assert.throws(
        () => store.persist({}),
        (err) => err instanceof SliceStoreError,
      );
      const count = makeCounter(store._db);
      assert.equal(count("context_slices"), 0, "no row on validation failure");
    } finally {
      store.close();
    }
  });
});
