/**
 * Deterministic prepare orchestration.
 *
 * Phase flow (each phase timed):
 *   resolveRuntimeConfig → createRuntimeLayout → withDetachedWorktree{
 *     repositorySnapshot pre → runGraphifyExtract → loadGraphifyOutput →
 *     projectGraphifyGraph (facts/chunks) → buildGraphifyArtifactManifest →
 *     write layout (native + facts + chunk-index + key-map + chunks +
 *                    artifact-manifest + mutation-pre) →
 *     buildRunDescriptor → writeRunDescriptor → verifyPreparedArtifacts
 *   } → worktree removed in finally.
 *
 * Invariants:
 *   - Worktree is always removed in finally (withDetachedWorktree guarantees).
 *   - Source working tree is never mutated; mutation.equivalent is asserted true.
 *   - Scratch extract output under run_root is removed before return.
 *   - No absolute paths are returned in the public summary fields.
 *   - Errors are typed (PrepareError or downstream DescobrirError subclasses).
 */

import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { DescobrirError } from "./errors.mjs";
import { repositorySnapshot } from "./git-reader.mjs";
import { runGraphifyExtract } from "./graphify-tool.mjs";
import { loadGraphifyOutput } from "./graphify-loader.mjs";
import { projectGraphifyGraph } from "./graphify-projector.mjs";
import {
  GRAPHIFY_ADAPTER,
  buildGraphifyArtifactManifest,
  chunkArtifactPath,
} from "./manifest-builder.mjs";
import {
  buildRunDescriptor,
  verifyPreparedArtifacts,
  writeRunDescriptor,
  RUN_PATHS,
} from "./run-descriptor.mjs";
import { createRuntimeLayout } from "./runtime-layout.mjs";
import { resolveRuntimeConfig } from "./runtime-config.mjs";
import { stablePretty } from "./stable-json.mjs";
import { withDetachedWorktree } from "./worktree.mjs";

export class PrepareError extends DescobrirError {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "PrepareError";
  }
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const PRODUCER_NAME = "graphify";
const SCRATCH_DIR = ".graphify-extract";

/**
 * @param {string} name
 * @param {Record<string, number>} timings
 * @param {() => T} fn
 * @returns {T}
 * @template T
 */
function timed(name, timings, fn) {
  const start = Date.now();
  try {
    return fn();
  } finally {
    timings[name] = Date.now() - start;
  }
}

/**
 * @param {string} name
 * @param {Record<string, number>} timings
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function timedAsync(name, timings, fn) {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    timings[name] = Date.now() - start;
  }
}

/**
 * Write one sanitized artifact under run_root with 0600 mode.
 * @param {string} runRoot
 * @param {string} rel
 * @param {string | Buffer} content
 */
function writePrivateFile(runRoot, rel, content) {
  const abs = join(runRoot, rel);
  mkdirSync(dirname(abs), { recursive: true, mode: DIR_MODE });
  if (Buffer.isBuffer(content)) {
    writeFileSync(abs, content, { mode: FILE_MODE });
  } else {
    writeFileSync(abs, content, { encoding: "utf8", mode: FILE_MODE });
  }
  try {
    chmodSync(abs, FILE_MODE);
  } catch {
    // best-effort on non-POSIX
  }
}

/**
 * Materialize the prepared run layout under run_root.
 *
 * @param {string} runRoot
 * @param {{ nativeBytes: Buffer }} loaded
 * @param {{
 *   jsonl: string,
 *   chunk_index_json: string,
 *   key_map_json: string,
 *   chunks: Array<{ chunk_key: string, jsonl: string }>,
 * }} projection
 * @param {object} manifest
 * @param {object} mutationPre
 */
