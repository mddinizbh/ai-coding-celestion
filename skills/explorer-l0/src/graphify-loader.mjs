/**
 * Strict Graphify output loader.
 *
 * Narrow seam: load a Graphify output directory or in-memory object, enforce
 * the pinned producer version and top-level contract, validate node/relation
 * endpoints and recognized hyperedges, and reject absolute/traversal paths and
 * raw source payloads before any projection.
 *
 * Error messages never embed absolute machine paths (not even from errno).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  GraphifyLoaderError,
  GraphifyVersionError,
} from "./errors.mjs";
import {
  GRAPHIFY_PINNED_VERSION,
  GraphifyContractError,
  assertGraphifyExtractionContract,
} from "./graphify-contract.mjs";

export { GraphifyLoaderError, GraphifyVersionError };

const GRAPH_FILE = "graph.json";
const PRODUCER_FILE = "producer.json";

/** Fields that must never appear on Graphify entities (raw source / secrets). */
const BANNED_ENTITY_FIELDS = new Set([
  "source_text",
  "raw_source",
  "code",
  "content",
  "body",
  "token",
  "api_key",
  "secret",
  "password",
  "authorization",
  "access_token",
]);

/**
 * @param {string} message
 * @returns {never}
 */
function failLoad(message) {
  throw new GraphifyLoaderError(message);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Repo-relative locator: forward-slash segments, no absolute roots, no `.`/`..`,
 * no empty segments, no backslash, no machine-path markers.
 * Used for source_file and any path-like artifact locator before key_map.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {(message: string) => never} [fail]
 */
export function assertRepoRelativeLocator(value, label, fail = failLoad) {
  // Graphify emits "" for external/stdlib symbols with no in-repo locator.
  // Treat empty the same as absent so optional locators stay optional.
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string") {
    fail(`${label} must be a non-empty repo-relative path`);
  }
  const path = value;
  if (
    path.startsWith("/")
    || path.startsWith("\\")
    || /^[A-Za-z]:[\\/]/.test(path)
    || path.includes("\\")
    || path.includes("\0")
    || path.includes("/Users/")
    || path.includes("/home/")
    || path.includes("/private/")
    || path.includes("/var/folders/")
    || path.includes("IdeaProjects")
  ) {
    fail(`${label} must be a safe repo-relative path`);
  }
  const segments = path.split("/");
  if (segments.length === 0) {
    fail(`${label} must be a safe repo-relative path`);
  }
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      fail(`${label} must not contain empty or traversal path segments`);
    }
    if (/[%?#@\s]/.test(segment)) {
      fail(`${label} contains reserved path characters`);
    }
  }
}

/**
 * source_location is a line token (e.g. L1), not a filesystem path — still
 * reject absolute/traversal/machine markers so they never reach key_map.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {(message: string) => never} [fail]
 */
export function assertSafeSourceLocation(value, label, fail = failLoad) {
  // Empty string = absent (Graphify external symbols).
  if (value === undefined || value === null || value === "") return;
  if (typeof value !== "string") {
    fail(`${label} must be a non-empty string when present`);
  }
  if (
    value.includes("/")
    || value.includes("\\")
    || value.includes("..")
    || value.startsWith("/")
    || /^[A-Za-z]:/.test(value)
    || value.includes("/Users/")
    || value.includes("/private/")
    || value.includes("\n")
    || value.includes("\r")
    || value.includes("\0")
  ) {
    fail(`${label} must be a safe line locator without path material`);
  }
}

/**
 * @param {Record<string, unknown>} entity
 * @param {string} label
 */
function assertNoBannedFields(entity, label) {
  for (const key of Object.keys(entity)) {
    if (BANNED_ENTITY_FIELDS.has(key)) {
      failLoad(`${label} contains banned field '${key}'`);
    }
  }
}

/**
 * @param {unknown} node
 * @param {number} index
 */
/**
 * Drop empty optional locators so downstream never treats "" as a real path.
 * @param {Record<string, unknown>} entity
 */
function normalizeOptionalLocators(entity) {
  for (const key of ["source_file", "source_location"]) {
    if (entity[key] === "") {
      delete entity[key];
    }
  }
}

