/**
 * Mechanical L0 dispatch: Graphify facts → closed Explorer payloads.
 *
 * This is the volume path. One process, all chunks. natural_key is copied from
 * graphify_id; from_type/to_type come from a run-wide node index so a relation
 * may land in a different chunk than its endpoints.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { EmitPayloadsError } from "./errors.mjs";
import { chunkArtifactPath } from "./manifest-builder.mjs";
import { loadRunDescriptor, explorerPayloadPath, RUN_PATHS } from "./run-descriptor.mjs";

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new EmitPayloadsError(message);
}

/**
 * @param {Record<string, unknown>} fact
 */
export function naturalFromNode(fact) {
  if (typeof fact.graphify_id === "string" && fact.graphify_id.length > 0) {
    return fact.graphify_id;
  }
  const key = typeof fact.key === "string" ? fact.key : "";
  return key.startsWith("n:") ? key.slice(2) : key;
}

/**
 * @param {Record<string, unknown>} fact
 */
export function nodeType(fact) {
  const located =
    typeof fact.source_file === "string"
    && fact.source_file.length > 0
    && typeof fact.source_location === "string"
    && fact.source_location.length > 0;
  return located ? "Class" : "ExternalSymbol";
}

/**
 * @param {Record<string, unknown>} fact
 * @param {string} natural
 */
export function nodeName(fact, natural) {
  if (typeof fact.label === "string" && fact.label.length > 0) return fact.label;
  const parts = String(natural).split(/[/_]/);
  return parts[parts.length - 1] || natural;
}

/**
 * @param {Record<string, unknown>} fact
 */
export function relationType(fact) {
  const raw = typeof fact.relation === "string" ? fact.relation : "RELATED";
  const up = raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  return up.length > 0 ? up : "RELATED";
}

/**
 * @param {Record<string, unknown>[]} facts
 * @returns {Map<string, { natural: string, type: string }>}
 */
export function buildNodeIndex(facts) {
  /** @type {Map<string, { natural: string, type: string }>} */
  const nodes = new Map();
  for (const fact of facts) {
    if (fact.kind !== "node" || typeof fact.key !== "string") continue;
    nodes.set(fact.key, { natural: naturalFromNode(fact), type: nodeType(fact) });
  }
  return nodes;
}

/**
 * @param {string} chunkKey
 * @param {Record<string, unknown>[]} facts
 * @param {Map<string, { natural: string, type: string }>} nodeIndex
 */
export function payloadForChunk(chunkKey, facts, nodeIndex) {
  if (typeof chunkKey !== "string" || chunkKey === "") fail("chunk_key must be a non-empty string");
  if (!Array.isArray(facts)) fail("facts must be an array");
  /** @type {object[]} */
  const records = [];
  /** @type {object[]} */
  const relations = [];
  let skipped_relations = 0;
  for (const fact of facts) {
    if (fact.kind === "node") {
      const natural = naturalFromNode(fact);
      const name = nodeName(fact, natural);
      records.push({
        node_key: fact.key,
        type: nodeType(fact),
        natural_key: natural,
        name,
        summary: `Symbol ${name} (${typeof fact.origin === "string" ? fact.origin : "ast"})`,
        attributes: {},
      });
      continue;
    }
    if (fact.kind !== "edge") continue;
    const src = typeof fact.source_key === "string" ? nodeIndex.get(fact.source_key) : undefined;
    const tgt = typeof fact.target_key === "string" ? nodeIndex.get(fact.target_key) : undefined;
    if (!src || !tgt || src.natural === tgt.natural) {
      skipped_relations += 1;
      continue;
    }
    relations.push({
      edge_key: fact.key,
      relation_type: relationType(fact),
      from_type: src.type,
      from_natural_key: src.natural,
      to_type: tgt.type,
      to_natural_key: tgt.natural,
    });
  }
  return {
    payload: { chunk_key: chunkKey, records, relations },
    skipped_relations,
  };
}

/**
 * @param {{ runRoot: string }} input
 */
export function emitPayloads(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("emitPayloads input must be an object");
  }
  const runRoot = input.runRoot;
  if (typeof runRoot !== "string" || runRoot === "" || !isAbsolute(runRoot)) {
    fail("runRoot must be an absolute path");
  }
  const descriptor = loadRunDescriptor(runRoot);
  const chunks = descriptor.chunk_index.chunks;
  /** @type {Map<string, Record<string, unknown>[]>} */
  const factsByChunk = new Map();
  /** @type {Record<string, unknown>[]} */
  const allFacts = [];
  for (const entry of chunks) {
    const rel = chunkArtifactPath(entry.chunk_key);
    const abs = join(runRoot, rel);
    const text = readFileSync(abs, "utf8");
    const facts = text
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
    factsByChunk.set(entry.chunk_key, facts);
    allFacts.push(...facts);
  }
  const nodeIndex = buildNodeIndex(allFacts);
  mkdirSync(join(runRoot, RUN_PATHS.explorerPayloads), { recursive: true });
  let records = 0;
  let relations = 0;
  let skipped_relations = 0;
  for (const entry of chunks) {
    const facts = factsByChunk.get(entry.chunk_key) ?? [];
    const { payload, skipped_relations: skipped } = payloadForChunk(
      entry.chunk_key,
      facts,
      nodeIndex,
    );
    skipped_relations += skipped;
    records += payload.records.length;
    relations += payload.relations.length;
    const relOut = explorerPayloadPath(entry.chunk_key);
    writeFileSync(join(runRoot, relOut), `${JSON.stringify(payload)}\n`);
  }
  return {
    status: "ok",
    run_id: descriptor.run_id,
    chunks: chunks.length,
    records,
    relations,
    skipped_relations,
    node_facts: nodeIndex.size,
  };
}
