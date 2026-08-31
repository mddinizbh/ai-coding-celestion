/**
 * Deterministic Graphify → sanitized JSONL facts + bounded chunks.
 *
 * Emits one keyed fact per line, stable opaque node/edge/hyperedge keys
 * compatible with the Explorer opaqueKey pattern, and a key map of
 * repo-relative source locators for later repository verification (Todo 9).
 * Never invents endpoint/event semantics absent from Graphify.
 */

import { compareCodeUnits } from "./explorer-payload-shape.mjs";
import { GraphifyProjectionError } from "./errors.mjs";
import {
  assertRepoRelativeLocator,
  assertSafeDisplayLabel,
  assertSafeSourceLocation,
} from "./graphify-loader.mjs";
import { sha256Text, stableStringify } from "./stable-json.mjs";

export { GraphifyProjectionError };

/** Default soft byte budget per chunk (UTF-8). */
export const DEFAULT_MAX_CHUNK_BYTES = 8 * 1024;

/** Default max facts per chunk. */
export const DEFAULT_MAX_FACTS_PER_CHUNK = 32;

/** Explorer-compatible opaque key pattern (Todo 5). */
const OPAQUE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,120}$/;

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new GraphifyProjectionError(message);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Locale-independent sort of strings by UTF-16 code unit.
 * @param {string[]} values
 */
function sortKeys(values) {
  return [...values].sort(compareCodeUnits);
}

/**
 * Build a stable opaque key from a Graphify id.
 * @param {"n"|"e"|"h"|"c"} prefix
 * @param {string} material
 * @returns {string}
 */
export function makeOpaqueKey(prefix, material) {
  if (typeof material !== "string" || material.length === 0) {
    fail("opaque key material must be a non-empty string");
  }
  let body;
  if (SAFE_ID_RE.test(material)) {
    body = material;
  } else {
    body = sha256Text(material).slice(0, 32);
  }
  const key = `${prefix}:${body}`;
  if (!OPAQUE_KEY_RE.test(key)) {
    fail("opaque key out of contract");
  }
  if (key.length > 128) {
    fail("opaque key exceeds 128 chars");
  }
  return key;
}

/**
 * @param {string} graphifyId
 */
export function nodeOpaqueKey(graphifyId) {
  return makeOpaqueKey("n", graphifyId);
}

/**
 * Stable edge identity material (order-independent of input array position).
 *
 * Policy: include every stable structural discriminator Graphify emits on an
 * edge — endpoints, relation, locators, context, and confidence. Divergent
 * confidence therefore yields distinct opaque keys and is never silently
 * collapsed into one fact identity.
 *
 * @param {{
 *   source: string,
 *   target: string,
 *   relation: string,
 *   source_file?: string,
 *   source_location?: string,
 *   context?: string,
 *   confidence?: string,
 * }} edge
 */
export function edgeIdentityMaterial(edge) {
  return stableStringify({
    confidence: typeof edge.confidence === "string" ? edge.confidence : "",
    context: typeof edge.context === "string" ? edge.context : "",
    relation: edge.relation,
    source: edge.source,
    source_file: typeof edge.source_file === "string" ? edge.source_file : "",
    source_location: typeof edge.source_location === "string" ? edge.source_location : "",
    target: edge.target,
  });
}

/**
 * @param {Record<string, unknown>} edge
 */
export function edgeOpaqueKey(edge) {
  return makeOpaqueKey("e", edgeIdentityMaterial(/** @type {any} */ (edge)));
}

/**
 * @param {Record<string, unknown>} hyper
 */
export function hyperedgeOpaqueKey(hyper) {
  const id = typeof hyper.id === "string" ? hyper.id : "";
  return makeOpaqueKey("h", id);
}

/**
 * @param {number} index
 */
