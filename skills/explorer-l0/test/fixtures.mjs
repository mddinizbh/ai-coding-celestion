/**
 * Shared synthetic fixtures for Descobrir skill tests.
 * No secrets, no absolute paths, no prototype imports.
 */

export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);
export const REV = "633d3a5d16c165073ede2b2248bae708483f2efe";
export const NS = "demo";
export const REPO = "demo-cloud";
export const MANIFEST_ID = "manifest:test-load-1";

export function artifactEvidence(path = ".claude/explorer/endpoints.md") {
  return {
    kind: "artifact",
    manifest_id: MANIFEST_ID,
    artifact_path: path,
    content_sha256: SHA_A,
    range: { start_line: 1, end_line: 2 },
  };
}

export function repositoryEvidence(
  uri = `repo://${REPO}@${REV}/domains/iam/controller/service_register.go#L60-L60`,
) {
  return { kind: "repository", uri };
}

export function sourceEngine(manifestId = MANIFEST_ID) {
  return {
    name: "graphify-llm-explorer",
    profile: "graph-json-v1",
    adapter_version: "1.0.0",
    artifact_manifest_id: manifestId,
  };
}

export function validArtifactManifest(overrides = {}) {
  return {
    id: MANIFEST_ID,
    namespace: NS,
    logical_repo: REPO,
    source_revision: REV,
    engine: { name: "graphify", profile: "default" },
    adapter: { version: "1.0.0", name: "llm-explorer" },
    acquisition_mode: "reused",
    artifacts: [
      {
        path: ".claude/explorer/endpoints.md",
        content_sha256: SHA_A,
        role: "native",
        declared_revision: REV,
        status: "complete",
      },
    ],
    freshness: { source_revision: REV },
    ...overrides,
  };
}

export function draftRecord(overrides = {}) {
  return {
    type: "Service",
    natural_key: "billing",
    name: "Billing",
    summary: "Billing service",
    attributes: { layer: "domain" },
    status: "hipótese",
    evidence: [artifactEvidence()],
    ...overrides,
  };
}

export function draftRelation(overrides = {}) {
  return {
    relation_type: "EXPOSES",
    from_natural_key: "billing",
    from_type: "Service",
    to_natural_key: "get:/billing",
    to_type: "Endpoint",
    status: "hipótese",
    evidence: [artifactEvidence()],
    ...overrides,
  };
}

export function minimalCoverageReport({
  namespace = NS,
  sourceRevision = REV,
  artifactManifestId = MANIFEST_ID,
  graphIndexId = "graph-index:placeholder",
  passed = true,
  repositoryVerifiedPercentage = 0,
} = {}) {
  const zeroHash = "0".repeat(64);
  return {
    id: "coverage:test",
    namespace,
    source_revision: sourceRevision,
    artifact_manifest_id: artifactManifestId,
    graph_index_id: graphIndexId,
    schema_result: { valid: true, errors: [] },
    provenance: {
      total_entities: 0,
      artifact_reference_count: 0,
      artifact_reference_percentage: 0,
      repository_verified_count: 0,
      repository_verified_percentage: repositoryVerifiedPercentage,
    },
    unresolved_ids: [],
    status_counts: {
      comprovado: 0,
      hipótese: 0,
      contradição: 0,
      stale: 0,
    },
    repeatability: { result: "pass", canonical_graph_hash: zeroHash },
    freshness: { source_revision: sourceRevision },
    producer_baseline: {
      declared_counts: {},
      indexed_counts: {},
      deltas: [],
      result: "pass",
    },
    mutation: {
      pre: { summary_hash: zeroHash },
      post: { summary_hash: zeroHash },
      equivalent: true,
    },
    threshold: {
      minimum_repository_verified_percentage: 0,
      require_schema_valid: true,
      require_repeatability_pass: true,
      require_mutation_equivalent: true,
      require_producer_reconciliation_pass: true,
    },
    passed,
  };
}

/**
 * Untrusted LLM Explorer draft — IDs optional/ignored; natural keys required.
 */

/**
 * Closed Explorer draft coverage inputs (no derived authority fields).
 */
export function coverageDraftInputs(overrides = {}) {
  const zeroHash = "0".repeat(64);
  return {
    id: "coverage:test",
    threshold: {
      minimum_repository_verified_percentage: 0,
      require_schema_valid: true,
      require_repeatability_pass: true,
      require_mutation_equivalent: true,
      require_producer_reconciliation_pass: true,
    },
    mutation: {
      pre: { summary_hash: zeroHash },
      post: { summary_hash: zeroHash },
      equivalent: true,
    },
    producer_baseline: {
      declared_counts: {},
      indexed_counts: {},
      deltas: [],
    },
    freshness: { source_revision: REV },
    ...overrides,
  };
}

export function explorerDraft(overrides = {}) {
  return {
    namespace: NS,
    logical_repo: REPO,
    source_revision: REV,
    artifact_manifest: validArtifactManifest(),
    records: [draftRecord()],
    relations: [],
    coverage_report: coverageDraftInputs(),
    ...overrides,
  };
}
