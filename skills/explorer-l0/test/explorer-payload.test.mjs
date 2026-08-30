/**
 * Explorer semantic payload contract: closed schema, strict validator with
 * deterministic blockers, and an order-independent byte-stable merge.
 *
 * The Explorer is the only stochastic stage. These seams confine it to
 * semantics: it may reference stable chunk/node/edge keys and supply type,
 * natural_key, name, summary, and bounded attributes — never authority
 * (ids, hashes, manifest, coverage, status, acceptance, source paths).
 * Expected outputs below are worked literals, independent of implementation.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { stablePretty } from "../src/stable-json.mjs";
import { validateExplorerPayloadSchema } from "../src/schema/explorer-payload.mjs";
import {
  ExplorerPayloadError,
  mergeExplorerPayloads,
  validateExplorerPayload,
} from "../src/explorer-payload.mjs";

function rec(overrides = {}) {
  return {
    node_key: "n1",
    type: "Service",
    natural_key: "billing",
    name: "Billing",
    summary: "Handles billing",
    attributes: { layer: "domain" },
    ...overrides,
  };
}

function rel(overrides = {}) {
  return {
    edge_key: "e1",
    relation_type: "EXPOSES",
    from_type: "Service",
    from_natural_key: "billing",
    to_type: "Endpoint",
    to_natural_key: "get:/billing",
    ...overrides,
  };
}

function payload(chunkKey, records = [], relations = []) {
  return { chunk_key: chunkKey, records, relations };
}

const endpointRec = rec({
  node_key: "n2",
  type: "Endpoint",
  natural_key: "get:/billing",
  name: "GET /billing",
  summary: "Billing endpoint",
  attributes: {},
});

describe("explorer-payload closed schema", () => {
  test("accepts a minimal valid payload", () => {
    const result = validateExplorerPayloadSchema(payload("c1", [rec()]));
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  test("rejects a smuggled canonical_graph_hash (additionalProperties false)", () => {
    const bad = { ...payload("c1", []), canonical_graph_hash: "d".repeat(64) };
    const result = validateExplorerPayloadSchema(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /additional property/i.test(e.message)));
  });

  test("rejects authority fields on a record (id, status, evidence)", () => {
    for (const field of ["id", "status", "evidence", "source_engine"]) {
      const result = validateExplorerPayloadSchema(
        payload("c1", [rec({ [field]: "x" })]),
      );
      assert.equal(result.valid, false, `record.${field} must be rejected`);
    }
  });

  test("rejects authority fields on a relation (from_record, id)", () => {
    for (const field of ["from_record", "to_record", "id"]) {
      const result = validateExplorerPayloadSchema(
        payload("c1", [rec(), endpointRec], [rel({ [field]: "x" })]),
      );
      assert.equal(result.valid, false, `relation.${field} must be rejected`);
    }
  });

  test("rejects nested object smuggled through an attribute value", () => {
    const result = validateExplorerPayloadSchema(
      payload("c1", [rec({ attributes: { nested: { canonical_graph_hash: "x" } } })]),
    );
    assert.equal(result.valid, false);
  });

  test("rejects an absolute path smuggled as a natural_key", () => {
    const result = validateExplorerPayloadSchema(
      payload("c1", [rec({ natural_key: "/etc/passwd" })]),
    );
    assert.equal(result.valid, false);
  });
});

describe("validateExplorerPayload blockers", () => {
  test("clean payload yields no blockers", () => {
    assert.deepEqual(validateExplorerPayload(payload("c1", [rec()])), []);
  });

  test("banned authority field yields a chunk-scoped retryable blocker", () => {
    const bad = { ...payload("c1", []), canonical_graph_hash: "d".repeat(64) };
    const blockers = validateExplorerPayload(bad);
    assert.equal(blockers.length, 1);
    assert.deepEqual(blockers[0], {
      code: "banned_field",
      chunk_keys: ["c1"],
      detail: "payload: authority field 'canonical_graph_hash' is not allowed",
      retryable: true,
    });
  });

  test("confidence on a record is a banned field", () => {
    const blockers = validateExplorerPayload(payload("c1", [rec({ confidence: "high" })]));
    assert.ok(
      blockers.some(
        (b) => b.code === "banned_field" && /confidence/.test(b.detail) && b.retryable,
      ),
    );
  });

  test("status comprovado is rejected as authority", () => {
    const blockers = validateExplorerPayload(
      payload("c1", [rec({ status: "comprovado" })]),
    );
    assert.ok(blockers.some((b) => b.code === "banned_field" && /status/.test(b.detail)));
  });

  test("prompt-injection repo:// smuggled into a summary is a banned field", () => {
    const blockers = validateExplorerPayload(
      payload("c1", [rec({ summary: "repo://acme@rev/secret.go#L1-L2" })]),
    );
    assert.ok(blockers.some((b) => b.code === "banned_field"));
  });

  test("non-object payload is a non-retryable invalid_shape blocker", () => {
    assert.deepEqual(validateExplorerPayload(null), [
      { code: "invalid_shape", chunk_keys: [], detail: "payload must be a JSON object", retryable: false },
    ]);
  });
});

describe("mergeExplorerPayloads happy path", () => {
  const chunkKeys = ["c1", "c2"];
  const pA = payload("c1", [rec()]);
  const pB = payload("c2", [endpointRec], [rel()]);

  const expectedMerged = {
    records: [
      {
        type: "Endpoint",
        natural_key: "get:/billing",
        name: "GET /billing",
        summary: "Billing endpoint",
        attributes: {},
        node_keys: ["n2"],
      },
      {
        type: "Service",
        natural_key: "billing",
        name: "Billing",
        summary: "Handles billing",
        attributes: { layer: "domain" },
        node_keys: ["n1"],
      },
    ],
    relations: [
      {
        relation_type: "EXPOSES",
        from_type: "Service",
        from_natural_key: "billing",
        to_type: "Endpoint",
        to_natural_key: "get:/billing",
        edge_keys: ["e1"],
      },
    ],
  };

  test("merges two disjoint chunks into the worked-literal result", () => {
    const result = mergeExplorerPayloads({ payloads: [pA, pB], chunkKeys });
    assert.equal(result.ok, true);
    assert.deepEqual(result.blockers, []);
    assert.deepEqual(result.retryable_chunk_keys, []);
    assert.deepEqual(result.merged, expectedMerged);
  });

  test("merge is byte-stable regardless of payload input order", () => {
    const forward = mergeExplorerPayloads({ payloads: [pA, pB], chunkKeys });
    const reverse = mergeExplorerPayloads({ payloads: [pB, pA], chunkKeys });
    assert.equal(stablePretty(forward.merged), stablePretty(reverse.merged));
    assert.equal(stablePretty(forward), stablePretty(reverse));
  });

  test("merged output carries no canonical ids, status, hash, or coverage", () => {
    const result = mergeExplorerPayloads({ payloads: [pA, pB], chunkKeys });
    const flat = stablePretty(result.merged);
    for (const banned of ["\"id\"", "status", "canonical_graph_hash", "graph_index", "coverage_report"]) {
      assert.ok(!flat.includes(banned), `merged must not contain ${banned}`);
    }
  });
});

describe("mergeExplorerPayloads deterministic ordering", () => {
  test("record and node_key order is independent of input order", () => {
    const chunkKeys = ["c1", "c2"];
    const a = payload("c1", [rec({ node_key: "z9" })]);
    const b = payload("c2", [rec({ node_key: "a0" })]);
    const forward = mergeExplorerPayloads({ payloads: [a, b], chunkKeys });
    const reverse = mergeExplorerPayloads({ payloads: [b, a], chunkKeys });
    assert.deepEqual(forward.merged.records[0].node_keys, ["a0", "z9"]);
    assert.equal(stablePretty(forward), stablePretty(reverse));
  });
});

describe("mergeExplorerPayloads duplicate and conflict semantics", () => {
  const chunkKeys = ["c1", "c2"];

  test("identical record across chunks unions node_keys without a blocker", () => {
    const a = payload("c1", [rec({ node_key: "n1" })]);
    const b = payload("c2", [rec({ node_key: "n2" })]);
    const result = mergeExplorerPayloads({ payloads: [a, b], chunkKeys });
    assert.equal(result.ok, true);
    assert.equal(result.merged.records.length, 1);
    assert.deepEqual(result.merged.records[0].node_keys, ["n1", "n2"]);
  });

  test("duplicate conflicting natural keys yield a retryable blocker naming both chunks", () => {
    const a = payload("c1", [rec({ name: "Billing A" })]);
    const b = payload("c2", [rec({ name: "Billing B" })]);
    const result = mergeExplorerPayloads({ payloads: [a, b], chunkKeys });
    assert.equal(result.ok, false);
    const conflict = result.blockers.find((x) => x.code === "duplicate_conflict");
    assert.ok(conflict, "expected a duplicate_conflict blocker");
    assert.deepEqual(conflict.chunk_keys, ["c1", "c2"]);
    assert.equal(conflict.retryable, true);
    assert.equal(result.merged.records.length, 0, "conflicting identity is excluded");
    assert.deepEqual(result.retryable_chunk_keys, ["c1", "c2"]);
  });
});

describe("mergeExplorerPayloads relation validity", () => {
  test("relation with a missing endpoint is an unsupported_relation blocker", () => {
    const chunkKeys = ["c1"];
    const p = payload("c1", [rec()], [rel()]); // to-endpoint record absent
    const result = mergeExplorerPayloads({ payloads: [p], chunkKeys });
    assert.equal(result.ok, false);
    const blk = result.blockers.find((x) => x.code === "unsupported_relation");
    assert.ok(blk);
    assert.equal(blk.retryable, true);
    assert.deepEqual(blk.chunk_keys, ["c1"]);
    assert.equal(result.merged.relations.length, 0);
  });

  test("self-edge relation is unsupported", () => {
    const chunkKeys = ["c1"];
    const p = payload(
      "c1",
      [rec()],
      [rel({ to_type: "Service", to_natural_key: "billing", edge_key: "e2" })],
    );
    const result = mergeExplorerPayloads({ payloads: [p], chunkKeys });
    assert.ok(result.blockers.some((x) => x.code === "unsupported_relation"));
  });
});

describe("mergeExplorerPayloads stale index and repeated payloads", () => {
  test("unknown chunk key is a non-retryable blocker (stale index)", () => {
    const p = payload("ghost", [rec()]);
    const result = mergeExplorerPayloads({ payloads: [p], chunkKeys: ["c1", "c2"] });
    assert.equal(result.ok, false);
    const blk = result.blockers.find((x) => x.code === "unknown_chunk_key");
    assert.ok(blk);
    assert.equal(blk.retryable, false);
    assert.deepEqual(result.retryable_chunk_keys, []);
  });

  test("identical repeated payload for one chunk is idempotent", () => {
    const p = payload("c1", [rec()]);
    const result = mergeExplorerPayloads({
      payloads: [p, structuredClone(p)],
      chunkKeys: ["c1"],
    });
    assert.equal(result.ok, true);
    assert.equal(result.merged.records.length, 1);
  });

  test("divergent repeated payload for one chunk is a retryable conflict", () => {
    const result = mergeExplorerPayloads({
      payloads: [payload("c1", [rec({ name: "A" })]), payload("c1", [rec({ name: "B" })])],
      chunkKeys: ["c1"],
    });
    assert.equal(result.ok, false);
    const blk = result.blockers.find((x) => x.code === "duplicate_chunk_payload");
    assert.ok(blk);
    assert.equal(blk.retryable, true);
    assert.deepEqual(result.retryable_chunk_keys, ["c1"]);
  });
});

describe("mergeExplorerPayloads retry model and honest success", () => {
  test("retryable and non-retryable blockers are distinguished", () => {
    const good = payload("c1", [rec()]);
    const banned = { ...payload("c2", []), canonical_graph_hash: "d".repeat(64) };
    const ghost = payload("stale", [rec({ natural_key: "orders" })]);
    const result = mergeExplorerPayloads({
      payloads: [good, banned, ghost],
      chunkKeys: ["c1", "c2"],
    });
    assert.equal(result.ok, false);
    // c2 is retryable (bad Explorer output); stale is not (not in index)
    assert.deepEqual(result.retryable_chunk_keys, ["c2"]);
    assert.ok(result.blockers.some((b) => b.code === "unknown_chunk_key" && !b.retryable));
  });

  test("ok is false when blockers exist even though merged still carries clean records", () => {
    const good = payload("c1", [rec()]);
    const banned = { ...payload("c2", []), confidence: "high" };
    const result = mergeExplorerPayloads({
      payloads: [good, banned],
      chunkKeys: ["c1", "c2"],
    });
    assert.equal(result.ok, false);
    assert.equal(result.merged.records.length, 1, "clean chunk still merges");
  });

  test("blocker ordering is deterministic regardless of input order", () => {
    const banned = { ...payload("c2", []), confidence: "high" };
    const ghost = payload("stale", [rec({ natural_key: "orders" })]);
    const forward = mergeExplorerPayloads({
      payloads: [banned, ghost],
      chunkKeys: ["c1", "c2"],
    });
    const reverse = mergeExplorerPayloads({
      payloads: [ghost, banned],
      chunkKeys: ["c1", "c2"],
    });
    assert.equal(stablePretty(forward.blockers), stablePretty(reverse.blockers));
  });
});

describe("mergeExplorerPayloads call-contract guards", () => {
  test("throws ExplorerPayloadError when payloads is not an array", () => {
    assert.throws(
      () => mergeExplorerPayloads({ payloads: "nope", chunkKeys: ["c1"] }),
      ExplorerPayloadError,
    );
  });

  test("throws ExplorerPayloadError when chunkKeys is not an array of strings", () => {
    assert.throws(
      () => mergeExplorerPayloads({ payloads: [], chunkKeys: [1, 2] }),
      ExplorerPayloadError,
    );
  });
});

describe("mergeExplorerPayloads locale-independent determinism", () => {
  const mergeUrl = new URL("../src/explorer-payload.mjs", import.meta.url).href;
  const stableUrl = new URL("../src/stable-json.mjs", import.meta.url).href;

  // Schema-legal Unicode types whose Swedish collation order differs from
  // code-unit order: ä (U+00E4) < å (U+00E5) by code unit, but Swedish sorts
  // z < å < ä. A locale-dependent comparator reorders records across locales.
  const digestScript = (order) => `
    import { mergeExplorerPayloads } from ${JSON.stringify(mergeUrl)};
    import { stablePretty } from ${JSON.stringify(stableUrl)};
    import { createHash } from "node:crypto";
    const rec = (t, n) => ({ node_key: n, type: t, natural_key: "k", name: "N", summary: "", attributes: {} });
    const pool = {
      a: { chunk_key: "c1", records: [rec("zebra", "n1")], relations: [] },
      b: { chunk_key: "c2", records: [rec("\\u00e4tare", "n2")], relations: [] },
      c: { chunk_key: "c3", records: [rec("\\u00e5ra", "n3")], relations: [] },
    };
    const payloads = ${JSON.stringify(order)}.map((k) => pool[k]);
    const result = mergeExplorerPayloads({ payloads, chunkKeys: ["c1", "c2", "c3"] });
    process.stdout.write(createHash("sha256").update(stablePretty(result), "utf8").digest("hex"));
  `;

  function digestUnder(order, locale) {
    return execFileSync(process.execPath, ["--input-type=module", "-e", digestScript(order)], {
      env: { ...process.env, LC_ALL: locale, LANG: locale },
      encoding: "utf8",
    });
  }

  test("merged digest is byte-identical across C and sv_SE for every permutation", () => {
    const permutations = [
      ["a", "b", "c"],
      ["c", "b", "a"],
      ["b", "a", "c"],
    ];
    const digests = new Set();
    for (const order of permutations) {
      for (const locale of ["C", "sv_SE.UTF-8"]) {
        digests.add(digestUnder(order, locale));
      }
    }
    assert.equal(digests.size, 1, `expected one digest across locales/permutations, got ${digests.size}`);
  });

  test("record ordering follows code units, not ambient collation", () => {
    // zebra (z U+007A) < ätare (ä U+00E4) < åra (å U+00E5) by code unit.
    const result = mergeExplorerPayloads({
      payloads: [
        payload("c1", [rec({ node_key: "n1", type: "zebra" })]),
        payload("c2", [rec({ node_key: "n2", type: "ätare" })]),
        payload("c3", [rec({ node_key: "n3", type: "åra" })]),
      ],
      chunkKeys: ["c1", "c2", "c3"],
    });
    assert.deepEqual(result.merged.records.map((r) => r.type), ["zebra", "ätare", "åra"]);
  });
});

describe("validateExplorerPayload combines imperative and schema findings", () => {
  test("reports both a banned authority field and a nested non-scalar attribute", () => {
    const blockers = validateExplorerPayload(
      payload("c1", [rec({ confidence: "high", attributes: { nested: { deep: 1 } } })]),
    );
    assert.ok(
      blockers.some((b) => b.code === "banned_field" && /confidence/.test(b.detail)),
      "expected a banned_field blocker for confidence",
    );
    assert.ok(
      blockers.some((b) => b.code === "invalid_shape" && /attributes\/nested/.test(b.detail)),
      "expected an invalid_shape blocker for the nested non-scalar attribute",
    );
  });
});
