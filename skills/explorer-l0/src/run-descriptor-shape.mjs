/** Pure closed shape for run descriptor v1 (build/validate/hash/freeze). Nested authority/env rejected. */
import { DescobrirError } from "./errors.mjs";
import { compareCodeUnits } from "./explorer-payload-shape.mjs";
import { chunkArtifactPath, GENERATED_PATHS, recomputeManifestId } from "./manifest-builder.mjs";
import { validateArtifactManifest } from "./schema/descobrir.mjs";
import { sha256Text, stablePretty, stableStringify } from "./stable-json.mjs";
export const RUN_DESCRIPTOR_VERSION = 1;
export const RUN_PATHS = Object.freeze({ descriptor: "run-descriptor.json", artifactManifest: "artifact-manifest.json", mutationPre: "mutation-pre.json", graphifyNative: "graphify/native/graph.json", graphifyFacts: GENERATED_PATHS.factsJsonl, graphifyChunkIndex: GENERATED_PATHS.chunkIndex, graphifyKeyMap: GENERATED_PATHS.keyMap, graphifyChunks: GENERATED_PATHS.chunkDir, explorerPayloads: "explorer/payloads" });
export class RunDescriptorError extends DescobrirError {
  constructor(message, o = {}) {
    super(message, o.cause !== undefined ? { cause: o.cause } : undefined);
    this.name = "RunDescriptorError";
  }
}
const SHA = /^[a-f0-9]{64}$/;
const REV = /^[a-f0-9]{7,64}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const TOKEN = /^[^@\/\s\\]+$/;
const TOP = ["version","status","run_id","package_intent","producer","adapter","acquisition_mode","artifact_manifest","chunk_index","paths","content_hashes","mutation_pre","descriptor_sha256"];
const FORBIDDEN = new Set(["records","relations","coverage","coverage_report","candidate","graph_index","canonical_graph_hash","project_path","db_path","db","run_root","runs_dir","worktree","worktree_path","home","HOME","XDG_DATA_HOME","XDG_CACHE_HOME","raw_source","cwd","absolute_path","data_dir","cache_dir","obsidian_root"]);
const THRESHOLD_KEYS = ["minimum_repository_verified_percentage","require_schema_valid","require_repeatability_pass","require_mutation_equivalent","require_producer_reconciliation_pass"];
const MUTATION_KEYS = ["anchor_object_present","tracked_file_count","dirty_path_count","dirty_names","summary_hash"];
const CHUNK_KEYS = ["chunk_key","fact_keys","content_sha256","byte_length","fact_count"];
const PATHS_FIXED = Object.freeze({ descriptor: RUN_PATHS.descriptor, artifact_manifest: RUN_PATHS.artifactManifest, mutation_pre: RUN_PATHS.mutationPre, graphify_native: RUN_PATHS.graphifyNative, graphify_facts: RUN_PATHS.graphifyFacts, graphify_chunk_index: RUN_PATHS.graphifyChunkIndex, graphify_key_map: RUN_PATHS.graphifyKeyMap, graphify_chunks: RUN_PATHS.graphifyChunks, explorer_payloads: RUN_PATHS.explorerPayloads });
export function failShape(r) { throw new RunDescriptorError(r); }
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export function sealedClone(value) {
  const c = structuredClone(value);
  const f = (n) => {
    if (n === null || typeof n !== "object" || Object.isFrozen(n)) return n;
    if (Array.isArray(n)) for (const i of n) f(i);
    else for (const k of Object.keys(n)) f(n[k]);
    return Object.freeze(n);
  };
  return f(c);
}
export function assertNoForbiddenNested(value, path = "$") {
  if (Array.isArray(value)) {
    value.forEach((x, i) => assertNoForbiddenNested(x, `${path}[${i}]`));
    return;
  }
  if (!plain(value)) return;
  for (const k of Object.keys(value)) {
    if (FORBIDDEN.has(k)) failShape(`forbidden field '${k}' at ${path}`);
    assertNoForbiddenNested(value[k], `${path}.${k}`);
  }
}
export function requireSafeRelativePath(value, label) {
  if (typeof value !== "string" || value === "") failShape(`${label} must be a non-empty string`);
  if (value.includes("\0") || value.startsWith("/") || value.includes("\\") || value.includes("..")) {
    failShape(`${label} must be a safe relative path`);
  }
  for (const seg of value.split("/")) {
    if (!seg || seg === "." || seg === ".." || seg === "\u2024" || seg === "\uFF0E" || /\s/.test(seg)) {
      failShape(`${label} has forbidden path segment`);
    }
  }
  return value;
}
/** Git porcelain dirty_names: spaces OK; strip outer quotes; strip trailing / on untracked dirs; reject abs/drive/NUL/newline/\\ /.|.. */
export function requireDirtyName(value, label) {
  if (typeof value !== "string" || value === "") failShape(`${label} must be a non-empty string`);
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) failShape(`${label} contains forbidden control character`);
  let s = value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  // Git status --porcelain marks untracked directories with a trailing slash (e.g. ".claude/").
  s = s.replace(/\/+$/, "");
  if (s === "") failShape(`${label} is empty after quote strip`);
  if (s.includes("\0") || s.includes("\n") || s.includes("\r")) failShape(`${label} contains forbidden control character`);
  if (s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s)) failShape(`${label} must not be an absolute or drive path`);
  if (s.includes("\\")) failShape(`${label} must not contain backslash`);
  for (const seg of s.split("/")) {
    if (seg === "" || seg === "." || seg === ".." || seg === "\u2024" || seg === "\uFF0E") failShape(`${label} has forbidden path segment`);
  }
  return s;
}
function reqToken(v, l) {
  if (typeof v !== "string" || !TOKEN.test(v) || v === "." || v === ".." || v.includes("..")) {
    failShape(`${l} must be a single safe token`);
  }
  return v;
}
function reqSha(v, l) {
  if (typeof v !== "string" || !SHA.test(v)) failShape(`${l} must be 64 lowercase hex chars`);
  return v;
}
function reqNni(v, l) {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) failShape(`${l} must be a non-negative integer`);
  return v;
}
function exactKeys(obj, allowed, label) {
  const a = new Set(allowed);
  for (const k of Object.keys(obj)) if (!a.has(k)) failShape(`${label} has unknown field '${k}'`);
  for (const k of allowed) if (!Object.prototype.hasOwnProperty.call(obj, k)) failShape(`${label} missing required field '${k}'`);
}
function validateThreshold(t) {
  if (!plain(t)) failShape("package_intent.threshold must be an object");
  assertNoForbiddenNested(t, "package_intent.threshold");
  exactKeys(t, THRESHOLD_KEYS, "package_intent.threshold");
  const min = t.minimum_repository_verified_percentage;
  if (typeof min !== "number" || !Number.isFinite(min) || min < 0 || min > 100) {
    failShape("threshold.minimum_repository_verified_percentage must be in [0, 100]");
  }
  for (const f of THRESHOLD_KEYS.slice(1)) {
    if (typeof t[f] !== "boolean") failShape(`threshold.${f} must be a boolean`);
  }
  return {
    minimum_repository_verified_percentage: min,
    require_schema_valid: t.require_schema_valid,
    require_repeatability_pass: t.require_repeatability_pass,
    require_mutation_equivalent: t.require_mutation_equivalent,
    require_producer_reconciliation_pass: t.require_producer_reconciliation_pass,
  };
}
function validatePackageIntent(intent) {
  if (!plain(intent)) failShape("package_intent must be an object");
  assertNoForbiddenNested(intent, "package_intent");
  const allow = new Set(["namespace", "logical_repo", "source_revision", "threshold"]);
  for (const k of Object.keys(intent)) if (!allow.has(k)) failShape(`package_intent has unknown field '${k}'`);
  for (const k of ["namespace", "logical_repo", "source_revision"]) {
    if (!Object.prototype.hasOwnProperty.call(intent, k)) failShape(`package_intent missing required field '${k}'`);
  }
  const namespace = reqToken(intent.namespace, "package_intent.namespace");
  const logical_repo = reqToken(intent.logical_repo, "package_intent.logical_repo");
  if (typeof intent.source_revision !== "string" || !REV.test(intent.source_revision)) {
    failShape("package_intent.source_revision must be 7-64 lowercase hex chars");
  }
  /** @type {Record<string, unknown>} */
  const out = { namespace, logical_repo, source_revision: intent.source_revision };
  if (intent.threshold !== undefined) out.threshold = validateThreshold(intent.threshold);
  return out;
}
function validateNamed(obj, label, requireVersion) {
  if (!plain(obj)) failShape(`${label} must be an object`);
  assertNoForbiddenNested(obj, label);
  for (const k of Object.keys(obj)) if (k !== "name" && k !== "version") failShape(`${label} has unknown field '${k}'`);
  if (requireVersion) {
    if (typeof obj.version !== "string" || !obj.version) failShape(`${label}.version must be a non-empty string`);
  } else if (typeof obj.name !== "string" || !obj.name) failShape(`${label}.name must be a non-empty string`);
  if (obj.name !== undefined && (typeof obj.name !== "string" || !obj.name)) failShape(`${label}.name must be a non-empty string when present`);
  if (obj.version !== undefined && (typeof obj.version !== "string" || !obj.version)) failShape(`${label}.version must be a non-empty string when present`);
  return {
    ...(typeof obj.name === "string" ? { name: obj.name } : {}),
    ...(typeof obj.version === "string" ? { version: obj.version } : {}),
  };
}
function validateMutationPre(m) {
  if (!plain(m)) failShape("mutation_pre must be an object");
  assertNoForbiddenNested(m, "mutation_pre");
  exactKeys(m, MUTATION_KEYS, "mutation_pre");
  if (typeof m.anchor_object_present !== "boolean") failShape("mutation_pre.anchor_object_present must be a boolean");
  const tracked = reqNni(m.tracked_file_count, "mutation_pre.tracked_file_count");
  const dirtyCount = reqNni(m.dirty_path_count, "mutation_pre.dirty_path_count");
  if (!Array.isArray(m.dirty_names)) failShape("mutation_pre.dirty_names must be an array");
  if (m.dirty_names.length !== dirtyCount) failShape("mutation_pre.dirty_path_count must equal dirty_names.length");
  const dirty_names = m.dirty_names.map((n, i) => requireDirtyName(n, `mutation_pre.dirty_names[${i}]`));
  const sorted = [...dirty_names].sort(compareCodeUnits);
  for (let i = 0; i < dirty_names.length; i++) {
    if (dirty_names[i] !== sorted[i]) failShape("mutation_pre.dirty_names must be sorted by code unit");
  }
  return {
    anchor_object_present: m.anchor_object_present,
    tracked_file_count: tracked,
    dirty_path_count: dirtyCount,
    dirty_names,
    summary_hash: reqSha(m.summary_hash, "mutation_pre.summary_hash"),
  };
}
function validateManifest(manifest, intent, mode, adapter) {
  if (!plain(manifest)) failShape("artifact_manifest must be an object");
  assertNoForbiddenNested(manifest, "artifact_manifest");
  const vr = validateArtifactManifest(manifest);
  if (!vr.valid) {
    failShape(`artifact_manifest schema invalid: ${vr.errors.slice(0, 3).map((e) => `${e.path || "/"}: ${e.message}`).join("; ")}`);
  }
  if (manifest.namespace !== intent.namespace) failShape("artifact_manifest.namespace does not match package_intent");
  if (manifest.logical_repo !== intent.logical_repo) failShape("artifact_manifest.logical_repo does not match package_intent");
  if (manifest.source_revision !== intent.source_revision) failShape("artifact_manifest.source_revision does not match package_intent");
  if (manifest.acquisition_mode !== mode) failShape("artifact_manifest.acquisition_mode does not match descriptor");
  if (!plain(manifest.engine) || typeof manifest.engine.name !== "string" || typeof manifest.engine.profile !== "string") {
    failShape("artifact_manifest.engine name/profile required");
  }
  if (!plain(manifest.freshness) || typeof manifest.freshness.source_revision !== "string") {
    failShape("artifact_manifest.freshness.source_revision is required");
  }
  if (!plain(manifest.adapter) || manifest.adapter.version !== adapter.version) {
    failShape("artifact_manifest.adapter.version does not match descriptor adapter");
  }
  if (typeof adapter.name === "string" && typeof manifest.adapter.name === "string" && manifest.adapter.name !== adapter.name) {
    failShape("artifact_manifest.adapter.name does not match descriptor adapter");
  }
  if (manifest.id !== recomputeManifestId(manifest)) {
    failShape("artifact_manifest.id does not match recomputed manifest identity");
  }
  return manifest;
}
function validateChunkIndex(ci) {
  if (!plain(ci)) failShape("chunk_index must be an object");
  assertNoForbiddenNested(ci, "chunk_index");
  for (const k of Object.keys(ci)) if (k !== "version" && k !== "chunks") failShape(`chunk_index has unknown field '${k}'`);
  if (ci.version !== 1) failShape("chunk_index.version must be 1");
  if (!Array.isArray(ci.chunks)) failShape("chunk_index.chunks must be an array");
  const chunks = [];
  const seen = new Set();
  for (const e of ci.chunks) {
    if (!plain(e)) failShape("chunk_index.chunks entry must be an object");
    exactKeys(e, CHUNK_KEYS, "chunk_index.chunks entry");
    const key = e.chunk_key;
    if (typeof key !== "string" || !OPAQUE.test(key)) failShape("chunk_key is out of contract");
    if (seen.has(key)) failShape(`duplicate chunk_key '${key}'`);
    seen.add(key);
    reqSha(e.content_sha256, `chunk ${key} content_sha256`);
    if (!Array.isArray(e.fact_keys) || e.fact_keys.some((f) => typeof f !== "string" || !f)) {
      failShape(`chunk ${key} fact_keys must be non-empty strings`);
    }
    reqNni(e.byte_length, `chunk ${key} byte_length`);
    reqNni(e.fact_count, `chunk ${key} fact_count`);
    if (e.fact_count !== e.fact_keys.length) failShape(`chunk ${key} fact_count must equal fact_keys.length`);
    chunks.push({
      chunk_key: key, fact_keys: [...e.fact_keys], content_sha256: e.content_sha256,
      byte_length: e.byte_length, fact_count: e.fact_count,
    });
  }
  return { version: 1, chunks };
}
function validateInventory(manifest, chunkIndex, paths, hashes, mutationPre) {
  if (!plain(paths)) failShape("paths must be an object");
  assertNoForbiddenNested(paths, "paths");
  for (const [k, exp] of Object.entries(PATHS_FIXED)) {
    if (paths[k] !== exp) failShape(`paths.${k} must be '${exp}'`);
  }
  if (!plain(paths.chunks)) failShape("paths.chunks must be an object");
  for (const k of Object.keys(paths)) {
    if (k !== "chunks" && !Object.prototype.hasOwnProperty.call(PATHS_FIXED, k)) failShape(`paths has unknown field '${k}'`);
  }
  const manifestPaths = manifest.artifacts.map((a) => a.path).sort(compareCodeUnits);
  const fromIndex = chunkIndex.chunks.map((c) => chunkArtifactPath(c.chunk_key)).sort(compareCodeUnits);
  const fromManifest = manifestPaths.filter((p) => p.startsWith(`${RUN_PATHS.graphifyChunks}/`)).sort(compareCodeUnits);
  if (stableStringify(fromIndex) !== stableStringify(fromManifest)) {
    failShape("chunk_index paths must equal manifest generated chunk paths");
  }
  /** @type {Record<string, string>} */
  const chunkMap = {};
  for (const e of chunkIndex.chunks) {
    const exp = chunkArtifactPath(e.chunk_key);
    if (paths.chunks[e.chunk_key] === undefined) failShape(`paths.chunks missing '${e.chunk_key}'`);
    if (requireSafeRelativePath(paths.chunks[e.chunk_key], `paths.chunks['${e.chunk_key}']`) !== exp) {
      failShape(`paths.chunks['${e.chunk_key}'] must be '${exp}'`);
    }
    chunkMap[e.chunk_key] = exp;
  }
  for (const k of Object.keys(paths.chunks)) {
    if (!chunkIndex.chunks.some((c) => c.chunk_key === k)) failShape(`paths.chunks has unexpected '${k}'`);
  }
  if (!plain(hashes)) failShape("content_hashes must be an object");
  assertNoForbiddenNested(hashes, "content_hashes");
  const expectedKeys = [RUN_PATHS.artifactManifest, RUN_PATHS.mutationPre, ...manifestPaths].sort(compareCodeUnits);
  const actualKeys = Object.keys(hashes).sort(compareCodeUnits);
  if (stableStringify(actualKeys) !== stableStringify(expectedKeys)) {
    failShape("content_hashes keys must equal {artifact-manifest.json, mutation-pre.json} ∪ manifest artifact paths");
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const k of actualKeys) {
    requireSafeRelativePath(k, "content_hashes key");
    out[k] = reqSha(hashes[k], `content_hashes['${k}']`);
  }
  if (out[RUN_PATHS.artifactManifest] !== sha256Text(stablePretty(manifest))) {
    failShape("content_hashes for artifact-manifest.json does not match manifest bytes");
  }
  if (out[RUN_PATHS.mutationPre] !== sha256Text(stablePretty(mutationPre))) {
    failShape("content_hashes for mutation-pre.json does not match mutation_pre bytes");
  }
  for (const a of manifest.artifacts) {
    if (out[a.path] !== a.content_sha256) failShape(`content_hashes mismatch for artifact '${a.path}'`);
  }
  for (const e of chunkIndex.chunks) {
    const rel = chunkArtifactPath(e.chunk_key);
    if (out[rel] !== e.content_sha256) failShape(`content_hashes mismatch for chunk '${e.chunk_key}'`);
  }
  return { paths: { ...PATHS_FIXED, chunks: chunkMap }, content_hashes: out };
}
export function computeDescriptorSha256(body) {
  return sha256Text(stableStringify(body));
}
function assemble(src) {
  const run_id = reqToken(src.run_id, "run_id");
  const package_intent = validatePackageIntent(src.package_intent);
  const producer = validateNamed(src.producer, "producer", false);
  if (!producer.name) failShape("producer.name must be a non-empty string");
  const adapter = validateNamed(src.adapter, "adapter", true);
  if (!adapter.version) failShape("adapter.version must be a non-empty string");
  if (src.acquisition_mode !== "fresh" && src.acquisition_mode !== "reused") {
    failShape("acquisition_mode must be 'fresh' or 'reused'");
  }
  const acquisition_mode = src.acquisition_mode;
  const artifact_manifest = validateManifest(src.artifact_manifest, package_intent, acquisition_mode, adapter);
  const chunk_index = validateChunkIndex(src.chunk_index);
  const mutation_pre = validateMutationPre(src.mutation_pre);
  /** @type {Record<string, string>} */
  const chunkMap = {};
  for (const e of chunk_index.chunks) chunkMap[e.chunk_key] = chunkArtifactPath(e.chunk_key);
  const pathsIn = { ...PATHS_FIXED, chunks: chunkMap };
  /** @type {Record<string, string>} */
  const hashesIn = {
    [RUN_PATHS.artifactManifest]: sha256Text(stablePretty(artifact_manifest)),
    [RUN_PATHS.mutationPre]: sha256Text(stablePretty(mutation_pre)),
  };
  for (const a of artifact_manifest.artifacts) hashesIn[a.path] = a.content_sha256;
  const { paths, content_hashes } = validateInventory(
    artifact_manifest, chunk_index, src.paths ?? pathsIn, src.content_hashes ?? hashesIn, mutation_pre,
  );
  return {
    version: RUN_DESCRIPTOR_VERSION, status: "prepared", run_id, package_intent, producer, adapter,
    acquisition_mode, artifact_manifest, chunk_index, paths, content_hashes, mutation_pre,
  };
}
export function buildRunDescriptor(input) {
  if (!plain(input)) failShape("buildRunDescriptor input must be an object");
  assertNoForbiddenNested(input, "input");
  const src = structuredClone(input);
  for (const k of Object.keys(src)) {
    if (!["run_id", "package_intent", "producer", "adapter", "acquisition_mode", "artifact_manifest", "chunk_index", "mutation_pre"].includes(k)) {
      failShape(`buildRunDescriptor unknown input field '${k}'`);
    }
  }
  const body = assemble(src);
  return sealedClone({ ...body, descriptor_sha256: computeDescriptorSha256(body) });
}
export function validateRunDescriptor(descriptor) {
  if (!plain(descriptor)) failShape("run descriptor must be an object");
  assertNoForbiddenNested(descriptor, "$");
  const src = structuredClone(descriptor);
  for (const k of Object.keys(src)) if (!TOP.includes(k)) failShape(`unknown field '${k}' on run descriptor`);
  for (const k of TOP) if (!Object.prototype.hasOwnProperty.call(src, k)) failShape(`run descriptor missing required field '${k}'`);
  if (src.version !== RUN_DESCRIPTOR_VERSION) failShape(`run descriptor version must be ${RUN_DESCRIPTOR_VERSION}`);
  if (src.status !== "prepared") failShape("run descriptor status must be 'prepared'");
  const body = assemble(src);
  const expected = reqSha(src.descriptor_sha256, "descriptor_sha256");
  if (computeDescriptorSha256(body) !== expected) failShape("descriptor_sha256 does not match descriptor content");
  return sealedClone({ ...body, descriptor_sha256: expected });
}
export function explorerPayloadPath(chunkKey) {
  if (typeof chunkKey !== "string" || !chunkKey) failShape("chunk_key must be a non-empty string");
  if (chunkKey.includes("\0") || !OPAQUE.test(chunkKey) || /[/\\]/.test(chunkKey) || chunkKey.includes("..")) {
    failShape("chunk_key is out of contract for payload path");
  }
  const safe = chunkKey.replace(/:/g, "_");
  if (safe.includes("/") || safe.includes("..")) failShape("chunk_key yields unsafe payload filename");
  return `${RUN_PATHS.explorerPayloads}/${safe}.json`;
}