function writeRunLayout(runRoot, loaded, projection, manifest, mutationPre) {
  writePrivateFile(runRoot, RUN_PATHS.artifactManifest, stablePretty(manifest));
  writePrivateFile(runRoot, RUN_PATHS.mutationPre, stablePretty(mutationPre));
  writePrivateFile(runRoot, RUN_PATHS.graphifyNative, loaded.nativeBytes);
  writePrivateFile(runRoot, RUN_PATHS.graphifyFacts, projection.jsonl);
  writePrivateFile(runRoot, RUN_PATHS.graphifyChunkIndex, projection.chunk_index_json);
  writePrivateFile(runRoot, RUN_PATHS.graphifyKeyMap, projection.key_map_json);
  for (const chunk of projection.chunks) {
    writePrivateFile(runRoot, chunkArtifactPath(chunk.chunk_key), chunk.jsonl);
  }
  // Empty payloads dir so Explorer/finalize know the inventory shape.
  mkdirSync(join(runRoot, RUN_PATHS.explorerPayloads), { recursive: true, mode: DIR_MODE });
}

/**
 * Deterministic end-to-end prepare.
 *
 * @param {{
 *   namespace: string,
 *   logical_repo: string,
 *   project_path: string,
 *   source_revision?: string,
 *   threshold?: object,
 *   run_id?: string,
 *   db?: string,
 *   obsidian_root?: string,
 * }} input
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   home?: string,
 *   createRunId?: () => string,
 *   resolveHead?: (projectPath: string) => string,
 *   runProcess?: (opts: object) => Promise<object>,
 *   resolveGraphifyExecutable?: (env?: NodeJS.ProcessEnv) => string | null,
 *   uvBin?: string,
 *   extractTimeoutMs?: number,
 *   worktreeTimeoutMs?: number,
 *   maxBuffer?: number,
 *   signal?: AbortSignal,
 *   gitBin?: string,
 *   maxFactsPerChunk?: number,
 *   maxChunkBytes?: number,
 * }} [options]
 * @returns {Promise<{
 *   status: "prepared",
 *   run_id: string,
 *   namespace: string,
 *   logical_repo: string,
 *   source_revision: string,
 *   acquisition_mode: "fresh",
 *   manifest_id: string,
 *   descriptor_sha256: string,
 *   chunk_index: { version: 1, chunks: Array<object> },
 *   phase_timings_ms: Record<string, number>,
 *   graphify: { producer_version: string, nodes_count: number, relations_count: number, relations_key: "edges"|"links" },
 *   run_root: string,
 *   runs_dir: string,
 *   descriptor: object,
 * }>}
 */
