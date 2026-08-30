/**
 * Preflight contract for pinned Graphify extraction output.
 * Narrow seam: producer version + top-level shape (nodes + edges|links).
 * Full loader/normalization belongs to a later module.
 */

import { DescobrirError } from "./errors.mjs";

/** Pinned graphifyy package version accepted by Descobrir. */
export const GRAPHIFY_PINNED_VERSION = "0.9.32";

/** Exact uv/pip package spec for managed setup (never floating). */
export const GRAPHIFY_PACKAGE_SPEC = `graphifyy==${GRAPHIFY_PINNED_VERSION}`;

/**
 * Upstream Graphify source commit corresponding to the pinned package.
 * @see docs/adr/0004-cross-service-stitching-c4.md
 */
export const GRAPHIFY_PINNED_SOURCE_COMMIT =
  "00efd6e7969837ae4a9f11d8d504dcd3b20b09df";

export class GraphifyContractError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "GraphifyContractError";
  }
}

/**
 * @typedef {object} GraphifyExtractionContract
 * @property {unknown[]} nodes
 * @property {"edges"|"links"} relationsKey
 * @property {unknown[]} relations
 */

/**
 * Validate producer version and top-level Graphify extract shape.
 * Accepts exactly `nodes` plus one of `edges`|`links` (arrays).
 *
 * @param {unknown} graph
 * @param {{ producerVersion?: string }} [options]
 * @returns {GraphifyExtractionContract}
 */
export function assertGraphifyExtractionContract(graph, options = {}) {
  const producerVersion = options.producerVersion;
  if (typeof producerVersion !== "string" || producerVersion.length === 0) {
    throw new GraphifyContractError(
      "Graphify producer version is required for extraction preflight",
    );
  }
  if (producerVersion !== GRAPHIFY_PINNED_VERSION) {
    throw new GraphifyContractError(
      `Unsupported Graphify producer version "${producerVersion}"; pinned is ${GRAPHIFY_PINNED_VERSION}`,
    );
  }

  if (graph === null || typeof graph !== "object" || Array.isArray(graph)) {
    throw new GraphifyContractError(
      "Graphify extraction must be a JSON object",
    );
  }

  const record = /** @type {Record<string, unknown>} */ (graph);

  if (!Object.prototype.hasOwnProperty.call(record, "nodes")) {
    throw new GraphifyContractError(
      "Graphify extraction must include a nodes array",
    );
  }
  if (!Array.isArray(record.nodes)) {
    throw new GraphifyContractError(
      "Graphify extraction nodes must be an array",
    );
  }

  const hasEdges = Object.prototype.hasOwnProperty.call(record, "edges");
  const hasLinks = Object.prototype.hasOwnProperty.call(record, "links");

  if (hasEdges === hasLinks) {
    throw new GraphifyContractError(
      "Graphify extraction must include exactly one of edges or links",
    );
  }

  /** @type {"edges"|"links"} */
  const relationsKey = hasEdges ? "edges" : "links";
  const relations = record[relationsKey];
  if (!Array.isArray(relations)) {
    throw new GraphifyContractError(
      `Graphify extraction ${relationsKey} must be an array`,
    );
  }

  return {
    nodes: record.nodes,
    relationsKey,
    relations,
  };
}
