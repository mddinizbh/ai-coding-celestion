/**
 * Build the canonical Artifact Manifest for Graphify native + generated artifacts.
 *
 * Reuses createArtifactManifest (identity + sorting). Hashes every native
 * Graphify file and every generated JSONL/chunk/index artifact.
 */

import { createHash } from "node:crypto";

import { compareCodeUnits } from "./explorer-payload-shape.mjs";
import { GraphifyLoaderError } from "./errors.mjs";
import { createArtifactManifest } from "./graph-hash.mjs";
import { sha256Text, stableStringify } from "./stable-json.mjs";

export const GRAPHIFY_ADAPTER = Object.freeze({
  name: "graphify-projector",
  version: "1.0.0",
});

export const GRAPHIFY_ENGINE = Object.freeze({
  name: "graphify",
  profile: "code-only-0.9.32",
});

/** Relative paths for generated projection artifacts inside a run. */
export const GENERATED_PATHS = Object.freeze({
  factsJsonl: "graphify/facts.jsonl",
  chunkIndex: "graphify/chunk-index.json",
  keyMap: "graphify/key-map.json",
  chunkDir: "graphify/chunks",
});

/**
 * @param {string | Buffer} content
 * @returns {string}
 */
export function hashContent(content) {
  if (typeof content === "string") {
    return sha256Text(content);
  }
  if (Buffer.isBuffer(content)) {
    return createHash("sha256").update(content).digest("hex");
  }
  throw new GraphifyLoaderError("artifact content must be a string or Buffer");
}

/**
 * @param {object} input
 * @param {string} input.path relative path
 * @param {string | Buffer} input.content
 * @param {"native"|"index"|"projection"} input.role
 * @param {string} input.declaredRevision
 * @param {"complete"|"incompleto"} [input.status]
 * @param {string} [input.mediaType]
 * @returns {object}
 */
export function makeArtifactEntry({
  path,
  content,
  role,
  declaredRevision,
  status = "complete",
  mediaType,
}) {
  if (typeof path !== "string" || path.length === 0) {
    throw new GraphifyLoaderError("artifact path must be a non-empty string");
  }
  if (path.startsWith("/") || path.includes("\\") || path.includes("..")) {
    throw new GraphifyLoaderError("artifact path must be a safe relative path");
  }
  if (role !== "native" && role !== "index" && role !== "projection") {
    throw new GraphifyLoaderError(`unsupported artifact role '${role}'`);
  }
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (!Buffer.isBuffer(bytes)) {
    throw new GraphifyLoaderError("artifact content must be a string or Buffer");
  }
  /** @type {Record<string, unknown>} */
  const entry = {
    path,
    content_sha256: hashContent(bytes),
    role,
    declared_revision: declaredRevision,
    status,
    byte_length: bytes.byteLength,
  };
  if (typeof mediaType === "string" && mediaType.length > 0) {
    entry.media_type = mediaType;
  }
  return entry;
}

/**
 * @param {string} chunkKey
 */
export function chunkArtifactPath(chunkKey) {
  // chunk keys are c:0000 — filesystem segment replaces ':' with '_'
  const safe = chunkKey.replace(/:/g, "_");
  return `${GENERATED_PATHS.chunkDir}/${safe}.jsonl`;
}

/**
 * Collect native + generated artifact entries from a load/projection pair.
 *
 * @param {{
 *   loaded: { nativeBytes: Buffer, nativeRelativePath: string, producerVersion: string },
 *   projection: {
 *     jsonl: string,
 *     chunk_index_json: string,
 *     key_map_json: string,
 *     chunks: Array<{ chunk_key: string, jsonl: string }>,
 *   },
 *   sourceRevision: string,
 *   nativePathPrefix?: string,
 * }} input
 * @returns {object[]}
 */
