/**
 * Public seam: Graphify 0.9.32 extraction preflight contract.
 * Expected literals are independent of validator implementation.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  GRAPHIFY_PINNED_SOURCE_COMMIT,
  GRAPHIFY_PINNED_VERSION,
  GraphifyContractError,
  assertGraphifyExtractionContract,
} from "../src/graphify-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "fixtures", "graphify");
const V0932 = join(FIXTURE_ROOT, "0.9.32");

/** Independent stable hash (sorted keys) — not imported from production. */
function independentStableHash(value) {
  const stable = (v) => {
    if (Array.isArray(v)) return v.map(stable);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, stable(v[k])]),
      );
    }
    return v;
  };
  return createHash("sha256")
    .update(JSON.stringify(stable(value)), "utf8")
    .digest("hex");
}

function loadJson(name) {
  return JSON.parse(readFileSync(join(V0932, name), "utf8"));
}

// Literals frozen from real graphifyy==0.9.32 extract of the Go fixture
// (tokens stripped; relative paths only). Recompute only if producer/fixture change.
// Node JSON.stringify emits 1 for float 1.0 — hashes are Node-stable, not Python.
const EXPECTED_EDGES_HASH =
  "0a70431bfdec6c7716be9015a359143acf60f3de3888d24a23ba56c92da2b1f5";
const EXPECTED_LINKS_HASH =
  "61c02a73c7d438dad6fa93b8cf88a5461d5e0dfa8a31711db958b6b2ca5edb3f";

describe("Graphify 0.9.32 pinned producer metadata", () => {
  test("freezes package version and upstream source commit", () => {
    assert.equal(GRAPHIFY_PINNED_VERSION, "0.9.32");
    assert.equal(
      GRAPHIFY_PINNED_SOURCE_COMMIT,
      "00efd6e7969837ae4a9f11d8d504dcd3b20b09df",
    );
    const producer = loadJson("producer.json");
    assert.equal(producer.version, "0.9.32");
    assert.equal(producer.source_commit, GRAPHIFY_PINNED_SOURCE_COMMIT);
    assert.equal(producer.package, "graphifyy");
  });
});

describe("assertGraphifyExtractionContract", () => {
  test("accepts committed edges fixture with pinned producer version", () => {
    const graph = loadJson("graph.json");
    const result = assertGraphifyExtractionContract(graph, {
      producerVersion: GRAPHIFY_PINNED_VERSION,
    });
    assert.equal(result.relationsKey, "edges");
    assert.equal(result.nodes.length, 4);
    assert.equal(result.relations.length, 5);
    assert.equal(independentStableHash(graph), EXPECTED_EDGES_HASH);
  });

  test("accepts committed links fixture (synthetic dual-key coverage)", () => {
    const graph = loadJson("graph.links.json");
    const result = assertGraphifyExtractionContract(graph, {
      producerVersion: "0.9.32",
    });
    assert.equal(result.relationsKey, "links");
    assert.equal(result.nodes.length, 4);
    assert.equal(result.relations.length, 5);
    assert.equal(independentStableHash(graph), EXPECTED_LINKS_HASH);
  });

  test("rejects {nodes:[]} with GraphifyContractError", () => {
    assert.throws(
      () =>
        assertGraphifyExtractionContract(
          { nodes: [] },
          { producerVersion: "0.9.32" },
        ),
      (err) => {
        assert.equal(err.name, "GraphifyContractError");
        assert.ok(err instanceof GraphifyContractError);
        return true;
      },
    );
  });

  test("rejects missing producer version", () => {
    const graph = loadJson("graph.json");
    assert.throws(
      () => assertGraphifyExtractionContract(graph, {}),
      GraphifyContractError,
    );
  });

  test("rejects unknown producer version", () => {
    const graph = loadJson("graph.json");
    assert.throws(
      () =>
        assertGraphifyExtractionContract(graph, {
          producerVersion: "0.10.0",
        }),
      (err) => {
        assert.ok(err instanceof GraphifyContractError);
        assert.match(String(err.message), /0\.10\.0|version/i);
        return true;
      },
    );
  });

  test("rejects both edges and links", () => {
    assert.throws(
      () =>
        assertGraphifyExtractionContract(
          { nodes: [{ id: "a" }], edges: [], links: [] },
          { producerVersion: "0.9.32" },
        ),
      GraphifyContractError,
    );
  });

  test("rejects non-object graph", () => {
    assert.throws(
      () =>
        assertGraphifyExtractionContract(null, {
          producerVersion: "0.9.32",
        }),
      GraphifyContractError,
    );
  });

  test("committed fixtures contain no absolute workspace paths", () => {
    for (const name of ["graph.json", "graph.links.json", "producer.json"]) {
      const text = readFileSync(join(V0932, name), "utf8");
      assert.equal(text.includes("/private/"), false, name);
      assert.equal(text.includes("/Users/"), false, name);
      assert.equal(text.includes("/var/folders/"), false, name);
      assert.equal(text.includes("IdeaProjects"), false, name);
    }
    const projectGo = readFileSync(
      join(FIXTURE_ROOT, "project", "main.go"),
      "utf8",
    );
    assert.match(projectGo, /package main/);
    assert.equal(projectGo.includes("/Users/"), false);
  });
});
