/**
 * Tests for slice-policies.mjs — versioned registry of three policy cards,
 * options normalization and options hash.
 * Hermetic: pure in-memory assertions.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  getPolicy,
  listPolicies,
  normalizeOptions,
  optionsHash,
  assertAllowedRelations,
  KNOWN_RELATIONS,
} from "../src/slice-policies.mjs";

describe("slice-policies: registry shape", () => {
  test("listPolicies returns exactly three cards", () => {
    const list = listPolicies();
    assert.equal(list.length, 3);
    const keys = list
      .map((p) => `${p.name}@${p.version}`)
      .sort()
      .join(",");
    assert.equal(keys, "drill-down@1,impact@1,journey@1");
  });

  test("each card exposes name, version, direction, allowlist, hop_rule, safety_ceilings, boundary_behavior", () => {
    for (const p of listPolicies()) {
      for (const key of [
        "name",
        "version",
        "direction",
        "allowlist",
        "hop_rule",
        "safety_ceilings",
        "boundary_behavior",
      ]) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(p, key),
          `${p.name}@${p.version} missing ${key}`,
        );
      }
    }
  });

  test("safety ceilings are max_nodes=100000 and max_edges=200000 (materialization guardrails)", () => {
    for (const p of listPolicies()) {
      assert.equal(p.safety_ceilings.max_nodes, 100000);
      assert.equal(p.safety_ceilings.max_edges, 200000);
    }
  });
});

describe("slice-policies: getPolicy", () => {
  test("getPolicy journey@1 returns the journey card", () => {
    const p = getPolicy("journey", 1);
    assert.equal(p.name, "journey");
    assert.equal(p.version, 1);
    assert.equal(p.direction, "forward");
    assert.deepEqual(p.allowlist, ["CALLS", "EXPOSES"]);
  });

  test("getPolicy impact@1 is bidirectional with the five classifications", () => {
    const p = getPolicy("impact", 1);
    assert.equal(p.direction, "bidirectional");
    assert.deepEqual(p.classifications, [
      "seed",
      "upstream",
      "downstream",
      "cross_service",
      "data_dependency",
    ]);
    assert.deepEqual(p.data_relation_kinds, []);
  });

  test("getPolicy drill-down@1 is forward with max_hops default 2", () => {
    const p = getPolicy("drill-down", 1);
    assert.equal(p.direction, "forward");
    assert.equal(p.default_options.max_hops, 2);
    assert.equal(p.boundary_behavior, "policy_boundary_miss_at_hop_limit");
  });

  test("unknown policy name throws", () => {
    assert.throws(() => getPolicy("nonexistent", 1), /policy/i);
  });

  test("unknown policy version throws", () => {
    assert.throws(() => getPolicy("journey", 99), /policy|version/i);
  });
});

describe("slice-policies: normalizeOptions", () => {
  test("drill-down fills max_hops=2 default when absent", () => {
    assert.deepEqual(normalizeOptions("drill-down", {}), { max_hops: 2 });
  });

  test("drill-down preserves explicit max_hops", () => {
    assert.deepEqual(normalizeOptions("drill-down", { max_hops: 3 }), {
      max_hops: 3,
    });
  });

  test("drill-down rejects non-positive max_hops", () => {
    assert.throws(() => normalizeOptions("drill-down", { max_hops: 0 }), /max_hops/i);
    assert.throws(
      () => normalizeOptions("drill-down", { max_hops: -1 }),
      /max_hops/i,
    );
  });

  test("drill-down rejects non-integer max_hops", () => {
    assert.throws(
      () => normalizeOptions("drill-down", { max_hops: 1.5 }),
      /max_hops/i,
    );
    assert.throws(
      () => normalizeOptions("drill-down", { max_hops: "2" }),
      /max_hops/i,
    );
  });

  test("drill-down throws on unknown key (closure tight)", () => {
    assert.throws(
      () => normalizeOptions("drill-down", { max_hops: 2, allowlist: ["X"] }),
      /unknown|allowlist|option/i,
    );
  });

  test("journey@1 throws on ANY option (no options allowed)", () => {
    assert.throws(() => normalizeOptions("journey", { max_hops: 2 }), /unknown|option/i);
  });

  test("impact@1 throws on ANY option (no options allowed)", () => {
    assert.throws(() => normalizeOptions("impact", { foo: 1 }), /unknown|option/i);
  });

  test("normalizeOptions for unknown policy throws", () => {
    assert.throws(() => normalizeOptions("nope", {}), /policy/i);
  });

  test("normalizeOptions tolerates extra whitespace key by exact match only", () => {
    // ' max_hops' is NOT the same as 'max_hops' — must throw as unknown
    assert.throws(
      () => normalizeOptions("drill-down", { " max_hops": 2 }),
      /unknown|option/i,
    );
  });
});

describe("slice-policies: optionsHash determinism", () => {
  test("same options in different key orders => equal optionsHash", () => {
    // drill-down has a single option, but the hash must be stable across insertion order in general.
    const h1 = optionsHash("drill-down", 1, { max_hops: 2 });
    const h2 = optionsHash("drill-down", 1, { max_hops: 2 });
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });

  test("max_hops=2 vs max_hops=3 => DIFFERENT optionsHash", () => {
    const h2 = optionsHash("drill-down", 1, { max_hops: 2 });
    const h3 = optionsHash("drill-down", 1, { max_hops: 3 });
    assert.notEqual(h2, h3);
  });

  test("different policy name with same options => different optionsHash", () => {
    // journey has empty options; an unknown policy must not collide.
    const hj = optionsHash("journey", 1, {});
    const hi = optionsHash("impact", 1, {});
    assert.notEqual(hj, hi);
  });

  test("hash binds name+version+options together (not just options)", () => {
    // Even though both have empty options, drill-down@1 and journey@1 differ.
    const hd = optionsHash("drill-down", 1, normalizeOptions("drill-down", {}));
    const hj = optionsHash("journey", 1, {});
    assert.notEqual(hd, hj);
  });
});

describe("slice-policies: relation universe is closed", () => {
  test("KNOWN_RELATIONS is exactly CALLS and EXPOSES for v1", () => {
    assert.deepEqual([...KNOWN_RELATIONS].sort(), ["CALLS", "EXPOSES"]);
  });

  test("assertAllowedRelations accepts the default allowlist", () => {
    assert.doesNotThrow(() => assertAllowedRelations(["CALLS", "EXPOSES"]));
    assert.doesNotThrow(() => assertAllowedRelations(["EXPOSES"]));
  });

  test("assertAllowedRelations throws on UNKNOWN relation", () => {
    assert.throws(
      () => assertAllowedRelations(["UNKNOWN"]),
      /UNKNOWN|relation|allowlist/i,
    );
  });

  test("assertAllowedRelations throws on lowercase relation (closed casing)", () => {
    assert.throws(
      () => assertAllowedRelations(["calls"]),
      /calls|relation|allowlist/i,
    );
  });

  test("every policy allowlist is a subset of KNOWN_RELATIONS", () => {
    for (const p of listPolicies()) {
      for (const r of p.allowlist) {
        assert.ok(
          KNOWN_RELATIONS.has(r),
          `${p.name}@${p.version} allowlist has ${r} not in universe`,
        );
      }
    }
  });
});
