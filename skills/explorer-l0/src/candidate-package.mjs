/**
 * Validate and canonicalize untrusted LLM Explorer candidate drafts.
 *
 * Semantic claims are stochastic/untrusted. Determinism applies to shape,
 * schema validation, canonical IDs, ordering, graph hash, verification, and
 * CoverageReport derivation — never to inventing factual truth.
 */

import {
  TOP_LEVEL_KEYS,
  assertRelationEndpointsExist,
  assertSchemaValid,
  assertUniqueIds,
  buildSourceEngine,
  canonicalizeRecord,
  canonicalizeRelation,
  rejectUnknownAndBanned,
  requireNonEmptyString,
  requirePlainObject,
} from "./candidate-draft.mjs";
import { deriveCoverageFromDraft } from "./coverage-draft.mjs";
import { CandidatePackageError } from "./errors.mjs";
import { createGraphIndex } from "./graph-hash.mjs";
import { compareRaw } from "./layered-id.mjs";
import { verifyAndPromote } from "./repo-verifier.mjs";
import {
  validateArtifactManifest,
  validateGraphIndex,
  validateKnowledgeRecord,
  validateRelation,
} from "./schema/descobrir.mjs";

export { CandidatePackageError };

/**
 * @param {object[]} records
 * @param {object[]} relations
 */
function revalidateEntities(records, relations) {
  for (const rec of records) {
    assertSchemaValid(validateKnowledgeRecord(rec), `record ${rec.id}`);
  }
  for (const rel of relations) {
    assertSchemaValid(validateRelation(rel), `relation ${rel.id}`);
  }
}

/**
 * Canonicalize an untrusted Explorer draft into a baseline candidate package.
 * @param {unknown} raw
 * @param {{ readAtRevision?: (args: { revision: string, path: string }) => Buffer|string }} [options]
 * @returns {object}
 */
export function canonicalizeCandidatePackage(raw, options = {}) {
  requirePlainObject(raw, "candidate package");
  const draft = /** @type {Record<string, unknown>} */ (raw);
  rejectUnknownAndBanned(draft, TOP_LEVEL_KEYS, "candidate package");

  const namespace = requireNonEmptyString(draft.namespace, "namespace");
  const logicalRepo = requireNonEmptyString(draft.logical_repo, "logical_repo");
  const sourceRevision = requireNonEmptyString(draft.source_revision, "source_revision");
  requirePlainObject(draft.artifact_manifest, "artifact_manifest");
  if (!Array.isArray(draft.records)) {
    throw new CandidatePackageError("records must be an array");
  }
  if (!Array.isArray(draft.relations)) {
    throw new CandidatePackageError("relations must be an array");
  }
  requirePlainObject(draft.coverage_report, "coverage_report");

  const manifestInput = /** @type {Record<string, unknown>} */ (draft.artifact_manifest);
  const manifest = {
    ...manifestInput,
    namespace,
    logical_repo: logicalRepo,
    source_revision: sourceRevision,
  };
  assertSchemaValid(validateArtifactManifest(manifest), "artifact_manifest");
  if (typeof manifest.id !== "string" || manifest.id === "") {
    throw new CandidatePackageError("artifact_manifest.id must be a non-empty string");
  }

  const sourceEngine = buildSourceEngine(manifest.engine, manifest.adapter, manifest.id);

  let records = draft.records
    .map((r) =>
      canonicalizeRecord(
        /** @type {Record<string, unknown>} */ (r),
        namespace,
        sourceRevision,
        sourceEngine,
        manifest,
      ),
    )
    .sort((a, b) => compareRaw(a.id, b.id));

  let relations = draft.relations
    .map((r) =>
      canonicalizeRelation(
        /** @type {Record<string, unknown>} */ (r),
        namespace,
        sourceRevision,
        sourceEngine,
        manifest,
      ),
    )
    .sort((a, b) => compareRaw(a.id, b.id));

  assertUniqueIds(records, "record");
  assertUniqueIds(relations, "relation");
  assertRelationEndpointsExist(records, relations);

  /** @type {string[]} */
  let unresolvedIds = [];
  const reader = options.readAtRevision;
  if (typeof reader === "function") {
    const promoted = verifyAndPromote({
      records,
      relations,
      logicalRepo,
      sourceRevision,
      readAtRevision: reader,
    });
    records = promoted.records;
    relations = promoted.relations;
    unresolvedIds = promoted.unresolvedIds;
    revalidateEntities(records, relations);
  }

  const graphIndex = createGraphIndex({
    namespace,
    sourceRevision,
    artifactManifestId: manifest.id,
    engine: { name: sourceEngine.name, profile: sourceEngine.profile },
    graph: { records, relations },
  });
  assertSchemaValid(validateGraphIndex(graphIndex), "graph_index");

  const coverage = deriveCoverageFromDraft(
    /** @type {Record<string, unknown>} */ (draft.coverage_report),
    graphIndex,
    manifest,
    records,
    relations,
    unresolvedIds,
  );

  return {
    namespace,
    logical_repo: logicalRepo,
    source_revision: sourceRevision,
    artifact_manifest: manifest,
    records,
    relations,
    graph_index: graphIndex,
    coverage_report: coverage,
  };
}
