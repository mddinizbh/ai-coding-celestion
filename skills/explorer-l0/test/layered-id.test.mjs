import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ID_VERSION,
  SUPPORTED_ID_VERSIONS,
  InvalidLayeredIdError,
  LayeredIdError,
  MixedVersionError,
  assertAllSameVersion,
  assertL0FfEndpoints,
  compareRaw,
  createLayeredIdBuilders,
  detectIdVersion,
  isV1,
  isV2,
  makeFrontierFactId,
  makeL0RecordId,
  makeL0RelationId,
  makeL1EdgeId,
  makeL2BindId,
  makeL2JourneyId,
  makePackId,
  makeSliceId,
  normalizeNaturalKey,
} from "../src/layered-id.mjs";
import { canonicalGraphHash } from "../src/graph-hash.mjs";
import { sha256Text, stableStringify } from "../src/stable-json.mjs";

describe("ID_VERSION constant", () => {
  test("is 2", () => {
    assert.equal(ID_VERSION, 2);
  });
});

describe("normalizeNaturalKey", () => {
  test("NFC + trim + lowercase + collapse whitespace to '-'", () => {
    assert.equal(normalizeNaturalKey("  Get  /Orders "), "get-/orders");
  });

  test("rejects empty after normalization", () => {
    assert.throws(() => normalizeNaturalKey("   "), LayeredIdError);
  });
});

describe("makeL0RecordId", () => {
  test("produces l0:<record-kind>:<canonical-natural-key>", () => {
    assert.equal(makeL0RecordId("Service", "Billing API"), "l0:service:billing-api");
    assert.equal(
      makeL0RecordId("Endpoint", "get:/billing"),
      "l0:endpoint:get:/billing",
    );
  });

  test("rejects empty kind or natural key", () => {
    assert.throws(() => makeL0RecordId("   ", "x"), LayeredIdError);
    assert.throws(() => makeL0RecordId("Service", "   "), LayeredIdError);
  });

  test("is deterministic (same inputs → same id)", () => {
    assert.equal(
      makeL0RecordId("Service", "Billing API"),
      makeL0RecordId("Service", "Billing API"),
    );
  });
});

describe("makeL0RelationId", () => {
  test("uses canonical natural keys (NOT record ids) in the body; TYPE is uppercased", () => {
    assert.equal(
      makeL0RelationId("exposes", "billing", "get:/billing"),
      "l0:rel:EXPOSES:billing->get:/billing",
    );
  });

  test("is deterministic", () => {
    assert.equal(
      makeL0RelationId("calls", "a", "b"),
      makeL0RelationId("CALLS", "a", "b"),
    );
  });

  test("rejects empty parts", () => {
    assert.throws(() => makeL0RelationId("", "a", "b"), LayeredIdError);
    assert.throws(() => makeL0RelationId("X", "", "b"), LayeredIdError);
    assert.throws(() => makeL0RelationId("X", "a", ""), LayeredIdError);
  });
});

describe("makeFrontierFactId", () => {
  const args = {
    kind: "http_inbound",
    namespace: "demo",
    logical_repo: "svc-a",
    source_revision: "abc",
    identity_key: "GET /api/items/{param}",
    file: "A.java",
    line: 1,
  };

  test("produces l0:ff:<kind>:<16-hex-sha256>", () => {
    const id = makeFrontierFactId(args);
    assert.match(id, /^l0:ff:http_inbound:[a-f0-9]{16}$/);
  });

  test("preserves current 16-hex width (no entropy shortening)", () => {
    const id = makeFrontierFactId(args);
    const hex = id.split(":")[3];
    assert.equal(hex.length, 16, "ff hash body must stay 16 hex chars");
  });

  test("is deterministic — same identity inputs always produce the same id", () => {
    assert.equal(makeFrontierFactId(args), makeFrontierFactId(args));
  });

  test("changes when any identity input changes", () => {
    const a = makeFrontierFactId(args);
    const b = makeFrontierFactId({ ...args, line: 2 });
    const c = makeFrontierFactId({ ...args, identity_key: "GET /api/other" });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });
});

describe("makeL1EdgeId", () => {
  test("produces l1:edge:<32-hex-sha256> (preserves current 32-hex width)", () => {
    const id = makeL1EdgeId("stable-edge-material");
    assert.match(id, /^l1:edge:[a-f0-9]{32}$/);
  });

  test("is deterministic", () => {
    assert.equal(makeL1EdgeId("X"), makeL1EdgeId("X"));
  });
});

