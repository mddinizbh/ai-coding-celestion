/**
 * Public seams: projectGraphifyFacts / projectGraphifyGraph / chunking.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { compareCodeUnits } from "../src/explorer-payload-shape.mjs";
import { loadGraphifyOutput } from "../src/graphify-loader.mjs";
import {
  GraphifyProjectionError,
  chunkGraphifyFacts,
  chunkOpaqueKey,
  edgeOpaqueKey,
  nodeOpaqueKey,
  projectGraphifyFacts,
  projectGraphifyGraph,
  renderFactsJsonl,
} from "../src/graphify-projector.mjs";
import { sha256Text, stableStringify } from "../src/stable-json.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures", "graphify", "0.9.32");
const OPAQUE_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

function loadFixtureGraph(name = "graph.json") {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

function independentSha(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function shuffle(items, seed = 7) {
  const arr = [...items];
  let s = seed;
  for (let i = arr.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

describe("projectGraphifyFacts — opaque keys and sanitization", () => {
  test("opaque keys match Todo 5 pattern and are stable", () => {
    assert.match(nodeOpaqueKey("main"), OPAQUE_RE);
    assert.equal(nodeOpaqueKey("main"), "n:main");
    const edge = {
      source: "main",
      target: "go_pkg_fmt",
      relation: "imports_from",
      confidence: "EXTRACTED",
      source_file: "main.go",
      source_location: "L3",
    };
    const k1 = edgeOpaqueKey(edge);
    assert.match(k1, OPAQUE_RE);
    assert.equal(
      k1,
      edgeOpaqueKey({
        source: "main",
        target: "go_pkg_fmt",
        relation: "imports_from",
        confidence: "EXTRACTED",
        source_file: "main.go",
        source_location: "L3",
      }),
    );
    assert.equal(chunkOpaqueKey(0), "c:0000");
  });

  test("edge identity includes confidence — divergent confidence is not collapsed", () => {
    const base = {
      source: "main",
      target: "main_main",
      relation: "contains",
      source_file: "main.go",
      source_location: "L15",
    };
    const extracted = edgeOpaqueKey({ ...base, confidence: "EXTRACTED" });
    const inferred = edgeOpaqueKey({ ...base, confidence: "INFERRED" });
    assert.notEqual(extracted, inferred);
    assert.match(extracted, OPAQUE_RE);
    assert.match(inferred, OPAQUE_RE);
  });

  test("edges and links project to byte-identical fact sets", () => {
    const edgesLoaded = loadGraphifyOutput(FIXTURE_DIR);
    const linksLoaded = loadGraphifyOutput({
      graph: loadFixtureGraph("graph.links.json"),
      producerVersion: "0.9.32",
    });
    const a = projectGraphifyFacts(edgesLoaded);
    const b = projectGraphifyFacts(linksLoaded);
    assert.equal(renderFactsJsonl(a.facts), renderFactsJsonl(b.facts));
    assert.equal(stableStringify(a.key_map), stableStringify(b.key_map));
  });

  test("JSONL is one keyed fact per line and order-stable under input shuffle", () => {
    const base = loadFixtureGraph();
    const shuffled = {
      ...base,
      nodes: shuffle(base.nodes, 3),
      edges: shuffle(base.edges, 11),
    };
    const p1 = projectGraphifyFacts(
      loadGraphifyOutput({ graph: base, producerVersion: "0.9.32" }),
    );
    const p2 = projectGraphifyFacts(
      loadGraphifyOutput({ graph: shuffled, producerVersion: "0.9.32" }),
    );
    const j1 = renderFactsJsonl(p1.facts);
    const j2 = renderFactsJsonl(p2.facts);
    assert.equal(j1, j2);
    const lines = j1.trimEnd().split("\n");
    assert.equal(lines.length, 4 + 5);
    for (const line of lines) {
      const obj = JSON.parse(line);
      assert.equal(typeof obj.key, "string");
      assert.match(obj.key, OPAQUE_RE);
      assert.ok(["node", "edge", "hyperedge"].includes(obj.kind));
    }
    const keys = lines.map((l) => JSON.parse(l).key);
    const sorted = [...keys].sort(compareCodeUnits);
    assert.deepEqual(keys, sorted);
  });

  test("projection rejects absolute path smuggled past loader via object mutation", () => {
    const loaded = loadGraphifyOutput(FIXTURE_DIR);
    loaded.nodes = loaded.nodes.map((n, i) =>
      i === 0 ? { ...n, source_file: "/private/tmp/x.go" } : n,
    );
    assert.throws(() => projectGraphifyFacts(loaded), (err) => {
      assert.ok(err instanceof GraphifyProjectionError);
      assert.equal(String(err.message).includes("/private/"), false);
      return true;
    });
  });

  test("projection rejects traversal locators before key_map", () => {
    const loaded = loadGraphifyOutput(FIXTURE_DIR);
    for (const bad of ["../secret.go", "a/../b.go", "a//b.go", "a\\b.go"]) {
      const clone = {
        ...loaded,
        nodes: loaded.nodes.map((n, i) =>
          i === 0 ? { ...n, source_file: bad } : n,
        ),
      };
      assert.throws(
        () => projectGraphifyFacts(clone),
        GraphifyProjectionError,
        `expected reject for ${bad}`,
      );
    }
  });

  test("key_map carries only sanitized repo-relative locators", () => {
    const projected = projectGraphifyFacts(loadGraphifyOutput(FIXTURE_DIR));
    const blob = stableStringify(projected.key_map);
    assert.equal(blob.includes("/Users/"), false);
    assert.equal(blob.includes("/private/"), false);
    assert.equal(blob.includes("/var/folders/"), false);
    assert.equal(blob.includes("package main"), false);
    assert.equal(blob.includes(".."), false);
    assert.ok(projected.key_map.nodes["n:main"]);
    assert.equal(projected.key_map.nodes["n:main"].source_file, "main.go");
  });

  test("recognized hyperedge projects to a hyperedge fact", () => {
    const graph = loadFixtureGraph();
    graph.hyperedges = [
      { id: "h1", nodes: ["main_main", "main"], relation: "groups" },
    ];
    const projected = projectGraphifyFacts(
      loadGraphifyOutput({ graph, producerVersion: "0.9.32" }),
    );
    const hyper = projected.facts.filter((f) => f.kind === "hyperedge");
    assert.equal(hyper.length, 1);
    assert.equal(hyper[0].key, "h:h1");
    assert.deepEqual(hyper[0].node_keys, ["n:main", "n:main_main"].sort(compareCodeUnits));
  });

  test("does not invent endpoint nodes absent from Graphify", () => {
    const projected = projectGraphifyFacts(loadGraphifyOutput(FIXTURE_DIR));
    const nodeIds = new Set(
      projected.facts.filter((f) => f.kind === "node").map((f) => f.graphify_id),
    );
    assert.equal(nodeIds.has("go_pkg_fmt"), false);
    const edgeToFmt = projected.facts.find(
      (f) => f.kind === "edge" && f.target_graphify_id === "go_pkg_fmt",
    );
    assert.ok(edgeToFmt);
    assert.equal(edgeToFmt.target_key, nodeOpaqueKey("go_pkg_fmt"));
  });
});

describe("chunkGraphifyFacts — deterministic bounds", () => {
  test("byte and fact bounds produce stable chunk index", () => {
    const loaded = loadGraphifyOutput(FIXTURE_DIR);
    const { facts } = projectGraphifyFacts(loaded);
    const a = chunkGraphifyFacts(facts, { maxFactsPerChunk: 3, maxChunkBytes: 10_000 });
    const b = chunkGraphifyFacts(facts, { maxFactsPerChunk: 3, maxChunkBytes: 10_000 });
    assert.equal(stableStringify(a.chunk_index), stableStringify(b.chunk_index));
    assert.ok(a.chunks.length >= 2);
    for (const chunk of a.chunks) {
      assert.match(chunk.chunk_key, OPAQUE_RE);
      assert.equal(chunk.content_sha256, independentSha(chunk.jsonl));
      assert.equal(chunk.byte_length, Buffer.byteLength(chunk.jsonl, "utf8"));
      assert.ok(chunk.fact_count <= 3);
    }
  });

  test("oversized single fact still forms its own chunk (never dropped)", () => {
    const loaded = loadGraphifyOutput(FIXTURE_DIR);
    const { facts } = projectGraphifyFacts(loaded);
    const { chunks } = chunkGraphifyFacts(facts, { maxFactsPerChunk: 1, maxChunkBytes: 1 });
    assert.equal(chunks.length, facts.length);
    assert.equal(
      chunks.reduce((n, c) => n + c.fact_count, 0),
      facts.length,
    );
  });

  test("projectGraphifyGraph is byte-stable for two runs", () => {
    const g1 = projectGraphifyGraph(loadGraphifyOutput(FIXTURE_DIR), { maxFactsPerChunk: 4 });
    const g2 = projectGraphifyGraph(loadGraphifyOutput(FIXTURE_DIR), { maxFactsPerChunk: 4 });
    assert.equal(g1.jsonl, g2.jsonl);
    assert.equal(g1.jsonl_sha256, g2.jsonl_sha256);
    assert.equal(g1.chunk_index_json, g2.chunk_index_json);
    assert.equal(g1.key_map_json, g2.key_map_json);
    assert.equal(g1.jsonl_sha256, sha256Text(g1.jsonl));
  });

  test("chunk index digest identical under C and sv_SE locales", () => {
    const script = `
      import { loadGraphifyOutput } from ${JSON.stringify(join(HERE, "../src/graphify-loader.mjs"))};
      import { projectGraphifyGraph } from ${JSON.stringify(join(HERE, "../src/graphify-projector.mjs"))};
      import { createHash } from "node:crypto";
      const p = projectGraphifyGraph(loadGraphifyOutput(${JSON.stringify(FIXTURE_DIR)}), { maxFactsPerChunk: 3 });
      process.stdout.write(createHash("sha256").update(p.chunk_index_json, "utf8").digest("hex"));
    `;
    const run = (locale) =>
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, LC_ALL: locale, LANG: locale },
        encoding: "utf8",
      });
    const c = run("C");
    const sv = run("sv_SE.UTF-8");
    assert.equal(c, sv);
    assert.match(c, /^[a-f0-9]{64}$/);
  });

  test("partial/repeated projection of same load is identical", () => {
    const loaded = loadGraphifyOutput(FIXTURE_DIR);
    const runs = Array.from({ length: 5 }, () =>
      projectGraphifyGraph(loaded, { maxFactsPerChunk: 2 }),
    );
    for (let i = 1; i < runs.length; i += 1) {
      assert.equal(runs[i].jsonl, runs[0].jsonl);
      assert.equal(runs[i].chunk_index_json, runs[0].chunk_index_json);
    }
  });

  test("stale empty nodes+edges projects empty facts", () => {
    const loaded = loadGraphifyOutput({
      graph: { nodes: [], edges: [] },
      producerVersion: "0.9.32",
    });
    const p = projectGraphifyGraph(loaded);
    assert.equal(p.facts.length, 0);
    assert.equal(p.jsonl, "");
    assert.equal(p.chunks.length, 0);
  });
});