export async function prepareRun(input, options = {}) {
  /** @type {Record<string, number>} */
  const timings = {};

  const config = timed("config", timings, () =>
    resolveRuntimeConfig(input, {
      env: options.env,
      home: options.home,
      createRunId: options.createRunId,
      resolveHead: options.resolveHead,
    }),
  );

  const layout = timed("layout_create", timings, () =>
    createRuntimeLayout({
      db_path: config.db_path,
      data_dir: config.data_dir,
      cache_dir: config.cache_dir,
      runs_dir: config.runs_dir,
      run_root: config.run_root,
      run_id: config.run_id,
      ...(config.obsidian_root !== undefined ? { obsidian_root: config.obsidian_root } : {}),
    }),
  );

  const runRoot = layout.run_root;
  const revision = config.source_revision;
  const worktreeId = `wt-${revision.slice(0, 12)}-${config.run_id}`;

  /** @type {{ producer_version: string, nodes_count: number, relations_count: number, relations_key: "edges"|"links" }} */
  let graphifyStats;
  /** @type {{ total_nodes: number, total_edges: number, nodes_with_locator: number, locator_percentage: number }} */
  let locatorCoverageStats;
  /** @type {object} */
  let descriptor;
  /** @type {object} */
  let manifest;

  await timedAsync("worktree_lifecycle", timings, async () => {
    const outcome = await withDetachedWorktree({
      repoPath: config.project_path,
      revision,
      runRoot,
      worktreeId,
      signal: options.signal,
      timeoutMs: options.worktreeTimeoutMs,
      gitBin: options.gitBin,
      callback: async ({ worktreePath }) => {
        // Capture our own deterministic mutation-pre snapshot for the descriptor.
        // (withDetachedWorktree computes pre/post internally for its mutation
        // equivalence check; the descriptor needs the same shape.)
        const mutationPre = timed("snapshot_pre", timings, () =>
          repositorySnapshot({
            cwd: config.project_path,
            anchorRevision: revision,
            timeoutMs: options.worktreeTimeoutMs,
            gitBin: options.gitBin,
          }),
        );

        // Scratch extract output isolated under run_root; removed before return.
        const outputDir = join(runRoot, SCRATCH_DIR);
        mkdirSync(outputDir, { recursive: true, mode: DIR_MODE });
        try {
          const extract = await timedAsync("graphify_extract", timings, () =>
            runGraphifyExtract({
              worktreePath,
              outputDir,
              env: options.env,
              runProcess: options.runProcess,
              resolveExecutable: options.resolveGraphifyExecutable,
              uvBin: options.uvBin,
              timeoutMs: options.extractTimeoutMs,
              maxBuffer: options.maxBuffer,
              signal: options.signal,
            }),
          );

          const loaded = timed("load", timings, () =>
            loadGraphifyOutput(dirname(extract.graph_path), {
              producerVersion: extract.producer_version,
              graphFileName: basename(extract.graph_path),
            }),
          );

          const projection = timed("project", timings, () =>
            projectGraphifyGraph(loaded, {
              maxFactsPerChunk: options.maxFactsPerChunk,
              maxChunkBytes: options.maxChunkBytes,
            }),
          );

          manifest = timed("manifest", timings, () =>
            buildGraphifyArtifactManifest({
              namespace: config.namespace,
              logicalRepo: config.logical_repo,
              sourceRevision: revision,
              acquisitionMode: "fresh",
              loaded,
              projection,
            }),
          );

          timed("layout_write", timings, () => {
            writeRunLayout(runRoot, loaded, projection, manifest, mutationPre);
          });

          descriptor = timed("descriptor_build", timings, () =>
            buildRunDescriptor({
              run_id: config.run_id,
              package_intent: config.package_intent,
              producer: { name: PRODUCER_NAME, version: extract.producer_version },
              adapter: GRAPHIFY_ADAPTER,
              acquisition_mode: "fresh",
              artifact_manifest: manifest,
              chunk_index: projection.chunk_index,
              mutation_pre: mutationPre,
            }),
          );

          timed("descriptor_write", timings, () => {
            writeRunDescriptor(runRoot, descriptor);
          });

          timed("verify", timings, () => {
            verifyPreparedArtifacts(runRoot, descriptor);
          });

          graphifyStats = {
            producer_version: extract.producer_version,
            nodes_count: loaded.nodes.length,
            relations_count: loaded.relations.length,
            relations_key: loaded.relationsKey,
          };
          locatorCoverageStats = projection.locator_coverage;
        } finally {
          try {
            rmSync(outputDir, { recursive: true, force: true });
          } catch {
            // best-effort scratch cleanup
          }
        }
      },
    });

    if (!outcome.mutation.equivalent) {
      throw new PrepareError(
        "source mutation detected across prepare lifecycle (pre != post snapshot)",
        { cause: outcome },
      );
    }
  });

  if (!descriptor || !manifest || !graphifyStats) {
    // Defensive: worktree callback must populate these on success path.
    throw new PrepareError("prepare completed without producing a descriptor");
  }

  return {
    status: "prepared",
    run_id: config.run_id,
    namespace: config.namespace,
    logical_repo: config.logical_repo,
    source_revision: revision,
    acquisition_mode: "fresh",
    manifest_id: /** @type {{ id: string }} */ (manifest).id,
    descriptor_sha256: /** @type {{ descriptor_sha256: string }} */ (descriptor).descriptor_sha256,
    chunk_index: /** @type {{ chunk_index: object }} */ (descriptor).chunk_index,
    phase_timings_ms: timings,
    graphify: graphifyStats,
    locator_coverage: locatorCoverageStats,
    // Internal-only handles (NOT serialized to CLI stdout):
    run_root: runRoot,
    runs_dir: layout.runs_dir,
    descriptor,
  };
}
