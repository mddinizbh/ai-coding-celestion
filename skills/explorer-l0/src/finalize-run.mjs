/**
 * Deterministic finalize: verify prepared artifacts, merge Explorer semantic
 * payloads, map opaque keys to artifact/repository evidence, snapshot the
 * source post-run, canonicalize the candidate package, recompute coverage, and
 * persist idempotently to the central namespace store.
 *
 * Guardrail contract:
 *   - Semantic/guardrail failure (missing payload, unknown chunk key, banned
 *     field, prepared-artifact drift) → returns `{status:"blocked", exit_code:2}`
 *     with stable, machine-readable blockers; NO database write occurs and run
 *     artifacts are preserved for retry.
 *   - Source mutation drift is NOT a blocker: the candidate is persisted with
 *     `coverage_report.mutation.equivalent === false` and `passed === false`.
 *
 * This module is the only place that wires descriptor + payload + verifier +
 * store; sub-stages stay injectable for tests but never trust the Explorer for
 * ids, hashes, coverage, status, or acceptance.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { canonicalizeCandidatePackage } from "./candidate-package.mjs";
import { compareCodeUnits } from "./explorer-payload-shape.mjs";
import { mergeExplorerPayloads } from "./explorer-payload.mjs";
import { DescobrirError } from "./errors.mjs";
import {
  GitSourceError,
  bindReadAtRevision,
  repositorySnapshot,
} from "./git-reader.mjs";
import { chunkArtifactPath } from "./manifest-builder.mjs";
import {
  RUN_PATHS,
  RunDescriptorError,
  listExplorerPayloadFiles,
  loadRunDescriptor,
  verifyPreparedArtifacts,
} from "./run-descriptor.mjs";
import { openStore, persistCandidate } from "./store.mjs";
import { stableStringify } from "./stable-json.mjs";

export class FinalizeRunError extends DescobrirError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "FinalizeRunError";
  }
}

export const FINALIZE_EXIT_OK = 0;
export const FINALIZE_EXIT_BLOCKED = 2;

const LOC_RE = /^L(\d+)$/;
const STATUS_HIPOTESE = "hipótese";

/**
 * @param {string} message
 * @param {{ cause?: unknown }} [options]
 * @returns {never}
 */