function assertNode(node, index) {
  const label = `nodes[${index}]`;
  if (!isPlainObject(node)) {
    failLoad(`${label} must be an object`);
  }
  assertNoBannedFields(node, label);
  if (typeof node.id !== "string" || node.id.length === 0) {
    failLoad(`${label}.id must be a non-empty string`);
  }
  normalizeOptionalLocators(node);
  if (node.source_file !== undefined) {
    assertRepoRelativeLocator(node.source_file, `${label}.source_file`);
  }
  if (node.source_location !== undefined) {
    assertSafeSourceLocation(node.source_location, `${label}.source_location`);
  }
  if (typeof node.label === "string") {
    // Labels may be ".Greet()" or nested file fragments like "agent/client/client.go"
    // (Graphify AST file nodes). Reject only absolute/machine path material and
    // backslash paths — not repo-relative nested labels that legitimately contain "/".
    assertSafeDisplayLabel(node.label, `${label}.label`);
  }
}

/**
 * Display labels from Graphify: allow relative nested fragments with "/",
 * reject absolute roots, machine markers, backslashes, and traversal.
 *
 * @param {unknown} value
 * @param {string} label
 * @param {(message: string) => never} [fail]
 */
export function assertSafeDisplayLabel(value, label, fail = failLoad) {
  if (value === undefined) return;
  if (typeof value !== "string") {
    fail(`${label} must be a string when present`);
  }
  if (value.length === 0) return;
  if (
    value.includes("\\")
    || value.includes("\0")
    || value.includes("\n")
    || value.includes("\r")
    || value.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(value)
    || value.includes("/Users/")
    || value.includes("/home/")
    || value.includes("/private/")
    || value.includes("/var/folders/")
    || value.includes("IdeaProjects")
    || value.includes("://")
  ) {
    fail(`${label} must not embed path material`);
  }
  // Nested relative labels ("pkg/foo.go") are OK; reject empty/traversal segments.
  if (value.includes("/")) {
    const segments = value.split("/");
    for (const segment of segments) {
      if (segment === "" || segment === "." || segment === "..") {
        fail(`${label} must not embed path material`);
      }
    }
  }
}

/**
 * @param {unknown} rel
 * @param {number} index
 * @param {string} relationsKey
 */
function assertRelation(rel, index, relationsKey) {
  const label = `${relationsKey}[${index}]`;
  if (!isPlainObject(rel)) {
    failLoad(`${label} must be an object`);
  }
  assertNoBannedFields(rel, label);
  if (typeof rel.source !== "string" || rel.source.length === 0) {
    failLoad(`${label}.source endpoint must be a non-empty string`);
  }
  if (typeof rel.target !== "string" || rel.target.length === 0) {
    failLoad(`${label}.target endpoint must be a non-empty string`);
  }
  if (typeof rel.relation !== "string" || rel.relation.length === 0) {
    failLoad(`${label}.relation must be a non-empty string`);
  }
  normalizeOptionalLocators(rel);
  if (rel.source_file !== undefined) {
    assertRepoRelativeLocator(rel.source_file, `${label}.source_file`);
  }
  if (rel.source_location !== undefined) {
    assertSafeSourceLocation(rel.source_location, `${label}.source_location`);
  }
  if (typeof rel.context === "string") {
    if (
      rel.context.includes("/")
      || rel.context.includes("\\")
      || rel.context.includes("..")
      || rel.context.includes("/Users/")
      || rel.context.includes("/private/")
    ) {
      failLoad(`${label}.context must not embed path material`);
    }
  }
}

/**
 * Recognized Graphify hyperedge: non-empty id + non-empty node id list.
 * @param {unknown} hyper
 * @param {number} index
 */
function assertRecognizedHyperedge(hyper, index) {
  const label = `hyperedges[${index}]`;
  if (!isPlainObject(hyper)) {
    failLoad(`${label} must be an object`);
  }
  assertNoBannedFields(hyper, label);
  if (typeof hyper.id !== "string" || hyper.id.length === 0) {
    failLoad(`${label}.id must be a non-empty string`);
  }
  if (!Array.isArray(hyper.nodes) || hyper.nodes.length === 0) {
    failLoad(`${label}.nodes must be a non-empty array of node ids`);
  }
  for (let i = 0; i < hyper.nodes.length; i += 1) {
    const nodeId = hyper.nodes[i];
    if (typeof nodeId !== "string" || nodeId.length === 0) {
      failLoad(`${label}.nodes[${i}] must be a non-empty string`);
    }
  }
  normalizeOptionalLocators(hyper);
  if (hyper.source_file !== undefined) {
    assertRepoRelativeLocator(hyper.source_file, `${label}.source_file`);
  }
  if (hyper.source_location !== undefined) {
    assertSafeSourceLocation(hyper.source_location, `${label}.source_location`);
  }
}