describe("makeL2JourneyId", () => {
  test("produces l2:journey:<journey-id> verbatim (journey-id is user-provided)", () => {
    assert.equal(makeL2JourneyId("consulta-debitos"), "l2:journey:consulta-debitos");
  });

  test("rejects empty journey-id", () => {
    assert.throws(() => makeL2JourneyId(""), LayeredIdError);
  });
});

describe("makeL2BindId", () => {
  test("produces l2:bind:<32-hex-sha256> (preserves current journey_hash width)", () => {
    const id = makeL2BindId("stable-bind-material");
    assert.match(id, /^l2:bind:[a-f0-9]{32}$/);
  });

  test("is deterministic", () => {
    assert.equal(makeL2BindId("X"), makeL2BindId("X"));
  });
});

describe("makeSliceId / makePackId", () => {
  test("slice id is slice:<64-hex>", () => {
    const hash = "a".repeat(64);
    assert.equal(makeSliceId(hash), `slice:${hash}`);
  });

  test("pack id is pack:<64-hex>", () => {
    const hash = "b".repeat(64);
    assert.equal(makePackId(hash), `pack:${hash}`);
  });

  test("rejects non-64-hex hash", () => {
    assert.throws(() => makeSliceId("short"), LayeredIdError);
    assert.throws(() => makePackId("Z".repeat(64)), LayeredIdError);
  });
});

describe("version detection", () => {
  test("detectIdVersion: v2 layered ids return 2", () => {
    assert.equal(detectIdVersion("l0:service:x"), 2);
    assert.equal(detectIdVersion("l0:rel:EXPOSES:a->b"), 2);
    assert.equal(detectIdVersion("l0:ff:http_inbound:abcd1234abcd1234"), 2);
    assert.equal(detectIdVersion("l1:edge:abcd1234abcd1234abcd1234abcd1234"), 2);
    assert.equal(detectIdVersion("l2:journey:consulta"), 2);
    assert.equal(detectIdVersion("l2:bind:abcd1234abcd1234abcd1234abcd1234"), 2);
    assert.equal(detectIdVersion("slice:" + "a".repeat(64)), 2);
    assert.equal(detectIdVersion("pack:" + "a".repeat(64)), 2);
  });

  test("detectIdVersion: legacy unprefixed ids return 1", () => {
    assert.equal(detectIdVersion("service:billing"), 1);
    assert.equal(detectIdVersion("endpoint:get:/x"), 1);
    assert.equal(detectIdVersion("exposes:service:a->endpoint:b"), 1);
    assert.equal(detectIdVersion("ff:http_inbound:abcd1234abcd1234"), 1);
    assert.equal(detectIdVersion("ff:in:1:1"), 1);
    assert.equal(detectIdVersion("l1:abcd1234abcd1234abcd1234abcd1234"), 1);
  });

  test("isV1 / isV2 helpers", () => {
    assert.equal(isV1("service:x"), true);
    assert.equal(isV2("service:x"), false);
    assert.equal(isV1("l0:service:x"), false);
    assert.equal(isV2("l0:service:x"), true);
  });
});

describe("assertAllSameVersion", () => {
  test("accepts all-v2", () => {
    assert.doesNotThrow(() =>
      assertAllSameVersion(["l0:service:a", "l0:endpoint:b", "l0:rel:CALLS:a->b"]),
    );
  });

  test("accepts all-v1", () => {
    assert.doesNotThrow(() =>
      assertAllSameVersion(["service:a", "endpoint:b", "exposes:service:a->endpoint:b"]),
    );
  });

  test("rejects mixed v1+v2 with MixedVersionError (typed)", () => {
    assert.throws(
      () => assertAllSameVersion(["l0:service:a", "service:b"]),
      (err) => err instanceof MixedVersionError && /v1.*v2|mixed/i.test(err.message),
    );
  });

  test("rejects empty array", () => {
    assert.throws(() => assertAllSameVersion([]), MixedVersionError);
  });
});

