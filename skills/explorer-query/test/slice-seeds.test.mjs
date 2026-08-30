/**
 * Tests for slice-seeds.mjs — seed validation, dedup, ordering, set hash.
 * Hermetic: pure in-memory assertions, no FS/DB.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  validateSeed,
  normalizeSeeds,
  seedSetHash,
} from "../src/slice-seeds.mjs";

describe("slice-seeds: validateSeed per kind", () => {
  test("l0_fact happy: returns normalized seed with closed shape", () => {
    const out = validateSeed({
      kind: "l0_fact",
      namespace: "payments",
      logical_repo: "checkout-svc",
      fact_id: "ff:http_inbound:abcd1234",
    });
    assert.deepEqual(out, {
      kind: "l0_fact",
      namespace: "payments",
      logical_repo: "checkout-svc",
      fact_id: "ff:http_inbound:abcd1234",
    });
  });

  test("l1_edge happy: uses system_namespace, no logical_repo", () => {
    const out = validateSeed({
      kind: "l1_edge",
      system_namespace: "payments",
      edge_id: "edge:checkout->billing",
    });
    assert.deepEqual(out, {
      kind: "l1_edge",
      system_namespace: "payments",
      edge_id: "edge:checkout->billing",
    });
  });

  test("l2_journey happy WITH bind_id", () => {
    const out = validateSeed({
      kind: "l2_journey",
      system_namespace: "payments",
      journey_id: "journey:checkout-flow",
      bind_id: "bind:v3",
    });
    assert.deepEqual(out, {
      kind: "l2_journey",
      system_namespace: "payments",
      journey_id: "journey:checkout-flow",
      bind_id: "bind:v3",
    });
  });

  test("l2_journey happy WITHOUT bind_id (resolves via journey_current)", () => {
    const out = validateSeed({
      kind: "l2_journey",
      system_namespace: "payments",
      journey_id: "journey:checkout-flow",
    });
    assert.deepEqual(out, {
      kind: "l2_journey",
      system_namespace: "payments",
      journey_id: "journey:checkout-flow",
    });
  });
});

describe("slice-seeds: rejection rules", () => {
  test("unknown kind throws", () => {
    assert.throws(
      () => validateSeed({ kind: "l3_thing", system_namespace: "x", id: "y" }),
      /kind/i,
    );
  });

  test("l0_fact missing namespace throws", () => {
    assert.throws(
      () =>
        validateSeed({
          kind: "l0_fact",
          logical_repo: "svc",
          fact_id: "ff:x:1",
        }),
      /namespace/i,
    );
  });

  test("l0_fact missing logical_repo throws", () => {
    assert.throws(
      () =>
        validateSeed({
          kind: "l0_fact",
          namespace: "payments",
          fact_id: "ff:x:1",
        }),
      /logical_repo/i,
    );
  });

  test("l0_fact missing fact_id throws", () => {
    assert.throws(
      () =>
        validateSeed({
          kind: "l0_fact",
          namespace: "payments",
          logical_repo: "svc",
        }),
      /fact_id/i,
    );
  });

  test("company literal default namespace 'example-corp' throws", () => {
    assert.throws(
      () =>
        validateSeed({
          kind: "l0_fact",
          namespace: "example-corp",
          logical_repo: "svc",
          fact_id: "ff:x:1",
        }),
      /namespace/i,
    );
  });

  test("seed by file_path (machine path) throws", () => {
    assert.throws(
      () =>
        validateSeed({
          kind: "l0_fact",
          namespace: "payments",
          file_path: "/Users/dev/projects/vendor/svc.ts",
          fact_id: "ff:x:1",
        }),
      /file_path|machine|path/i,
    );
  });

  test("seed by free text (no closed shape) throws", () => {
    assert.throws(
      () => validateSeed({ kind: "l0_fact", text: "the checkout service" }),
      /text|free|closed|field|logical_repo|fact_id|namespace/i,
    );
  });

  test("non-string seed throws", () => {
    assert.throws(() => validateSeed(null), /seed/i);
    assert.throws(() => validateSeed("just a string"), /seed/i);
    assert.throws(() => validateSeed(42), /seed/i);
  });
});

describe("slice-seeds: normalizeSeeds dedup + ordering", () => {
  test("duplicates collapse to one (full-key tuple dedup)", () => {
    const a = normalizeSeeds([
      {
        kind: "l0_fact",
        namespace: "n",
        logical_repo: "r",
        fact_id: "f1",
      },
      {
        kind: "l0_fact",
        namespace: "n",
        logical_repo: "r",
        fact_id: "f1",
      },
    ]);
    assert.equal(a.length, 1);
    assert.equal(a[0].fact_id, "f1");
  });

  test("same seeds in different orders normalize byte-equal (array identity)", () => {
    const seedA = {
      kind: "l0_fact",
      namespace: "n",
      logical_repo: "r",
      fact_id: "fa",
    };
    const seedB = {
      kind: "l1_edge",
      system_namespace: "n",
      edge_id: "ez",
    };
    const seedC = {
      kind: "l2_journey",
      system_namespace: "n",
      journey_id: "jm",
    };
    const left = normalizeSeeds([seedA, seedB, seedC]);
    const right = normalizeSeeds([seedC, seedB, seedA]);
    assert.deepEqual(left, right);
  });

  test("canonical sort is by (kind, namespace|system_namespace, logical_repo|\"\", id) raw code-unit", () => {
    // kind sorts before id; verify 'l0_fact' < 'l1_edge' < 'l2_journey'
    // and within kind, id ascending by raw code units (not locale).
    const out = normalizeSeeds([
      {
        kind: "l2_journey",
        system_namespace: "n",
        journey_id: "Z", // uppercase sorts before lowercase in code-unit
      },
      {
        kind: "l1_edge",
        system_namespace: "n",
        edge_id: "e2",
      },
      {
        kind: "l1_edge",
        system_namespace: "n",
        edge_id: "e1",
      },
      {
        kind: "l0_fact",
        namespace: "n",
        logical_repo: "r",
        fact_id: "f1",
      },
    ]);
    assert.deepEqual(
      out.map((s) => s.kind),
      ["l0_fact", "l1_edge", "l1_edge", "l2_journey"],
    );
    assert.deepEqual(
      out.map((s) => s.fact_id || s.edge_id || s.journey_id),
      ["f1", "e1", "e2", "Z"],
    );
  });

  test("two l2_journey seeds same journey_id but different bind_id stay distinct", () => {
    const out = normalizeSeeds([
      {
        kind: "l2_journey",
        system_namespace: "n",
        journey_id: "j1",
        bind_id: "b2",
      },
      {
        kind: "l2_journey",
        system_namespace: "n",
        journey_id: "j1",
        bind_id: "b1",
      },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(
      out.map((s) => s.bind_id),
      ["b1", "b2"],
    );
  });

  test("empty input returns empty array (not throws)", () => {
    assert.deepEqual(normalizeSeeds([]), []);
    assert.deepEqual(normalizeSeeds(undefined), []);
    assert.deepEqual(normalizeSeeds(null), []);
  });
});

describe("slice-seeds: seedSetHash determinism", () => {
  test("same seeds different orders => equal seedSetHash", () => {
    const seeds = [
      {
        kind: "l0_fact",
        namespace: "n",
        logical_repo: "r",
        fact_id: "f1",
      },
      {
        kind: "l1_edge",
        system_namespace: "n",
        edge_id: "e1",
      },
      {
        kind: "l2_journey",
        system_namespace: "n",
        journey_id: "j1",
        bind_id: "b1",
      },
    ];
    const h1 = seedSetHash(normalizeSeeds(seeds));
    const h2 = seedSetHash(normalizeSeeds([...seeds].reverse()));
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  });

  test("different seed sets => different seedSetHash", () => {
    const base = [
      {
        kind: "l0_fact",
        namespace: "n",
        logical_repo: "r",
        fact_id: "f1",
      },
    ];
    const alt = [
      {
        kind: "l0_fact",
        namespace: "n",
        logical_repo: "r",
        fact_id: "f2",
      },
    ];
    assert.notEqual(seedSetHash(normalizeSeeds(base)), seedSetHash(normalizeSeeds(alt)));
  });

  test("adding a duplicate does not change the hash", () => {
    const one = [
      {
        kind: "l0_fact",
        namespace: "n",
        logical_repo: "r",
        fact_id: "f1",
      },
    ];
    const two = [
      {
        kind: "l0_fact",
        namespace: "n",
        logical_repo: "r",
        fact_id: "f1",
      },
      {
        kind: "l0_fact",
        namespace: "n",
        logical_repo: "r",
        fact_id: "f1",
      },
    ];
    assert.equal(seedSetHash(normalizeSeeds(one)), seedSetHash(normalizeSeeds(two)));
  });
});