/**
 * @param {unknown[]} nodes
 * @param {unknown[]} relations
 * @param {"edges"|"links"} relationsKey
 * @param {unknown} hyperedgesRaw
 */
function validateEntities(nodes, relations, relationsKey, hyperedgesRaw) {
  for (let i = 0; i < nodes.length; i += 1) {
    assertNode(nodes[i], i);
  }
  for (let i = 0; i < relations.length; i += 1) {
    assertRelation(relations[i], i, relationsKey);
  }

  if (hyperedgesRaw === undefined) {
    return [];
  }
  if (!Array.isArray(hyperedgesRaw)) {
    failLoad("hyperedges must be an array when present");
  }
  for (let i = 0; i < hyperedgesRaw.length; i += 1) {
    assertRecognizedHyperedge(hyperedgesRaw[i], i);
  }
  return hyperedgesRaw;
}

/**
 * @param {string} producerVersion
 */
function assertProducerVersion(producerVersion) {
  if (typeof producerVersion !== "string" || producerVersion.length === 0) {
    throw new GraphifyVersionError(
      "Graphify producer version is required for extraction load",
    );
  }
  if (producerVersion !== GRAPHIFY_PINNED_VERSION) {
    throw new GraphifyVersionError(
      `Unsupported Graphify producer version "${producerVersion}"; pinned is ${GRAPHIFY_PINNED_VERSION}`,
    );
  }
}

/**
 * Read a required artifact by relative name. Never interpolates absolute paths
 * or errno messages into typed errors.
 *
 * @param {string} dir
 * @param {string} fileName
 * @returns {{ text: string, bytes: Buffer }}
 */
function readRequiredFile(dir, fileName) {
  if (typeof dir !== "string" || dir.length === 0) {
    failLoad("Graphify output directory must be a non-empty string");
  }
  if (
    typeof fileName !== "string"
    || fileName.length === 0
    || isAbsolute(fileName)
    || fileName.includes("..")
    || fileName.includes("/")
    || fileName.includes("\\")
  ) {
    failLoad("Graphify artifact file name must be a plain relative segment");
  }
  const absPath = join(dir, fileName);
  if (!existsSync(absPath)) {
    failLoad(`Graphify graph file missing: ${fileName}`);
  }
  let st;
  try {
    st = statSync(absPath);
  } catch {
    failLoad(`Graphify graph file unreadable: ${fileName}`);
  }
  if (!st.isFile()) {
    failLoad(`Graphify graph path is not a file: ${fileName}`);
  }
  let bytes;
  try {
    bytes = readFileSync(absPath);
  } catch {
    // Intentionally drop errno/path — never leak absPath or err.path.
    failLoad(`Graphify graph file unreadable: ${fileName}`);
  }
  return { text: bytes.toString("utf8"), bytes };
}

/**
 * @param {string} dir
 * @returns {{ version: string, raw?: object } | null}
 */
function readProducerIfPresent(dir) {
  const absPath = join(dir, PRODUCER_FILE);
  if (!existsSync(absPath)) {
    return null;
  }
  let text;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    failLoad("Graphify producer file unreadable: producer.json");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    failLoad("Graphify producer file is not valid JSON");
  }
  if (!isPlainObject(parsed) || typeof parsed.version !== "string") {
    failLoad("Graphify producer file must include a string version");
  }
  return { version: parsed.version, raw: parsed };
}

/**
 * @param {string} text
 * @param {string} label
 */
function parseJsonObject(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    failLoad(`${label} is not valid JSON`);
  }
  if (!isPlainObject(parsed)) {
    failLoad(`${label} must be a JSON object`);
  }
  return parsed;
}

/**
 * @typedef {object} LoadedGraphify
 * @property {Record<string, unknown>} graph
 * @property {string} producerVersion
 * @property {"edges"|"links"} relationsKey
 * @property {unknown[]} nodes
 * @property {unknown[]} relations
 * @property {unknown[]} hyperedges
 * @property {Buffer} nativeBytes
 * @property {string} nativeRelativePath
 * @property {object|null} producer
 */

