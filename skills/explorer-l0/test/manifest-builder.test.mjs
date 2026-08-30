/**
 * Public seam: buildGraphifyArtifactManifest over native + generated artifacts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadGraphifyOutput } from "../src/graphify-loader.mjs";
import { projectGraphifyGraph } from "../src/graphify-projector.mjs";
import {
  GENERATED_PATHS,
  GRAPHIFY_ADAPTER,
  GRAPHIFY_ENGINE,
  buildGraphifyArtifactManifest,
  chunkArtifactPath,
  collectGraphifyArtifacts,
  hashContent,
  makeArtifactEntry,
  recomputeManifestId,
} from "../src/manifest-builder.mjs";
import { validateArtifactManifest } from "../src/schema/descobrir.mjs";
import { stableStringify } from "../src/stable-json.mjs";
import { NS, REV, REPO } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures", "graphify", "0.9.32");

function projectFixture(graphName) {
  const loaded =
    graphName === undefined
      ? loadGraphifyOutput(FIXTURE_DIR)
      : loadGraphifyOutput({
          graph: JSON.parse(readFileSync(join(FIXTURE_DIR, graphName), "utf8")),
          producerVersion: "0.9.32",
          nativeBytes: readFileSync(join(FIXTURE_DIR, graphName)),
          nativeRelativePath: graphName,
        });
  const projection = projectGraphifyGraph(loaded, { maxFactsPerChunk: 4 });
  return { loaded, projection };
}

describe("makeArtifactEntry / hashContent", () => {
  test("hashes string and buffer identically for same bytes", () => {
    const text = "hello\n";
    assert.equal(hashContent(text), hashContent(Buffer.from(text, "utf8")));
    assert.equal(
      hashContent(text),
      createHash("sha256").update(text, "utf8").digest("hex"),
    );
  });

  test("rejects absolute artifact paths", () => {
    assert.throws(
      () =>
        makeArtifactEntry({
          path: "/tmp/x.json",
          content: "{}",
          role: "native",
          declaredRevision: REV,
        }),
      /relative/i,
    );
  });
});

describe("buildGraphifyArtifactManifest", () => {
  test("edges and links projections yield the same manifest id when native bytes match projected facts", () => {
    // Use identical native bytes (edges fixture) for both; projection of links
    // graph object still produces identical JSONL/chunks to edges.
    const edges = projectFixture();
    const linksGraph = JSON.parse(
      readFileSync(join(FIXTURE_DIR, "graph.links.json"), "utf8"),
    );
    const linksLoaded = loadGraphifyOutput({
      graph: linksGraph,
      producerVersion: "0.9.32",
      // Force same native inventory bytes as edges so only generated hashes matter
      // when comparing projection identity separately.
      nativeBytes: edges.loaded.nativeBytes,
      nativeRelativePath: "graph.json",
    });
    const linksProjection = projectGraphifyGraph(linksLoaded, { maxFactsPerChunk: 4 });

    assert.equal(edges.projection.jsonl, linksProjection.jsonl);
    assert.equal(edges.projection.chunk_index_json, linksProjection.chunk_index_json);

    const mEdges = buildGraphifyArtifactManifest({
      namespace: NS,
      logicalRepo: REPO,
      sourceRevision: REV,
      acquisitionMode: "fresh",
      loaded: edges.loaded,
      projection: edges.projection,
    });
    const mLinks = buildGraphifyArtifactManifest({
      namespace: NS,
      logicalRepo: REPO,
      sourceRevision: REV,
      acquisitionMode: "reused",
      loaded: linksLoaded,
      projection: linksProjection,
    });

    assert.equal(mEdges.id, mLinks.id);
    assert.match(mEdges.id, /^manifest:[a-f0-9]{64}$/);
    assert.equal(mEdges.acquisition_mode, "fresh");
    assert.equal(mLinks.acquisition_mode, "reused");
  });

  test("two runs produce byte-identical manifest id and artifact hash set", () => {
    const a = projectFixture();
    const b = projectFixture();
    const m1 = buildGraphifyArtifactManifest({
      namespace: NS,
      logicalRepo: REPO,
      sourceRevision: REV,
      acquisitionMode: "fresh",
      loaded: a.loaded,
      projection: a.projection,
    });
    const m2 = buildGraphifyArtifactManifest({
      namespace: NS,
      logicalRepo: REPO,
      sourceRevision: REV,
      acquisitionMode: "fresh",
      loaded: b.loaded,
      projection: b.projection,
    });
    assert.equal(m1.id, m2.id);
    assert.equal(stableStringify(m1.artifacts), stableStringify(m2.artifacts));
    assert.equal(m1.id, recomputeManifestId(m1));
  });

  test("manifest validates against canonical artifact-manifest schema", () => {
    const { loaded, projection } = projectFixture();
    const manifest = buildGraphifyArtifactManifest({
      namespace: NS,
      logicalRepo: REPO,
      sourceRevision: REV,
      acquisitionMode: "fresh",
      loaded,
      projection,
    });
    const result = validateArtifactManifest(manifest);
    assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
  });

  test("inventories native graph plus generated jsonl/chunks/index/key-map", () => {
    const { loaded, projection } = projectFixture();
    const artifacts = collectGraphifyArtifacts({
      loaded,
      projection,
      sourceRevision: REV,
    });
    const paths = artifacts.map((a) => a.path).sort();
    assert.ok(paths.some((p) => p.endsWith("graph.json")));
    assert.ok(paths.includes(GENERATED_PATHS.factsJsonl));
    assert.ok(paths.includes(GENERATED_PATHS.chunkIndex));
    assert.ok(paths.includes(GENERATED_PATHS.keyMap));
    for (const chunk of projection.chunks) {
      assert.ok(paths.includes(chunkArtifactPath(chunk.chunk_key)));
    }
    const native = artifacts.find((a) => a.role === "native");
    assert.equal(native.content_sha256, hashContent(loaded.nativeBytes));
    const facts = artifacts.find((a) => a.path === GENERATED_PATHS.factsJsonl);
    assert.equal(facts.content_sha256, hashContent(projection.jsonl));
    assert.equal(facts.role, "index");
  });

  test("engine and adapter defaults are graphify projector", () => {
    const { loaded, projection } = projectFixture();
    const manifest = buildGraphifyArtifactManifest({
      namespace: NS,
      logicalRepo: REPO,
      sourceRevision: REV,
      acquisitionMode: "fresh",
      loaded,
      projection,
    });
    assert.deepEqual(manifest.engine, GRAPHIFY_ENGINE);
    assert.equal(manifest.adapter.version, GRAPHIFY_ADAPTER.version);
    assert.equal(manifest.adapter.name, GRAPHIFY_ADAPTER.name);
  });

  test("artifact hashes are independently verifiable", () => {
    const { loaded, projection } = projectFixture();
    const manifest = buildGraphifyArtifactManifest({
      namespace: NS,
      logicalRepo: REPO,
      sourceRevision: REV,
      acquisitionMode: "fresh",
      loaded,
      projection,
    });
    const byPath = Object.fromEntries(manifest.artifacts.map((a) => [a.path, a]));
    assert.equal(
      byPath[GENERATED_PATHS.factsJsonl].content_sha256,
      createHash("sha256").update(projection.jsonl, "utf8").digest("hex"),
    );
    assert.equal(
      byPath[GENERATED_PATHS.chunkIndex].content_sha256,
      createHash("sha256").update(projection.chunk_index_json, "utf8").digest("hex"),
    );
    for (const chunk of projection.chunks) {
      const path = chunkArtifactPath(chunk.chunk_key);
      assert.equal(
        byPath[path].content_sha256,
        createHash("sha256").update(chunk.jsonl, "utf8").digest("hex"),
      );
    }
  });

  test("manifest id ignores acquisition_mode and freshness timestamps", () => {
    const { loaded, projection } = projectFixture();
    const base = {
      namespace: NS,
      logicalRepo: REPO,
      sourceRevision: REV,
      loaded,
      projection,
    };
    const m1 = buildGraphifyArtifactManifest({
      ...base,
      acquisitionMode: "fresh",
      freshness: { source_revision: REV, observed_at: "2026-01-01T00:00:00Z" },
    });
    const m2 = buildGraphifyArtifactManifest({
      ...base,
      acquisitionMode: "reused",
      freshness: { source_revision: REV, observed_at: "2026-12-31T23:59:59Z" },
    });
    assert.equal(m1.id, m2.id);
  });

  test("no absolute paths in serialized manifest", () => {
    const { loaded, projection } = projectFixture();
    const manifest = buildGraphifyArtifactManifest({
      namespace: NS,
      logicalRepo: REPO,
      sourceRevision: REV,
      acquisitionMode: "fresh",
      loaded,
      projection,
    });
    const text = stableStringify(manifest);
    assert.equal(text.includes("/Users/"), false);
    assert.equal(text.includes("/private/"), false);
    assert.equal(text.includes("/var/folders/"), false);
  });

  test("native byte mutation changes manifest id while projection digests stay independent", () => {
    const { loaded, projection } = projectFixture();
    const m1 = buildGraphifyArtifactManifest({
      namespace: NS,
      logicalRepo: REPO,
      sourceRevision: REV,
      acquisitionMode: "fresh",
      loaded,
      projection,
    });
    const mutated = {
      ...loaded,
      nativeBytes: Buffer.concat([loaded.nativeBytes, Buffer.from("\n")]),
    };
    const m2 = buildGraphifyArtifactManifest({
      namespace: NS,
      logicalRepo: REPO,
      sourceRevision: REV,
      acquisitionMode: "fresh",
      loaded: mutated,
      projection,
    });
    assert.notEqual(m1.id, m2.id);
    const facts1 = m1.artifacts.find((a) => a.path === GENERATED_PATHS.factsJsonl);
    const facts2 = m2.artifacts.find((a) => a.path === GENERATED_PATHS.factsJsonl);
    assert.equal(facts1.content_sha256, facts2.content_sha256);
    assert.equal(facts1.content_sha256, hashContent(projection.jsonl));
  });
});
