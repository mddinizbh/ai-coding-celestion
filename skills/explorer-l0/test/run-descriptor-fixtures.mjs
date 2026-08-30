/**
 * Shared fixtures for run-descriptor seam tests.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadGraphifyOutput } from "../src/graphify-loader.mjs";
import { projectGraphifyGraph } from "../src/graphify-projector.mjs";
import { buildGraphifyArtifactManifest } from "../src/manifest-builder.mjs";
import { NS, REV, REPO } from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, "fixtures", "graphify", "0.9.32");

export const MUTATION_PRE = Object.freeze({
  anchor_object_present: true,
  tracked_file_count: 3,
  dirty_path_count: 0,
  dirty_names: [],
  summary_hash: "a".repeat(64),
});

export const PRODUCER = Object.freeze({ name: "graphify", version: "0.9.32" });
export const ADAPTER = Object.freeze({ name: "graphify-projector", version: "1.0.0" });

export function packageIntent(overrides = {}) {
  return { namespace: NS, logical_repo: REPO, source_revision: REV, ...overrides };
}

export function projectFixture() {
  const loaded = loadGraphifyOutput(FIXTURE_DIR);
  const projection = projectGraphifyGraph(loaded, { maxFactsPerChunk: 4 });
  return { loaded, projection };
}

export function buildFixtureParts() {
  const { loaded, projection } = projectFixture();
  const manifest = buildGraphifyArtifactManifest({
    namespace: NS,
    logicalRepo: REPO,
    sourceRevision: REV,
    acquisitionMode: "fresh",
    loaded,
    projection,
  });
  return { loaded, projection, manifest, chunk_index: projection.chunk_index };
}

export function buildInput(parts = buildFixtureParts(), overrides = {}) {
  return {
    run_id: "run1",
    package_intent: packageIntent(),
    producer: PRODUCER,
    adapter: ADAPTER,
    acquisition_mode: "fresh",
    artifact_manifest: parts.manifest,
    chunk_index: parts.chunk_index,
    mutation_pre: { ...MUTATION_PRE },
    ...overrides,
  };
}
