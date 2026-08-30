/**
 * Pure CoverageReport metric helpers (contract-stable).
 */

const REPO_URI_RE = /^repo:\/\/[^@/\s]+@([^/\s]+)\/.*#L\d+-L\d+$/;
const STATUS_KEYS = ["comprovado", "hipótese", "contradição", "stale"];

/**
 * @param {unknown} range
 * @returns {boolean}
 */
export function wellFormedRange(range) {
  return (
    range !== null &&
    typeof range === "object" &&
    Number.isInteger(/** @type {{start_line?: unknown}} */ (range).start_line) &&
    Number.isInteger(/** @type {{end_line?: unknown}} */ (range).end_line) &&
    /** @type {{start_line: number}} */ (range).start_line >= 1 &&
    /** @type {{end_line: number}} */ (range).end_line >= 1 &&
    /** @type {{end_line: number}} */ (range).end_line >=
      /** @type {{start_line: number}} */ (range).start_line
  );
}

/**
 * @param {object} ev
 * @param {{ id: string, artifacts: { path: string, content_sha256: string }[] }} manifest
 */
export function artifactEvidenceResolves(ev, manifest) {
  if (ev.kind !== "artifact") return false;
  if (ev.manifest_id !== manifest.id) return false;
  const entry = manifest.artifacts.find((a) => a.path === ev.artifact_path);
  if (entry === undefined || entry.content_sha256 !== ev.content_sha256) return false;
  return wellFormedRange(ev.range);
}

/**
 * @param {object} entity
 * @param {object} manifest
 */
function entityHasValidArtifact(entity, manifest) {
  return entity.evidence.some((ev) => artifactEvidenceResolves(ev, manifest));
}

/**
 * @param {object} entity
 * @param {string} sourceRevision
 */
function entityIsRepositoryVerified(entity, sourceRevision) {
  if (entity.status !== "comprovado") return false;
  return entity.evidence.some(
    (ev) =>
      ev.kind === "repository" &&
      typeof ev.uri === "string" &&
      (() => {
        const m = REPO_URI_RE.exec(ev.uri);
        return m !== null && m[1] === sourceRevision;
      })(),
  );
}

/** @param {object} entity */
function entityIsArtifactOnly(entity) {
  return !entity.evidence.some((ev) => ev.kind === "repository");
}

/** @param {number} count @param {number} total */
function percent(count, total) {
  return total === 0 ? 0 : (100 * count) / total;
}

/**
 * @param {object[]} records
 * @param {object[]} relations
 * @param {object} manifest
 * @param {string} sourceRevision
 */
export function deriveProvenance(records, relations, manifest, sourceRevision) {
  const entities = [...records, ...relations];
  const total = entities.length;
  const artifactReferenceCount = entities.filter((e) => entityHasValidArtifact(e, manifest)).length;
  const repositoryVerifiedCount = entities.filter((e) =>
    entityIsRepositoryVerified(e, sourceRevision),
  ).length;
  const artifactOnlyCount = entities.filter(entityIsArtifactOnly).length;
  return {
    total_entities: total,
    total_records: records.length,
    total_relations: relations.length,
    artifact_reference_count: artifactReferenceCount,
    artifact_reference_percentage: percent(artifactReferenceCount, total),
    repository_verified_count: repositoryVerifiedCount,
    repository_verified_percentage: percent(repositoryVerifiedCount, total),
    artifact_only_count: artifactOnlyCount,
  };
}

/**
 * @param {object[]} records
 * @param {object[]} relations
 */
export function deriveStatusCounts(records, relations) {
  /** @type {Record<string, number>} */
  const counts = { comprovado: 0, hipótese: 0, contradição: 0, stale: 0 };
  for (const e of [...records, ...relations]) {
    if (STATUS_KEYS.includes(e.status)) counts[e.status] += 1;
  }
  return counts;
}

/**
 * @param {Record<string, number>|undefined} declaredCounts
 * @param {Record<string, number>|undefined} indexedCounts
 * @param {Record<string, string>|undefined} explanations
 */
export function deriveProducerBaseline(declaredCounts, indexedCounts, explanations) {
  const declared = declaredCounts ?? {};
  const indexed = indexedCounts ?? {};
  const expl = explanations ?? {};
  const metrics = [...new Set([...Object.keys(declared), ...Object.keys(indexed)])].sort();
  const deltas = metrics.map((metric) => {
    const d = declared[metric] ?? 0;
    const i = indexed[metric] ?? 0;
    return { metric, declared: d, indexed: i, delta: i - d, explanation: expl[metric] ?? "" };
  });
  const result = deltas.every((d) => d.explanation !== "") ? "pass" : "fail";
  return { declared_counts: declared, indexed_counts: indexed, deltas, result };
}

/**
 * @param {object} args
 * @returns {boolean}
 */
export function computePassed({
  schemaResult,
  repeatability,
  mutation,
  producerBaseline,
  provenance,
  threshold,
}) {
  const schemaOk = threshold.require_schema_valid !== true || schemaResult.valid === true;
  const repeatOk = threshold.require_repeatability_pass !== true || repeatability.result === "pass";
  const mutationOk = threshold.require_mutation_equivalent !== true || mutation.equivalent === true;
  const producerOk =
    threshold.require_producer_reconciliation_pass !== true || producerBaseline.result === "pass";
  const coverageOk =
    provenance.repository_verified_percentage >= threshold.minimum_repository_verified_percentage;
  return schemaOk && repeatOk && mutationOk && producerOk && coverageOk;
}