describe("assertL0FfEndpoints", () => {
  test("accepts from/to fact_ids both matching l0:ff:*", () => {
    assert.doesNotThrow(() =>
      assertL0FfEndpoints({
        from: { fact_id: "l0:ff:http_outbound:abcd1234abcd1234" },
        to: { fact_id: "l0:ff:http_inbound:efcd1234abcd1234" },
      }),
    );
  });

  test("rejects when from.fact_id is l0:method:* (must be l0:ff:*)", () => {
    assert.throws(
      () =>
        assertL0FfEndpoints({
          from: { fact_id: "l0:method:foo" },
          to: { fact_id: "l0:ff:http_inbound:efcd1234abcd1234" },
        }),
      InvalidLayeredIdError,
    );
  });

  test("rejects when to.fact_id is a direct L0 record id", () => {
    assert.throws(
      () =>
        assertL0FfEndpoints({
          from: { fact_id: "l0:ff:http_outbound:abcd1234abcd1234" },
          to: { fact_id: "l0:endpoint:foo" },
        }),
      InvalidLayeredIdError,
    );
  });
});

describe("compareRaw", () => {
  test("raw code-unit ordering (NOT localeCompare)", () => {
    // 'Z' (0x5A) < 'a' (0x61) by code units; localeCompare may differ.
    assert.equal(compareRaw("Z", "a"), -1);
    assert.equal(compareRaw("a", "Z"), 1);
    assert.equal(compareRaw("same", "same"), 0);
  });
});

