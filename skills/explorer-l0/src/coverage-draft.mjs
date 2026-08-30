/**
 * Closed Explorer draft → CoverageReport derivation.
 * Draft may only carry deterministic inputs; derived fields are rejected.
 */

import { assertSchemaValid, isPlainObject, requirePlainObject } from "./candidate-shape.mjs";
import { coverageReport } from "./coverage-report.mjs";
import { CandidatePackageError } from "./errors.mjs";
import { validateCoverageReport } from "./schema/descobrir.mjs";
import { stableStringify } from "./stable-json.mjs";

/** Allowed keys on Explorer draft coverage_report (closed shape). */
export const COVERAGE_DRAFT_KEYS = new Set([
  "id",
  "threshold",
  "mutation",
  "producer_baseline",
  "repeatability",
  "freshness",
]);

const BANNED_DERIVED = new Set([
  "passed",
  "provenance",
  "status_counts",
  "schema_result",
  "graph_index_id",
  "artifact_manifest_id",
  "namespace",
  "source_revision",
  "unresolved_ids",
]);

/**
 * @param {Record<string, unknown>} draftReport
 */
export function assertClosedCoverageDraft(draftReport) {
  requirePlainObject(draftReport, "coverage_report");
  for (const key of Object.keys(draftReport)) {
    if (BANNED_DERIVED.has(key)) {
      throw new CandidatePackageError(
        `coverage_report: derived/authority field '${key}' is not allowed in Explorer draft`,
      );
    }
    if (!COVERAGE_DRAFT_KEYS.has(key)) {
      throw new CandidatePackageError(`coverage_report: unknown field '${key}'`);
    }
  }
  if (!isPlainObject(draftReport.threshold)) {
    throw new CandidatePackageError("coverage_report.threshold is required");
  }
  if (!isPlainObject(draftReport.mutation)) {
    throw new CandidatePackageError("coverage_report.mutation is required");
  }
  const mut = draftReport.mutation;
  if (!isPlainObject(mut.pre) || !isPlainObject(mut.post)) {
    throw new CandidatePackageError("coverage_report.mutation.pre and .post are required objects");
  }
}

/**
 * Caller `equivalent` is never authority — derive from stable pre/post comparison.
 * @param {Record<string, unknown>} draftMutation
 */
export function recomputeMutation(draftMutation) {
  requirePlainObject(draftMutation, "coverage_report.mutation");
  const pre = draftMutation.pre;
  const post = draftMutation.post;
  if (!isPlainObject(pre) || !isPlainObject(post)) {
    throw new CandidatePackageError("coverage_report.mutation.pre and .post are required objects");
  }
  return {
    pre,
    post,
    equivalent: stableStringify(pre) === stableStringify(post),
  };
}

/**
 * @param {Record<string, unknown>} draftReport
 * @returns {Record<string, string>}
 */
function producerExplanations(draftReport) {
  const baseline = isPlainObject(draftReport.producer_baseline)
    ? draftReport.producer_baseline
    : {};
  /** @type {Record<string, string>} */
  const out = {};
  if (Array.isArray(baseline.deltas)) {
    for (const d of baseline.deltas) {
      if (isPlainObject(d) && typeof d.metric === "string" && typeof d.explanation === "string") {
        out[d.metric] = d.explanation;
      }
    }
  }
  return out;
}

/**
 * @param {Record<string, unknown>} draftReport
 * @param {object} graphIndex
 * @param {object} manifest
 * @param {object[]} records
 * @param {object[]} relations
 * @param {string[]} unresolvedIds
 */
export function deriveCoverageFromDraft(
  draftReport,
  graphIndex,
  manifest,
  records,
  relations,
  unresolvedIds,
) {
  assertClosedCoverageDraft(draftReport);

  const baseline = isPlainObject(draftReport.producer_baseline)
    ? draftReport.producer_baseline
    : { declared_counts: {}, indexed_counts: {}, deltas: [] };

  const draftRepeat = isPlainObject(draftReport.repeatability)
    ? draftReport.repeatability
    : {};
  const digest = graphIndex.canonical_graph_hash;
  const baselineHash =
    typeof draftRepeat.baseline_hash === "string" ? draftRepeat.baseline_hash : undefined;
  const repeatResult =
    baselineHash !== undefined && baselineHash !== digest ? "fail" : "pass";

  const report = coverageReport({
    id:
      typeof draftReport.id === "string" && draftReport.id !== ""
        ? draftReport.id
        : "coverage:load",
    namespace: manifest.namespace,
    sourceRevision: manifest.source_revision,
    artifactManifestId: manifest.id,
    graphIndexId: graphIndex.id,
    records,
    relations,
    manifest,
    schemaResult: { valid: true, errors: [] },
    unresolvedIds,
    repeatability: {
      result: repeatResult,
      canonical_graph_hash: digest,
      ...(baselineHash ? { baseline_hash: baselineHash } : {}),
    },
    mutation: recomputeMutation(/** @type {Record<string, unknown>} */ (draftReport.mutation)),
    threshold: draftReport.threshold,
    producerDeclaredCounts: isPlainObject(baseline.declared_counts)
      ? /** @type {Record<string, number>} */ (baseline.declared_counts)
      : {},
    producerIndexedCounts: isPlainObject(baseline.indexed_counts)
      ? /** @type {Record<string, number>} */ (baseline.indexed_counts)
      : {},
    producerExplanations: producerExplanations(draftReport),
    freshness: isPlainObject(draftReport.freshness)
      ? draftReport.freshness
      : { source_revision: manifest.source_revision },
  });

  assertSchemaValid(validateCoverageReport(report), "coverage_report");
  return report;
}