export function chunkOpaqueKey(index) {
  if (!Number.isInteger(index) || index < 0) {
    fail("chunk index must be a non-negative integer");
  }
  return makeOpaqueKey("c", String(index).padStart(4, "0"));
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertSanitizedLabel(value, label) {
  // Nested relative Graphify file labels ("agent/client/client.go") are valid;
  // machine roots / absolute paths still fail closed via assertSafeDisplayLabel.
  assertSafeDisplayLabel(value, label, fail);
}

/**
 * @param {Record<string, unknown>} node
 * @returns {Record<string, unknown>}
 */
function projectNodeFact(node) {
  const graphifyId = /** @type {string} */ (node.id);
  const key = nodeOpaqueKey(graphifyId);
  assertRepoRelativeLocator(node.source_file, "node.source_file", fail);
  assertSafeSourceLocation(node.source_location, "node.source_location", fail);
  assertSanitizedLabel(node.label, "node.label");

  /** @type {Record<string, unknown>} */
  const fact = {
    key,
    kind: "node",
    graphify_id: graphifyId,
  };
  if (typeof node.label === "string") fact.label = node.label;
  if (typeof node.file_type === "string") fact.file_type = node.file_type;
  if (typeof node.source_file === "string" && node.source_file.length > 0) {
    fact.source_file = node.source_file;
  }
  if (typeof node.source_location === "string" && node.source_location.length > 0) {
    fact.source_location = node.source_location;
  }
  if (typeof node._origin === "string") fact.origin = node._origin;
  return fact;
}

/**
 * @param {Record<string, unknown>} edge
 * @returns {Record<string, unknown>}
 */
function projectEdgeFact(edge) {
  const source = /** @type {string} */ (edge.source);
  const target = /** @type {string} */ (edge.target);
  const relation = /** @type {string} */ (edge.relation);
  assertRepoRelativeLocator(edge.source_file, "edge.source_file", fail);
  assertSafeSourceLocation(edge.source_location, "edge.source_location", fail);
  if (typeof edge.context === "string") {
    if (
      edge.context.includes("/")
      || edge.context.includes("\\")
      || edge.context.includes("..")
      || edge.context.includes("/Users/")
      || edge.context.includes("/private/")
    ) {
      fail("edge.context must not embed path material");
    }
  }

  const key = edgeOpaqueKey(edge);
  /** @type {Record<string, unknown>} */
  const fact = {
    key,
    kind: "edge",
    source_key: nodeOpaqueKey(source),
    target_key: nodeOpaqueKey(target),
    source_graphify_id: source,
    target_graphify_id: target,
    relation,
  };
  if (typeof edge.confidence === "string") fact.confidence = edge.confidence;
  if (typeof edge.source_file === "string" && edge.source_file.length > 0) {
    fact.source_file = edge.source_file;
  }
  if (typeof edge.source_location === "string" && edge.source_location.length > 0) {
    fact.source_location = edge.source_location;
  }
  if (typeof edge.context === "string") fact.context = edge.context;
  if (typeof edge.weight === "number" && Number.isFinite(edge.weight)) fact.weight = edge.weight;
  if (typeof edge._origin === "string") fact.origin = edge._origin;
  return fact;
}

/**
 * @param {Record<string, unknown>} hyper
 * @returns {Record<string, unknown>}
 */
function projectHyperedgeFact(hyper) {
  const id = /** @type {string} */ (hyper.id);
  const nodes = /** @type {string[]} */ (hyper.nodes);
  assertRepoRelativeLocator(hyper.source_file, "hyperedge.source_file", fail);
  assertSafeSourceLocation(hyper.source_location, "hyperedge.source_location", fail);

  const key = hyperedgeOpaqueKey(hyper);
  /** @type {Record<string, unknown>} */
  const fact = {
    key,
    kind: "hyperedge",
    graphify_id: id,
    node_keys: sortKeys(nodes.map((n) => nodeOpaqueKey(n))),
    node_graphify_ids: sortKeys([...nodes]),
  };
  if (typeof hyper.relation === "string") fact.relation = hyper.relation;
  if (typeof hyper.label === "string") {
    assertSanitizedLabel(hyper.label, "hyperedge.label");
    fact.label = hyper.label;
  }
  if (typeof hyper.source_file === "string" && hyper.source_file.length > 0) {
    fact.source_file = hyper.source_file;
  }
  if (typeof hyper.source_location === "string" && hyper.source_location.length > 0) {
    fact.source_location = hyper.source_location;
  }
  if (typeof hyper._origin === "string") fact.origin = hyper._origin;
  return fact;
}

/**
 * @param {Record<string, unknown>} fact
 */
function factLocator(fact) {
  /** @type {Record<string, unknown>} */
  const loc = {};
  if (typeof fact.graphify_id === "string") loc.graphify_id = fact.graphify_id;
  if (typeof fact.source_graphify_id === "string") loc.source_graphify_id = fact.source_graphify_id;
  if (typeof fact.target_graphify_id === "string") loc.target_graphify_id = fact.target_graphify_id;
  if (typeof fact.relation === "string") loc.relation = fact.relation;
  if (typeof fact.source_file === "string") {
    assertRepoRelativeLocator(fact.source_file, "key_map.source_file", fail);
    loc.source_file = fact.source_file;
  }
  if (typeof fact.source_location === "string") {
    assertSafeSourceLocation(fact.source_location, "key_map.source_location", fail);
    loc.source_location = fact.source_location;
  }
  if (Array.isArray(fact.node_graphify_ids)) loc.node_graphify_ids = fact.node_graphify_ids;
  return loc;
}

/**
 * Project a loaded Graphify graph into ordered sanitized facts.
 *
 * @param {{
 *   nodes: unknown[],
 *   relations: unknown[],
 *   hyperedges?: unknown[],
 *   relationsKey: "edges"|"links",
 *   producerVersion: string,
 * }} loaded
 */
export function projectGraphifyFacts(loaded) {
  if (!isPlainObject(loaded)) {
    fail("loaded graph must be an object");
  }
  if (!Array.isArray(loaded.nodes) || !Array.isArray(loaded.relations)) {
    fail("loaded graph must include nodes and relations arrays");
  }
  if (loaded.relationsKey !== "edges" && loaded.relationsKey !== "links") {
    fail("loaded.relationsKey must be edges or links");
  }

  /** @type {Record<string, unknown>[]} */
  const facts = [];
  for (const node of loaded.nodes) {
    if (!isPlainObject(node)) fail("node fact source must be an object");
    facts.push(projectNodeFact(node));
  }
  for (const rel of loaded.relations) {
    if (!isPlainObject(rel)) fail("edge fact source must be an object");
    facts.push(projectEdgeFact(rel));
  }
  const hyperedges = Array.isArray(loaded.hyperedges) ? loaded.hyperedges : [];
  for (const hyper of hyperedges) {
    if (!isPlainObject(hyper)) fail("hyperedge fact source must be an object");
    facts.push(projectHyperedgeFact(hyper));
  }

  facts.sort((a, b) => compareCodeUnits(/** @type {string} */ (a.key), /** @type {string} */ (b.key)));

  const seen = new Set();
  for (const fact of facts) {
    const key = /** @type {string} */ (fact.key);
    if (seen.has(key)) {
      fail(`duplicate projected fact key '${key}'`);
    }
    seen.add(key);
  }

  /** @type {{ nodes: Record<string, object>, edges: Record<string, object>, hyperedges: Record<string, object> }} */
  const key_map = { nodes: {}, edges: {}, hyperedges: {} };
  for (const fact of facts) {
    const key = /** @type {string} */ (fact.key);
    const loc = factLocator(fact);
    if (fact.kind === "node") key_map.nodes[key] = loc;
    else if (fact.kind === "edge") key_map.edges[key] = loc;
    else if (fact.kind === "hyperedge") key_map.hyperedges[key] = loc;
  }

  return {
    facts,
    key_map,
    relations_key: loaded.relationsKey,
    producer_version: loaded.producerVersion,
  };
}

/**
 * @param {Record<string, unknown>[]} facts
 * @returns {string}
 */
export function renderFactsJsonl(facts) {
  if (!Array.isArray(facts)) {
    fail("facts must be an array");
  }
  if (facts.length === 0) return "";
  return `${facts.map((fact) => stableStringify(fact)).join("\n")}\n`;
}

/**
 * Locale-independent fact order by opaque key.
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 */
function byFactKey(a, b) {
  return compareCodeUnits(/** @type {string} */ (a.key), /** @type {string} */ (b.key));
}

/**
 * Node-centric fact order: each node is followed by its outgoing edges and
 * hyperedges (anchor = first node_key present in the node set). Edges whose
 * source_key is not a projected node (and unanchored hyperedges) trail.
 *
 * Hash-order packing put every `e:` fact before every `n:` fact, so ~80% of
 * chunks were edge-only and could not emit a valid relation (both endpoints
 * must exist in the merged record set). Grouping outgoing edges with the
 * source node makes the default worker payload able to emit both.
 *
 * @param {Record<string, unknown>[]} facts
 * @returns {Record<string, unknown>[]}
 */
export function orderFactsNodeCentric(facts) {
  /** @type {Record<string, unknown>[]} */
  const nodes = [];
  /** @type {Record<string, unknown>[]} */
  const edges = [];
  /** @type {Record<string, unknown>[]} */
  const hypers = [];
  /** @type {Record<string, unknown>[]} */
  const rest = [];
  for (const fact of facts) {
    if (fact.kind === "node") nodes.push(fact);
    else if (fact.kind === "edge") edges.push(fact);
    else if (fact.kind === "hyperedge") hypers.push(fact);
    else rest.push(fact);
  }
  nodes.sort(byFactKey);
  edges.sort(byFactKey);
  hypers.sort(byFactKey);
  rest.sort(byFactKey);

  const nodeKeys = new Set(nodes.map((n) => n.key));
  /** @type {Map<string, Record<string, unknown>[]>} */
  const edgesBySource = new Map();
  /** @type {Record<string, unknown>[]} */
  const orphanEdges = [];
  for (const edge of edges) {
    const src = typeof edge.source_key === "string" ? edge.source_key : "";
    if (src !== "" && nodeKeys.has(src)) {
      const list = edgesBySource.get(src) ?? [];
      list.push(edge);
      edgesBySource.set(src, list);
    } else {
      orphanEdges.push(edge);
    }
  }

  /** @type {Map<string, Record<string, unknown>[]>} */
  const hypersByAnchor = new Map();
  /** @type {Record<string, unknown>[]} */
  const orphanHypers = [];
  for (const hyper of hypers) {
    const keys = Array.isArray(hyper.node_keys) ? hyper.node_keys : [];
    const anchor = keys.find((k) => typeof k === "string" && nodeKeys.has(k));
    if (typeof anchor === "string") {
      const list = hypersByAnchor.get(anchor) ?? [];
      list.push(hyper);
      hypersByAnchor.set(anchor, list);
    } else {
      orphanHypers.push(hyper);
    }
  }

  /** @type {Record<string, unknown>[]} */
  const ordered = [];
  for (const node of nodes) {
    const key = /** @type {string} */ (node.key);
    ordered.push(node);
    const outgoing = edgesBySource.get(key);
    if (outgoing) ordered.push(...outgoing);
    const anchored = hypersByAnchor.get(key);
    if (anchored) ordered.push(...anchored);
  }
  ordered.push(...orphanEdges, ...orphanHypers, ...rest);
  return ordered;
}

/**
 * Share of node facts that carry a repo-relative file+line locator.
 * This is the ceiling of `repository_verified_percentage` before any Explorer
 * payload exists: nodes without a locator can only ever be `hipótese`.
 *
 * @param {Record<string, unknown>[]} facts
 */
export function locatorCoverage(facts) {
  if (!Array.isArray(facts)) fail("facts must be an array");
  let total_nodes = 0;
  let nodes_with_locator = 0;
  let total_edges = 0;
  for (const fact of facts) {
    if (!isPlainObject(fact)) continue;
    if (fact.kind === "node") {
      total_nodes += 1;
      if (
        typeof fact.source_file === "string"
        && fact.source_file.length > 0
        && typeof fact.source_location === "string"
        && fact.source_location.length > 0
      ) {
        nodes_with_locator += 1;
      }
    } else if (fact.kind === "edge") {
      total_edges += 1;
    }
  }
  return {
    total_nodes,
    total_edges,
    nodes_with_locator,
    locator_percentage: total_nodes === 0 ? 0 : (100 * nodes_with_locator) / total_nodes,
  };
}

/**
 * @param {Record<string, unknown>[]} facts
 * @param {{ maxChunkBytes?: number, maxFactsPerChunk?: number }} [options]
 */
export function chunkGraphifyFacts(facts, options = {}) {
  if (!Array.isArray(facts)) {
    fail("facts must be an array");
  }
  for (const fact of facts) {
    if (!isPlainObject(fact) || typeof fact.key !== "string") {
      fail("each fact must be an object with a string key");
    }
  }
  const maxBytes =
    typeof options.maxChunkBytes === "number" && options.maxChunkBytes > 0
      ? Math.floor(options.maxChunkBytes)
      : DEFAULT_MAX_CHUNK_BYTES;
  const maxFacts =
    typeof options.maxFactsPerChunk === "number" && options.maxFactsPerChunk > 0
      ? Math.floor(options.maxFactsPerChunk)
      : DEFAULT_MAX_FACTS_PER_CHUNK;

  /** @type {Array<{ chunk_key: string, facts: Record<string, unknown>[], fact_keys: string[], jsonl: string, content_sha256: string, byte_length: number, fact_count: number }>} */
  const chunks = [];
  /** @type {Record<string, unknown>[]} */
  let bucket = [];

  const flush = () => {
    if (bucket.length === 0) return;
    const index = chunks.length;
    const chunk_key = chunkOpaqueKey(index);
    const jsonl = renderFactsJsonl(bucket);
    const content_sha256 = sha256Text(jsonl);
    const byte_length = Buffer.byteLength(jsonl, "utf8");
    const fact_keys = bucket.map((f) => /** @type {string} */ (f.key));
    chunks.push({
      chunk_key,
      facts: bucket,
      fact_keys,
      jsonl,
      content_sha256,
      byte_length,
      fact_count: bucket.length,
    });
    bucket = [];
  };

  const ordered = orderFactsNodeCentric(facts);
  for (const fact of ordered) {
    if (!isPlainObject(fact) || typeof fact.key !== "string") {
      fail("each fact must be an object with a string key");
    }
    const candidate = [...bucket, fact];
    const candidateJsonl = renderFactsJsonl(candidate);
    const candidateBytes = Buffer.byteLength(candidateJsonl, "utf8");
    const wouldExceedFacts = bucket.length > 0 && bucket.length + 1 > maxFacts;
    const wouldExceedBytes = bucket.length > 0 && candidateBytes > maxBytes;
    if (wouldExceedFacts || wouldExceedBytes) {
      flush();
    }
    bucket.push(fact);
  }
  flush();

  const chunk_index = {
    version: /** @type {const} */ (1),
    chunks: chunks.map((c) => ({
      chunk_key: c.chunk_key,
      fact_keys: c.fact_keys,
      content_sha256: c.content_sha256,
      byte_length: c.byte_length,
      fact_count: c.fact_count,
    })),
  };

  return { chunks, chunk_index };
}

/**
 * @param {{
 *   nodes: unknown[],
 *   relations: unknown[],
 *   hyperedges?: unknown[],
 *   relationsKey: "edges"|"links",
 *   producerVersion: string,
 * }} loaded
 * @param {{ maxChunkBytes?: number, maxFactsPerChunk?: number }} [options]
 */
export function projectGraphifyGraph(loaded, options = {}) {
  const projected = projectGraphifyFacts(loaded);
  const jsonl = renderFactsJsonl(projected.facts);
  const { chunks, chunk_index } = chunkGraphifyFacts(projected.facts, options);
  return {
    ...projected,
    jsonl,
    jsonl_sha256: sha256Text(jsonl),
    jsonl_byte_length: Buffer.byteLength(jsonl, "utf8"),
    locator_coverage: locatorCoverage(projected.facts),
    chunks,
    chunk_index,
    chunk_index_json: `${stableStringify(chunk_index)}\n`,
    key_map_json: `${stableStringify(projected.key_map)}\n`,
  };
}