function fail(message, options) {
  throw new FinalizeRunError(message, options);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireAbsolute(value, label) {
  if (typeof value !== "string" || value === "" || !isAbsolute(value)) {
    fail(`${label} must be an absolute path`);
  }
}

/**
 * @param {string} code
 * @param {string[]} chunkKeys
 * @param {string} detail
 * @param {boolean} retryable
 */
function blocker(code, chunkKeys, detail, retryable) {
  return {
    code,
    chunk_keys: [...chunkKeys].sort(compareCodeUnits),
    detail,
    retryable,
  };
}

/**
 * Read and parse a JSON explorer payload file (regular file, no symlink).
 * @param {string} abs
 * @param {string} rel
 */
function readPayloadFile(abs, rel) {
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    fail(`failed to read explorer payload '${rel}': ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`explorer payload '${rel}' is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Locate the chunk_key that owns a given fact key.
 * @param {object} descriptor
 * @returns {Map<string, string>}
 */
function buildFactToChunkMap(descriptor) {
  const out = new Map();
  for (const chunk of descriptor.chunk_index.chunks) {
    for (const key of chunk.fact_keys) out.set(key, chunk.chunk_key);
  }
  return out;
}

/**
 * Map chunk_key → artifact manifest entry for chunk artifacts.
 * @param {object} descriptor
 * @returns {Map<string, { path: string, content_sha256: string }>}
 */
function buildChunkArtifactMap(descriptor) {
  const out = new Map();
  for (const chunk of descriptor.chunk_index.chunks) {
    const path = chunkArtifactPath(chunk.chunk_key);
    const entry = descriptor.artifact_manifest.artifacts.find(
      (a) => a.path === path,
    );
    if (!entry) continue;
    out.set(chunk.chunk_key, {
      path: entry.path,
      content_sha256: entry.content_sha256,
    });
  }
  return out;
}

/**
 * Parse a Graphify source_location token (e.g. "L11") into a 1-based line.
 * @param {unknown} loc
 * @returns {number|null}
 */
function parseLineToken(loc) {
  if (typeof loc !== "string" || loc === "") return null;
  const m = loc.match(LOC_RE);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * Build repository evidence URI from a key_map locator entry.
 * @param {{ source_file?: unknown, source_location?: unknown }} locator
 * @param {string} logicalRepo
 * @param {string} sourceRevision
 * @returns {{ uri: string, line: number } | null}
 */
function buildRepositoryEvidence(locator, logicalRepo, sourceRevision) {
  if (typeof locator.source_file !== "string" || locator.source_file === "") return null;
  const line = parseLineToken(locator.source_location);
  if (line === null) return null;
  const uri = `repo://${logicalRepo}@${sourceRevision}/${locator.source_file}#L${line}-L${line}`;
  return { uri, line };
}

/**
 * Build artifact evidence pointing at the chunk artifact that supplied a fact.
 * @param {{ path: string, content_sha256: string } | undefined} chunkArtifact
 * @param {string} manifestId
 * @param {number} line
 */
function buildArtifactEvidence(chunkArtifact, manifestId, line) {
  if (!chunkArtifact) return null;
  return {
    kind: "artifact",
    manifest_id: manifestId,
    artifact_path: chunkArtifact.path,
    content_sha256: chunkArtifact.content_sha256,
    range: { start_line: line, end_line: line },
  };
}

/**
 * Build the evidence list for one merged record/relation based on its opaque keys.
 * @param {string[]} keys node_keys or edge_keys
 * @param {"nodes"|"edges"} kindBucket
 * @param {object} keyMap parsed Graphify key-map
 * @param {Map<string, string>} factToChunk
 * @param {Map<string, { path: string, content_sha256: string }>} chunkArtifacts
 * @param {string} manifestId
 * @param {string} logicalRepo
 * @param {string} sourceRevision
 */
function buildEvidenceFor(
  keys,
  kindBucket,
  keyMap,
  factToChunk,
  chunkArtifacts,
  manifestId,
  logicalRepo,
  sourceRevision,
) {
  const bucket = keyMap[kindBucket];
  if (bucket === null || typeof bucket !== "object") return [];
  /** @type {object[]} */
  const evidence = [];
  for (const key of keys) {
    const locator = bucket[key];
    if (locator === null || typeof locator !== "object") continue;
    const repo = buildRepositoryEvidence(locator, logicalRepo, sourceRevision);
    const chunkKey = factToChunk.get(key);
    const chunkArtifact = chunkKey ? chunkArtifacts.get(chunkKey) : undefined;
    const line = repo?.line ?? 1;
    const artifact = buildArtifactEvidence(chunkArtifact, manifestId, line);
    if (artifact) evidence.push(artifact);
    if (repo) {
      evidence.push({ kind: "repository", uri: repo.uri });
    }
  }
  return evidence;
}

/**
 * Reduce a repository snapshot to the canonical coverage-report mutation shape.
 * Coverage schema forbids dirty_names (could leak sensitive material).
 * @param {{ summary_hash: string, tracked_file_count?: number, dirty_path_count?: number, anchor_object_present?: boolean }} snap
 */
function toMutationSnapshot(snap) {
  const out = { summary_hash: snap.summary_hash };
  if (typeof snap.tracked_file_count === "number") out.tracked_file_count = snap.tracked_file_count;
  if (typeof snap.dirty_path_count === "number") out.dirty_path_count = snap.dirty_path_count;
  if (typeof snap.anchor_object_present === "boolean") out.anchor_object_present = snap.anchor_object_present;
  return out;
}

/**
 * Reduce a verified package's coverage to a small stable summary for stdout.
 * @param {object} pkg canonicalized package with coverage_report
 */
function summarizeCoverage(pkg) {
  const cov = pkg.coverage_report;
  const prov = cov?.provenance ?? {};
  return {
    passed: cov?.passed === true,
    repository_verified_percentage: prov.repository_verified_percentage ?? 0,
    repository_verified_count: prov.repository_verified_count ?? 0,
    total_entities: prov.total_entities ?? 0,
    mutation_equivalent: cov?.mutation?.equivalent === true,
    schema_valid: cov?.schema_result?.valid === true,
    repeatability_result: cov?.repeatability?.result ?? "fail",
    producer_baseline_result: cov?.producer_baseline?.result ?? "fail",
  };
}

/**
 * @param {object} descriptor validated run descriptor
 * @returns {{ threshold: object, freshness: object, id: string, producer_baseline: object, repeatability: object }}
 */
function defaultCoverageInputs(descriptor) {
  const intent = descriptor.package_intent;
  const threshold =
    intent.threshold ?? {
      minimum_repository_verified_percentage: 0,
      require_schema_valid: true,
      require_repeatability_pass: true,
      require_mutation_equivalent: true,
      require_producer_reconciliation_pass: true,
    };
  return {
    id: "coverage:finalize",
    threshold,
    freshness: { source_revision: intent.source_revision },
    producer_baseline: {
      declared_counts: {},
      indexed_counts: {},
      deltas: [],
    },
    repeatability: {
      result: "pass",
      canonical_graph_hash: "0".repeat(64),
    },
  };
}

/**
 * Merge caller coverage inputs over the defaults derived from the descriptor.
 * Caller may not supply authority/derived fields (passed/provenance/...).
 * @param {object} base
 * @param {object|undefined} override
 */
function mergeCoverageInputs(base, override) {
  if (override === undefined) return base;
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    fail("coverageInputs must be an object when provided");
  }
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const key of Object.keys(override)) {
    const value = override[key];
    if (value === undefined) continue;
    if (key === "mutation") {
      // Mutation is code-owned — caller cannot supply pre/post snapshots.
      fail("coverageInputs.mutation is code-owned; remove it (finalize injects pre/post)");
    }
    out[key] = value;
  }
  return out;
}

/**
 * @param {string} runRoot
 */
function removeRunRoot(runRoot) {
  try {
    rmSync(runRoot, { recursive: true, force: true });
  } catch (err) {
    fail(`failed to clean run root: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Run the deterministic finalize pipeline.
 *
 * @param {{
 *   runRoot: string,
 *   dbPath: string,
 *   sourceRepoPath: string,
 *   coverageInputs?: object,
 *   gitBin?: string,
 *   timeoutMs?: number,
 *   retainRun?: boolean,
 *   readAtRevision?: (args: { revision: string, path: string }) => Buffer|string,
 *   snapshotPost?: (args: { cwd: string, anchorRevision: string, timeoutMs?: number, gitBin?: string }) => object,
 *   openStoreFn?: (dbPath: string) => { _db: object, close: () => void },
 *   persistCandidateFn?: (store: object, pkg: object) => { candidate_id: string, created: boolean },
 * }} input
 * @returns {{
 *   status: "finalized",
 *   exit_code: 0,
 *   candidate_id: string,
 *   created: boolean,
 *   canonical_graph_hash: string,
 *   coverage: object,
 *   run_id: string,
 *   blockers?: undefined,
 * } | {
 *   status: "blocked",
 *   exit_code: 2,
 *   blockers: object[],
 *   retryable_chunk_keys: string[],
 *   run_id: string,
 *   candidate_id?: undefined,
 * }}
 */
export function finalizeRun(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("finalizeRun input must be an object");
  }
  const runRoot = input.runRoot;
  const dbPath = input.dbPath;
  const sourceRepoPath = input.sourceRepoPath;
  requireAbsolute(runRoot, "runRoot");
  if (typeof dbPath !== "string" || dbPath === "") fail("dbPath must be a non-empty string");
  requireAbsolute(sourceRepoPath, "sourceRepoPath");
  if (!existsSync(runRoot)) fail("runRoot does not exist");
  if (!existsSync(sourceRepoPath)) fail("sourceRepoPath does not exist");

  const timeoutMs = input.timeoutMs ?? 30_000;
  const gitBin = typeof input.gitBin === "string" && input.gitBin !== "" ? input.gitBin : undefined;
  const gitOpts = { timeoutMs, gitBin };
  const retainRun = input.retainRun === true;

  // 1. Load + 2. Verify prepared artifacts. Both throw FinalizeRunError on drift.
  let descriptor;
  try {
    descriptor = loadRunDescriptor(runRoot);
  } catch (err) {
    if (err instanceof RunDescriptorError) {
      throw new FinalizeRunError(err.message, { cause: err });
    }
    throw err;
  }
  const runId = descriptor.run_id;

  try {
    verifyPreparedArtifacts(runRoot, descriptor);
  } catch (err) {
    if (err instanceof RunDescriptorError) {
      throw new FinalizeRunError(err.message, { cause: err });
    }
    throw err;
  }

  // 3. Payload inventory — list missing first (no DB write on missing).
  const inventory = listExplorerPayloadFiles(runRoot, descriptor);
  if (inventory.missing.length > 0) {
    const chunkKeys = inventory.missing.map((p) =>
      p.slice(`${RUN_PATHS.explorerPayloads}/`.length).replace(/\.json$/, ""),
    );
    return {
      status: "blocked",
      exit_code: FINALIZE_EXIT_BLOCKED,
      run_id: runId,
      blockers: [
        blocker(
          "missing_payload",
          chunkKeys,
          "explorer payload file is missing for one or more chunks",
          true,
        ),
      ],
      retryable_chunk_keys: chunkKeys,
    };
  }

  // 4. Read + merge payloads.
  /** @type {object[]} */
  const payloads = [];
  for (const rel of inventory.found) {
    const abs = join(runRoot, rel);
    payloads.push(readPayloadFile(abs, rel));
  }
  const chunkKeys = descriptor.chunk_index.chunks.map((c) => c.chunk_key);
  const merge = mergeExplorerPayloads({ payloads, chunkKeys });
  if (!merge.ok) {
    return {
      status: "blocked",
      exit_code: FINALIZE_EXIT_BLOCKED,
      run_id: runId,
      blockers: merge.blockers,
      retryable_chunk_keys: merge.retryable_chunk_keys,
    };
  }

  // 4b. Read key map early — needed to detect unresolvable opaque keys before
  //     evidence construction (the Explorer may pass schema/merge but reference
  //     a node_key/edge_key not present in this run's key map).
  let keyMap;
  try {
    keyMap = JSON.parse(
      readFileSync(join(runRoot, RUN_PATHS.graphifyKeyMap), "utf8"),
    );
  } catch (err) {
    fail(`failed to read key map: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4c. Detect merged records/relations whose opaque keys have no key_map
  //     locator. These cannot carry evidence — surface as retryable blockers
  //     before canonicalization (no DB write).
  /** @type {object[]} */
  const semanticBlockers = [];
  const knownNodes = new Set(Object.keys(keyMap.nodes ?? {}));
  const knownEdges = new Set(Object.keys(keyMap.edges ?? {}));
  /** @param {string} key @param {"node"|"edge"} kind */
  function resolvable(key, kind) {
    return kind === "node" ? knownNodes.has(key) : knownEdges.has(key);
  }
  for (const rec of merge.merged.records) {
    for (const key of rec.node_keys) {
      if (!resolvable(key, "node")) {
        semanticBlockers.push(
          blocker(
            "unknown_node_key",
            [],
            `record type='${rec.type}' natural_key='${rec.natural_key}' references unknown node_key '${key}'`,
            true,
          ),
        );
      }
    }
  }
  for (const rel of merge.merged.relations) {
    for (const key of rel.edge_keys ?? []) {
      if (!resolvable(key, "edge")) {
        semanticBlockers.push(
          blocker(
            "unknown_edge_key",
            [],
            `relation '${rel.relation_type}' references unknown edge_key '${key}'`,
            true,
          ),
        );
      }
    }
  }
  if (semanticBlockers.length > 0) {
    // Dedupe blockers deterministically (locale-independent).
    const seen = new Set();
    const unique = [];
    for (const b of semanticBlockers) {
      const k = `${b.code}\u0000${b.detail}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(b);
    }
    unique.sort(
      (a, b) =>
        compareCodeUnits(a.code, b.code) ||
        compareCodeUnits(a.detail, b.detail),
    );
    return {
      status: "blocked",
      exit_code: FINALIZE_EXIT_BLOCKED,
      run_id: runId,
      blockers: unique,
      retryable_chunk_keys: [],
    };
  }

  // 5. Build candidate draft from merged semantics + descriptor-derived evidence.
  const intent = descriptor.package_intent;
  const manifestId = descriptor.artifact_manifest.id;
  const factToChunk = buildFactToChunkMap(descriptor);
  const chunkArtifacts = buildChunkArtifactMap(descriptor);

  const draftRecords = merge.merged.records.map((rec) => ({
    type: rec.type,
    natural_key: rec.natural_key,
    name: rec.name,
    summary: rec.summary,
    attributes: rec.attributes,
    status: STATUS_HIPOTESE,
    evidence: buildEvidenceFor(
      rec.node_keys,
      "nodes",
      keyMap,
      factToChunk,
      chunkArtifacts,
      manifestId,
      intent.logical_repo,
      intent.source_revision,
    ),
  }));

  const draftRelations = merge.merged.relations.map((rel) => {
    /** @type {object[]} */
    const fromKeys = /** @type {any} */ (rel).from_node_keys ?? [];
    /** @type {object[]} */
    const toKeys = /** @type {any} */ (rel).to_node_keys ?? [];
    // Edge evidence anchors on edge_keys first (line precise), falling back to
    // endpoint node_keys when the relation had no edge locators of its own.
    const edgeKeys = rel.edge_keys ?? [];
    const fromEvidence = buildEvidenceFor(
      edgeKeys.length > 0 ? edgeKeys : fromKeys,
      edgeKeys.length > 0 ? "edges" : "nodes",
      keyMap,
      factToChunk,
      chunkArtifacts,
      manifestId,
      intent.logical_repo,
      intent.source_revision,
    );
    const toEvidence =
      edgeKeys.length > 0
        ? []
        : buildEvidenceFor(
            toKeys,
            "nodes",
            keyMap,
            factToChunk,
            chunkArtifacts,
            manifestId,
            intent.logical_repo,
            intent.source_revision,
          );
    return {
      relation_type: rel.relation_type,
      from_type: rel.from_type,
      from_natural_key: rel.from_natural_key,
      to_type: rel.to_type,
      to_natural_key: rel.to_natural_key,
      status: STATUS_HIPOTESE,
      evidence: [...fromEvidence, ...toEvidence],
    };
  });

  // 6. Capture post snapshot and bind reader (concrete pinned git).
  const snapshotPost = input.snapshotPost ?? repositorySnapshot;
  let postSnap;
  try {
    postSnap = snapshotPost({
      cwd: sourceRepoPath,
      anchorRevision: intent.source_revision,
      timeoutMs,
      gitBin,
    });
  } catch (err) {
    if (err instanceof GitSourceError) {
      throw new FinalizeRunError(err.message, { cause: err });
    }
    throw err;
  }

  const baseCoverage = defaultCoverageInputs(descriptor);
  const coverageInputs = mergeCoverageInputs(
    baseCoverage,
    input.coverageInputs,
  );
  coverageInputs.mutation = {
    pre: toMutationSnapshot(descriptor.mutation_pre),
    post: toMutationSnapshot(postSnap),
  };

  const draft = {
    namespace: intent.namespace,
    logical_repo: intent.logical_repo,
    source_revision: intent.source_revision,
    artifact_manifest: descriptor.artifact_manifest,
    records: draftRecords,
    relations: draftRelations,
    coverage_report: coverageInputs,
  };

  // 7. Canonicalize (recomputes ids/hash/coverage; verifies via reader).
  const readAtRevision =
    input.readAtRevision ?? bindReadAtRevision(sourceRepoPath, gitOpts);
  let pkg;
  try {
    pkg = canonicalizeCandidatePackage(draft, { readAtRevision });
  } catch (err) {
    if (err instanceof DescobrirError) {
      throw new FinalizeRunError(err.message, { cause: err });
    }
    throw err;
  }

  // 8. Persist idempotently. Only DB write happens here.
  const openStoreFn = input.openStoreFn ?? openStore;
  const persistCandidateFn = input.persistCandidateFn ?? persistCandidate;
  const store = openStoreFn(dbPath);
  let persisted;
  try {
    persisted = persistCandidateFn(store, pkg);
  } finally {
    store.close();
  }

  // 9. Retention: success removes ephemeral run artifacts by default.
  if (!retainRun) removeRunRoot(runRoot);

  return {
    status: "finalized",
    exit_code: FINALIZE_EXIT_OK,
    run_id: runId,
    candidate_id: persisted.candidate_id,
    created: persisted.created === true,
    canonical_graph_hash: pkg.graph_index.canonical_graph_hash,
    coverage: summarizeCoverage(pkg),
  };
}