export function collectGraphifyArtifacts({
  loaded,
  projection,
  sourceRevision,
  nativePathPrefix = "graphify/native",
}) {
  if (!loaded || !Buffer.isBuffer(loaded.nativeBytes)) {
    throw new GraphifyLoaderError("loaded.nativeBytes Buffer is required");
  }
  if (!projection || typeof projection.jsonl !== "string") {
    throw new GraphifyLoaderError("projection.jsonl is required");
  }

  const nativeName =
    typeof loaded.nativeRelativePath === "string" && loaded.nativeRelativePath.length > 0
      ? loaded.nativeRelativePath.replace(/\\/g, "/").split("/").pop()
      : "graph.json";
  const nativePath = `${nativePathPrefix}/${nativeName}`;

  /** @type {object[]} */
  const artifacts = [
    makeArtifactEntry({
      path: nativePath,
      content: loaded.nativeBytes,
      role: "native",
      declaredRevision: sourceRevision,
      mediaType: "application/json",
    }),
    makeArtifactEntry({
      path: GENERATED_PATHS.factsJsonl,
      content: projection.jsonl,
      role: "index",
      declaredRevision: sourceRevision,
      mediaType: "application/x-ndjson",
    }),
    makeArtifactEntry({
      path: GENERATED_PATHS.chunkIndex,
      content: projection.chunk_index_json,
      role: "index",
      declaredRevision: sourceRevision,
      mediaType: "application/json",
    }),
    makeArtifactEntry({
      path: GENERATED_PATHS.keyMap,
      content: projection.key_map_json,
      role: "index",
      declaredRevision: sourceRevision,
      mediaType: "application/json",
    }),
  ];

  const chunks = Array.isArray(projection.chunks) ? [...projection.chunks] : [];
  chunks.sort((a, b) => compareCodeUnits(a.chunk_key, b.chunk_key));
  for (const chunk of chunks) {
    artifacts.push(
      makeArtifactEntry({
        path: chunkArtifactPath(chunk.chunk_key),
        content: chunk.jsonl,
        role: "index",
        declaredRevision: sourceRevision,
        mediaType: "application/x-ndjson",
      }),
    );
  }

  return artifacts;
}

/**
 * Build the canonical Artifact Manifest for a Graphify prepare projection.
 *
 * @param {{
 *   namespace: string,
 *   logicalRepo: string,
 *   sourceRevision: string,
 *   acquisitionMode: "fresh"|"reused",
 *   loaded: { nativeBytes: Buffer, nativeRelativePath: string, producerVersion: string },
 *   projection: {
 *     jsonl: string,
 *     chunk_index_json: string,
 *     key_map_json: string,
 *     chunks: Array<{ chunk_key: string, jsonl: string }>,
 *   },
 *   freshness?: object,
 *   engine?: { name: string, profile: string },
 *   adapter?: { name?: string, version: string },
 *   nativePathPrefix?: string,
 * }} input
 * @returns {object}
 */
export function buildGraphifyArtifactManifest(input) {
  const {
    namespace,
    logicalRepo,
    sourceRevision,
    acquisitionMode,
    loaded,
    projection,
    freshness,
    engine = GRAPHIFY_ENGINE,
    adapter = GRAPHIFY_ADAPTER,
    nativePathPrefix,
  } = input;

  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new GraphifyLoaderError("namespace is required");
  }
  if (typeof logicalRepo !== "string" || logicalRepo.length === 0) {
    throw new GraphifyLoaderError("logicalRepo is required");
  }
  if (typeof sourceRevision !== "string" || sourceRevision.length === 0) {
    throw new GraphifyLoaderError("sourceRevision is required");
  }
  if (acquisitionMode !== "fresh" && acquisitionMode !== "reused") {
    throw new GraphifyLoaderError("acquisitionMode must be fresh or reused");
  }

  const artifacts = collectGraphifyArtifacts({
    loaded,
    projection,
    sourceRevision,
    nativePathPrefix,
  });

  return createArtifactManifest({
    namespace,
    logicalRepo,
    sourceRevision,
    engine,
    adapter,
    acquisitionMode,
    artifacts,
    freshness: freshness ?? { source_revision: sourceRevision },
  });
}

/**
 * Independent identity check helper for tests/QA: recompute manifest id inputs.
 * @param {object} manifest
 * @returns {string}
 */
export function recomputeManifestId(manifest) {
  const identity = {
    namespace: manifest.namespace,
    logical_repo: manifest.logical_repo,
    source_revision: manifest.source_revision,
    engine: manifest.engine,
    artifact_content_sha256: manifest.artifacts
      .map(/** @param {{ content_sha256: string }} a */ (a) => a.content_sha256)
      .slice()
      .sort(compareCodeUnits),
  };
  return `manifest:${sha256Text(stableStringify(identity))}`;
}
