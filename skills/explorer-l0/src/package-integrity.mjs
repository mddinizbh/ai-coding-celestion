/**
 * Canonical-package integrity checks at the store boundary.
 */

import { coverageReport } from "./coverage-report.mjs";
import { StoreError } from "./errors.mjs";
import { canonicalGraphHash } from "./graph-hash.mjs";
import {
  assertArtifactEvidence,
  assertIdentityAlignment,
  assertRelationEndpoints,
  assertSortedIdList,
  assertUniqueIds,
} from "./package-graph-checks.mjs";
import {
  validateArtifactManifest,
  validateCoverageReport,
  validateGraphIndex,
  validateKnowledgeRecord,
  validateRelation,
} from "./schema/descobrir.mjs";
import { stableStringify } from "./stable-json.mjs";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {{ valid: boolean, errors: { path: string, message: string }[] }} result
 * @param {string} label
 */
function assertValid(result, label) {
  if (!result.valid) {
    const detail = result.errors
      .slice(0, 3)
      .map((e) => `${e.path || "/"}: ${e.message}`)
      .join("; ");
    throw new StoreError(`${label} schema invalid: ${detail}`);
  }
}

/**
 * @param {object} report
 * @returns {Record<string, string>}
 */
function explanationsFromReport(report) {
  const deltas = Array.isArray(report.producer_baseline?.deltas)
    ? report.producer_baseline.deltas
    : [];
  /** @type {Record<string, string>} */
  const out = {};
  for (const d of deltas) {
    if (typeof d.metric === "string" && typeof d.explanation === "string") {
      out[d.metric] = d.explanation;
    }
  }
  return out;
}

/**
 * Assert a package is internally consistent and coverage was not tampered.
 * @param {unknown} pkg
 */
export function assertCanonicalPackageIntegrity(pkg) {
  if (!isPlainObject(pkg)) {
    throw new StoreError("package must be an object");
  }
  if (!isPlainObject(pkg.graph_index) || !isPlainObject(pkg.coverage_report)) {
    throw new StoreError("package.graph_index and package.coverage_report are required");
  }
  if (!Array.isArray(pkg.records) || !Array.isArray(pkg.relations)) {
    throw new StoreError("package.records and package.relations must be arrays");
  }
  if (!isPlainObject(pkg.artifact_manifest)) {
    throw new StoreError("package.artifact_manifest is required");
  }

  const ns = pkg.namespace;
  const repo = pkg.logical_repo;
  const rev = pkg.source_revision;
  if (typeof ns !== "string" || ns === "") throw new StoreError("package.namespace required");
  if (typeof repo !== "string" || repo === "") throw new StoreError("package.logical_repo required");
  if (typeof rev !== "string" || rev === "") throw new StoreError("package.source_revision required");

  assertIdentityAlignment(pkg, ns, repo, rev);
  assertUniqueIds(pkg.records, "record");
  assertUniqueIds(pkg.relations, "relation");
  assertRelationEndpoints(pkg.records, pkg.relations);
  assertArtifactEvidence([...pkg.records, ...pkg.relations], pkg.artifact_manifest);

  const hash = canonicalGraphHash({ records: pkg.records, relations: pkg.relations });
  if (pkg.graph_index.canonical_graph_hash !== hash) {
    throw new StoreError("package.graph_index.canonical_graph_hash does not match graph content");
  }
  if (pkg.coverage_report.repeatability?.canonical_graph_hash !== hash) {
    throw new StoreError("coverage_report.repeatability.canonical_graph_hash mismatch");
  }
  if (pkg.coverage_report.graph_index_id !== pkg.graph_index.id) {
    throw new StoreError("coverage_report.graph_index_id mismatch");
  }
  if (pkg.coverage_report.artifact_manifest_id !== pkg.artifact_manifest.id) {
    throw new StoreError("coverage_report.artifact_manifest_id mismatch");
  }
  if (pkg.graph_index.artifact_manifest_id !== pkg.artifact_manifest.id) {
    throw new StoreError("graph_index.artifact_manifest_id mismatch");
  }

  assertSortedIdList(
    pkg.graph_index.record_ids,
    pkg.records.map((r) => r.id),
    "record_ids",
  );
  assertSortedIdList(
    pkg.graph_index.relation_ids,
    pkg.relations.map((r) => r.id),
    "relation_ids",
  );
  if (
    pkg.graph_index.counts?.records !== pkg.records.length ||
    pkg.graph_index.counts?.relations !== pkg.relations.length
  ) {
    throw new StoreError("graph_index.counts do not match graph content");
  }

  assertValid(validateArtifactManifest(pkg.artifact_manifest), "artifact_manifest");
  assertValid(validateGraphIndex(pkg.graph_index), "graph_index");
  for (const rec of pkg.records) {
    assertValid(validateKnowledgeRecord(rec), `record ${rec?.id ?? "?"}`);
  }
  for (const rel of pkg.relations) {
    assertValid(validateRelation(rel), `relation ${rel?.id ?? "?"}`);
  }
  assertValid(validateCoverageReport(pkg.coverage_report), "coverage_report");

  const recomputed = coverageReport({
    id: pkg.coverage_report.id,
    namespace: ns,
    sourceRevision: rev,
    artifactManifestId: pkg.artifact_manifest.id,
    graphIndexId: pkg.graph_index.id,
    records: pkg.records,
    relations: pkg.relations,
    manifest: pkg.artifact_manifest,
    schemaResult: pkg.coverage_report.schema_result,
    unresolvedIds: pkg.coverage_report.unresolved_ids,
    repeatability: {
      result: pkg.coverage_report.repeatability.result,
      canonical_graph_hash: hash,
      ...(pkg.coverage_report.repeatability.baseline_hash
        ? { baseline_hash: pkg.coverage_report.repeatability.baseline_hash }
        : {}),
    },
    mutation: pkg.coverage_report.mutation,
    threshold: pkg.coverage_report.threshold,
    producerDeclaredCounts: pkg.coverage_report.producer_baseline?.declared_counts,
    producerIndexedCounts: pkg.coverage_report.producer_baseline?.indexed_counts,
    producerExplanations: explanationsFromReport(pkg.coverage_report),
    freshness: pkg.coverage_report.freshness,
  });

  if (recomputed.passed !== pkg.coverage_report.passed) {
    throw new StoreError("coverage_report.passed does not match recomputed gate");
  }
  if (stableStringify(recomputed.provenance) !== stableStringify(pkg.coverage_report.provenance)) {
    throw new StoreError("coverage_report.provenance does not match recomputed provenance");
  }
  if (
    stableStringify(recomputed.status_counts) !== stableStringify(pkg.coverage_report.status_counts)
  ) {
    throw new StoreError("coverage_report.status_counts does not match recomputed histogram");
  }
}