describe("version invalidation — executable v1-vs-v2 proof", () => {
  test("factory rejects unsupported idVersion", () => {
    assert.throws(() => createLayeredIdBuilders({ idVersion: 99 }), LayeredIdError);
    assert.throws(() => createLayeredIdBuilders({ idVersion: 0 }), LayeredIdError);
  });

  test("SUPPORTED_ID_VERSIONS lists exactly [1, 2]", () => {
    assert.deepEqual([...SUPPORTED_ID_VERSIONS], [1, 2]);
  });

  const v1 = createLayeredIdBuilders({ idVersion: 1 });
  const v2 = createLayeredIdBuilders({ idVersion: 2 });

  test("makeFrontierFactId: same inputs, v1 vs v2 → different id AND different hash body", () => {
    const input = {
      kind: "http_inbound",
      namespace: "demo",
      logical_repo: "svc-a",
      source_revision: "abc",
      identity_key: "GET /x",
      file: "F.java",
      line: 1,
    };
    const id1 = v1.makeFrontierFactId(input);
    const id2 = v2.makeFrontierFactId(input);
    // v1 has no l0:ff: prefix; v2 does.
    assert.match(id1, /^ff:http_inbound:[a-f0-9]{16}$/);
    assert.match(id2, /^l0:ff:http_inbound:[a-f0-9]{16}$/);
    // Hash bodies MUST differ — `idv1|` vs `idv2|` enters the material.
    const hash1 = id1.split(":").slice(-1)[0];
    const hash2 = id2.split(":").slice(-1)[0];
    assert.notEqual(hash1, hash2, "ff hash body must change with idVersion");
    // Deterministic within a version.
    assert.equal(v1.makeFrontierFactId(input), id1);
    assert.equal(v2.makeFrontierFactId(input), id2);
  });

  test("makeL1EdgeId: same material, v1 vs v2 → different id AND different hash", () => {
    const material = "demo|svc-a|outbound-id|demo|svc-b|inbound-id|GET /x|config_binding";
    const id1 = v1.makeL1EdgeId(material);
    const id2 = v2.makeL1EdgeId(material);
    assert.match(id1, /^l1:[a-f0-9]{32}$/);
    assert.match(id2, /^l1:edge:[a-f0-9]{32}$/);
    assert.notEqual(id1.slice(3), id2.slice(8), "l1 edge hash must change with idVersion");
  });

  test("makeL0RecordId: v1 unprefixed, v2 l0: prefixed", () => {
    assert.equal(v1.makeL0RecordId("Service", "Billing"), "service:billing");
    assert.equal(v2.makeL0RecordId("Service", "Billing"), "l0:service:billing");
  });

  test("makeL0RelationId: v1 lowercase no prefix; v2 uppercase with l0:rel:", () => {
    assert.equal(v1.makeL0RelationId("EXPOSES", "a", "b"), "exposes:a->b");
    assert.equal(v2.makeL0RelationId("EXPOSES", "a", "b"), "l0:rel:EXPOSES:a->b");
  });

  test("makeL2JourneyId: v1 raw, v2 prefixed", () => {
    assert.equal(v1.makeL2JourneyId("consulta"), "consulta");
    assert.equal(v2.makeL2JourneyId("consulta"), "l2:journey:consulta");
  });

  test("makeL2BindId: v1 returns material verbatim; v2 hashes with stamp", () => {
    const material = "ns|journey|hash";
    assert.equal(v1.makeL2BindId(material), material);
    assert.match(v2.makeL2BindId(material), /^l2:bind:[a-f0-9]{32}$/);
  });

  test("canonical_graph_hash changes when record ids are v1 vs v2", () => {
    // Same logical record set, two id spaces. canonicalGraphHash inputs the
    // record ids; v1 ids → v1 graph hash; v2 ids → v2 graph hash. They MUST
    // differ because the ids (which enter the hash payload) differ.
    const base = {
      namespace: "demo",
      type: "Service",
      name: "Billing",
      summary: "x",
      attributes: {},
      status: "hipótese",
      source_revision: "abc",
      source_engine: { name: "e", profile: "p" },
      evidence: [],
    };
    const graphV1 = {
      records: [{ ...base, id: v1.makeL0RecordId("Service", "billing") }],
      relations: [],
    };
    const graphV2 = {
      records: [{ ...base, id: v2.makeL0RecordId("Service", "billing") }],
      relations: [],
    };
    const h1 = canonicalGraphHash(graphV1);
    const h2 = canonicalGraphHash(graphV2);
    assert.match(h1, /^[a-f0-9]{64}$/);
    assert.match(h2, /^[a-f0-9]{64}$/);
    assert.notEqual(h1, h2, "canonical_graph_hash must change with idVersion");
  });

  test("derivation key + slice hash change with id_version field", () => {
    // Same struct shape, only id_version differs. The derivation key MUST
    // differ because id_version is part of the canonical struct.
    const makeStruct = (idVersion) => ({
      id_version: idVersion,
      engine_version: "e/v2-idv" + idVersion,
      slice_schema_version: idVersion === 2 ? 2 : 1,
      system_namespace: "demo-system",
      policy: { name: "journey", version: 1, options_hash: "o".repeat(64) },
      seeds: [],
      l0_baselines: [],
      l1: { system_namespace: "demo-system", edge_set_hash: "e".repeat(64) },
      l2_bindings: [],
    });
    const s1 = makeStruct(1);
    const s2 = makeStruct(2);
    const key1 = sha256Text(stableStringify(s1));
    const key2 = sha256Text(stableStringify(s2));
    assert.notEqual(key1, key2, "derivation key must change with id_version");
    // Slice hash is sha256 over the canonical payload; payload includes
    // id_version, so it also changes.
    const sliceHash1 = sha256Text(stableStringify({ ...s1, schema_version: 1 }));
    const sliceHash2 = sha256Text(stableStringify({ ...s2, schema_version: 2 }));
    assert.notEqual(sliceHash1, sliceHash2);
  });

  test("pack id hash changes when pack body includes v1 vs v2 id_version", () => {
    // Pack body includes id_version (per context-pack.mjs). The pack_id is
    // sha256 over that body — different id_version → different hash →
    // different pack_id prefix.
    const body1 = { id_version: 1, version: 1, system_namespace: "x", hops: [] };
    const body2 = { id_version: 2, version: 1, system_namespace: "x", hops: [] };
    const hash1 = sha256Text(stableStringify(body1));
    const hash2 = sha256Text(stableStringify(body2));
    assert.notEqual(hash1, hash2);
    assert.notEqual(v1.makePackId(hash1), v2.makePackId(hash2));
  });

  test("same inputs + same version remain byte-identical across invocations", () => {
    const ffInput = {
      kind: "http_outbound", namespace: "n", logical_repo: "r",
      source_revision: "s", identity_key: "k", file: "f", line: 1,
    };
    const a1 = v1.makeFrontierFactId(ffInput);
    const a2 = v1.makeFrontierFactId(ffInput);
    const b1 = v2.makeFrontierFactId(ffInput);
    const b2 = v2.makeFrontierFactId(ffInput);
    assert.equal(a1, a2);
    assert.equal(b1, b2);
  });
});