/**
 * Load and strictly validate a Graphify extraction directory or object.
 *
 * Directory form expects `graph.json` and optional `producer.json`.
 * Object form: `{ graph, producerVersion }` or a bare graph with
 * `options.producerVersion`.
 *
 * @param {string | { graph?: unknown, producerVersion?: string, graphify_version?: string, nativeBytes?: Buffer|string, nativeRelativePath?: string }} source
 * @param {{ producerVersion?: string, graphFileName?: string }} [options]
 * @returns {LoadedGraphify}
 */
export function loadGraphifyOutput(source, options = {}) {
  /** @type {Record<string, unknown>} */
  let graph;
  /** @type {string|undefined} */
  let producerVersion = options.producerVersion;
  /** @type {Buffer} */
  let nativeBytes;
  let nativeRelativePath = GRAPH_FILE;
  /** @type {object|null} */
  let producer = null;

  if (typeof source === "string") {
    const graphFileName =
      typeof options.graphFileName === "string" && options.graphFileName.length > 0
        ? options.graphFileName
        : GRAPH_FILE;
    const file = readRequiredFile(source, graphFileName);
    graph = parseJsonObject(file.text, graphFileName);
    nativeBytes = file.bytes;
    nativeRelativePath = graphFileName;
    const fromProducer = readProducerIfPresent(source);
    if (fromProducer) {
      producer = fromProducer.raw ?? null;
      if (producerVersion === undefined) {
        producerVersion = fromProducer.version;
      }
    }
  } else if (isPlainObject(source)) {
    const record = source;
    if (Object.prototype.hasOwnProperty.call(record, "graph")) {
      if (!isPlainObject(record.graph)) {
        failLoad("source.graph must be a JSON object");
      }
      graph = /** @type {Record<string, unknown>} */ (record.graph);
      if (typeof record.producerVersion === "string") {
        producerVersion = producerVersion ?? record.producerVersion;
      }
      if (typeof record.graphify_version === "string") {
        producerVersion = producerVersion ?? record.graphify_version;
      }
      if (record.nativeBytes !== undefined) {
        nativeBytes =
          typeof record.nativeBytes === "string"
            ? Buffer.from(record.nativeBytes, "utf8")
            : Buffer.from(/** @type {Buffer} */ (record.nativeBytes));
      } else {
        nativeBytes = Buffer.from(JSON.stringify(graph), "utf8");
      }
      if (typeof record.nativeRelativePath === "string" && record.nativeRelativePath.length > 0) {
        if (
          record.nativeRelativePath.includes("..")
          || record.nativeRelativePath.startsWith("/")
          || record.nativeRelativePath.includes("\\")
        ) {
          failLoad("nativeRelativePath must be a safe relative path");
        }
        nativeRelativePath = record.nativeRelativePath;
      }
    } else {
      graph = record;
      nativeBytes = Buffer.from(JSON.stringify(graph), "utf8");
      if (typeof record.graphify_version === "string") {
        producerVersion = producerVersion ?? record.graphify_version;
      }
    }
  } else {
    failLoad("Graphify source must be a directory path or object");
  }

  if (typeof graph.graphify_version === "string" && producerVersion === undefined) {
    producerVersion = graph.graphify_version;
  }

  assertProducerVersion(producerVersion ?? "");

  let contract;
  try {
    contract = assertGraphifyExtractionContract(graph, {
      producerVersion: /** @type {string} */ (producerVersion),
    });
  } catch (err) {
    if (err instanceof GraphifyContractError) {
      if (/version/i.test(err.message) && /unsupported|pinned|required/i.test(err.message)) {
        throw new GraphifyVersionError(err.message);
      }
      throw new GraphifyLoaderError(err.message, { cause: err });
    }
    throw err;
  }

  const hyperedges = validateEntities(
    contract.nodes,
    contract.relations,
    contract.relationsKey,
    graph.hyperedges,
  );

  return {
    graph,
    producerVersion: /** @type {string} */ (producerVersion),
    relationsKey: contract.relationsKey,
    nodes: contract.nodes,
    relations: contract.relations,
    hyperedges,
    nativeBytes,
    nativeRelativePath,
    producer,
  };
}
