/**
 * Coverage Report derivation (contract-stable).
 * `passed`, provenance counts, and status histogram are NEVER caller authority.
 */

import {
  computePassed,
  deriveProducerBaseline,
  deriveProvenance,
  deriveStatusCounts,
  artifactEvidenceResolves,
  wellFormedRange,
} from "./coverage-metrics.mjs";
import { DescobrirError } from "./errors.mjs";

export { artifactEvidenceResolves, wellFormedRange };

export class CoverageReportError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "CoverageReportError";
  }
}

/** @param {string} reason */
function fail(reason) {
  throw new CoverageReportError(reason);
}

/** @param {unknown} value @param {string} label */
function requireNonEmpty(value, label) {
  if (typeof value !== "string" || value === "") {
    fail(`${label} must be a non-empty string`);
  }
}

/** @param {unknown} threshold */
function validateThreshold(threshold) {
  if (threshold === null || typeof threshold !== "object" || Array.isArray(threshold)) {
    fail("threshold must be an object");
  }
  const t = /** @type {Record<string, unknown>} */ (threshold);
  if (typeof t.minimum_repository_verified_percentage !== "number") {
    fail("threshold.minimum_repository_verified_percentage must be a number");
  }
  for (const k of [
    "require_schema_valid",
    "require_repeatability_pass",
    "require_mutation_equivalent",
    "require_producer_reconciliation_pass",
  ]) {
    if (typeof t[k] !== "boolean") fail(`threshold.${k} must be a boolean`);
  }
}

/**
 * @param {unknown} manifest
 * @param {string} artifactManifestId
 */
function validateManifest(manifest, artifactManifestId) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("manifest must be an object");
  }
  const m = /** @type {Record<string, unknown>} */ (manifest);
  if (typeof m.id !== "string" || m.id === "") fail("manifest.id must be a non-empty string");
  if (!Array.isArray(m.artifacts)) fail("manifest.artifacts must be an array");
  if (m.id !== artifactManifestId) fail("manifest.id must match artifact_manifest_id");
}

/**
 * @param {object} input
 * @returns {object}
 */
export function coverageReport({
  id,
  namespace,
  sourceRevision,
  artifactManifestId,
  graphIndexId,
  records,
  relations,
  manifest,
  schemaResult,
  unresolvedIds,
  repeatability,
  mutation,
  threshold,
  producerDeclaredCounts,
  producerIndexedCounts,
  producerExplanations,
  freshness,
}) {
  requireNonEmpty(id, "id");
  requireNonEmpty(namespace, "namespace");
  requireNonEmpty(sourceRevision, "source_revision");
  requireNonEmpty(artifactManifestId, "artifact_manifest_id");
  requireNonEmpty(graphIndexId, "graph_index_id");
  validateManifest(manifest, artifactManifestId);
  validateThreshold(threshold);

  const recordList = records ?? [];
  const relationList = relations ?? [];

  const provenance = deriveProvenance(recordList, relationList, manifest, sourceRevision);
  const statusCounts = deriveStatusCounts(recordList, relationList);
  const producerBaseline = deriveProducerBaseline(
    producerDeclaredCounts,
    producerIndexedCounts,
    producerExplanations,
  );
  const sortedUnresolvedIds = [...(unresolvedIds ?? [])].sort();

  const passed = computePassed({
    schemaResult,
    repeatability,
    mutation,
    producerBaseline,
    provenance,
    threshold,
  });

  return {
    id,
    namespace,
    source_revision: sourceRevision,
    artifact_manifest_id: artifactManifestId,
    graph_index_id: graphIndexId,
    schema_result: schemaResult,
    provenance,
    unresolved_ids: sortedUnresolvedIds,
    status_counts: statusCounts,
    repeatability,
    freshness: { ...(freshness ?? {}), source_revision: sourceRevision },
    producer_baseline: producerBaseline,
    mutation,
    threshold,
    passed,
  };
}
