/**
 * Canonical graph hash, Artifact Manifest id, and GraphIndex builders.
 * Summary (narrative) is excluded from the hash payload per contract.
 */

import { sha256Text, stableStringify, stableValue } from "./stable-json.mjs";
import { compareRaw } from "./layered-id.mjs";

const RECORD_FIELDS = [
  "id",
  "namespace",
  "type",
  "name",
  "attributes",
  "status",
  "source_revision",
  "source_engine",
  "evidence",
];

const RELATION_FIELDS = [
  "id",
  "namespace",
  "from_record",
  "relation_type",
  "to_record",
  "status",
  "source_revision",
  "source_engine",
  "evidence",
];

/**
 * @param {Record<string, unknown>} value
 * @param {string[]} fields
 */
function project(value, fields) {
  return Object.fromEntries(
    fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]),
  );
}

/**
 * @param {{ id: string }} left
 * @param {{ id: string }} right
 */
function byId(left, right) {
  // Plan-locked: raw code-unit compare (ADR 0009). NEVER localeCompare.
  return compareRaw(left.id, right.id);
}

/**
 * SHA-256 over the canonical projection of records + relations.
 * @param {{ records: object[], relations: object[] }} graph
 * @returns {string}
 */
export function canonicalGraphHash({ records, relations }) {
  const graph = {
    records: records.map((record) => project(record, RECORD_FIELDS)).sort(byId),
    relations: relations.map((relation) => project(relation, RELATION_FIELDS)).sort(byId),
  };
  return sha256Text(stableStringify(graph));
}

/**
 * @param {object} input
 * @returns {object}
 */
export function createArtifactManifest({
  namespace,
  logicalRepo,
  sourceRevision,
  engine,
  adapter,
  acquisitionMode,
  artifacts,
  freshness,
}) {
  const identity = {
    namespace,
    logical_repo: logicalRepo,
    source_revision: sourceRevision,
    engine,
    artifact_content_sha256: artifacts.map(({ content_sha256 }) => content_sha256).sort(),
  };

  return {
    id: `manifest:${sha256Text(stableStringify(stableValue(identity)))}`,
    namespace,
    logical_repo: logicalRepo,
    source_revision: sourceRevision,
    engine,
    adapter,
    acquisition_mode: acquisitionMode,
    artifacts: [...artifacts].sort((left, right) => compareRaw(left.path, right.path)),
    freshness,
  };
}

/**
 * @param {object} input
 * @returns {object}
 */
export function createGraphIndex({
  namespace,
  sourceRevision,
  artifactManifestId,
  engine,
  graph,
  metadata,
}) {
  const digest = canonicalGraphHash(graph);
  const index = {
    id: `graph-index:${digest}`,
    namespace,
    source_revision: sourceRevision,
    artifact_manifest_id: artifactManifestId,
    engine,
    record_ids: graph.records.map(({ id }) => id).sort(),
    relation_ids: graph.relations.map(({ id }) => id).sort(),
    counts: {
      records: graph.records.length,
      relations: graph.relations.length,
    },
    canonical_graph_hash: digest,
  };
  return metadata === undefined ? index : { ...index, metadata };
}
