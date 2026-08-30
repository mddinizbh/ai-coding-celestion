import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  validateArtifactManifest,
  validateCoverageReport,
  validateGraphIndex,
  validateKnowledgeRecord,
  validateRelation,
} from "../src/schema/descobrir.mjs";
import {
  MANIFEST_ID,
  NS,
  REV,
  SHA_A,
  artifactEvidence,
  minimalCoverageReport,
  repositoryEvidence,
  sourceEngine,
  validArtifactManifest,
} from "./fixtures.mjs";

function validRecord(overrides = {}) {
  return {
    id: "service:billing",
    namespace: NS,
    type: "Service",
    name: "Billing",
    summary: "Billing service",
    attributes: {},
    status: "hipótese",
    source_revision: REV,
    source_engine: sourceEngine(),
    evidence: [artifactEvidence()],
    ...overrides,
  };
}

function validRelation(overrides = {}) {
  return {
    id: "exposes:service:billing->endpoint:get:/billing",
    namespace: NS,
    from_record: "service:billing",
    relation_type: "EXPOSES",
    to_record: "endpoint:get:/billing",
    status: "hipótese",
    source_revision: REV,
    source_engine: sourceEngine(),
    evidence: [artifactEvidence()],
    ...overrides,
  };
}

  describe("schema validation against self-contained contracts/", () => {
  test("accepts a valid knowledge record", () => {
    const result = validateKnowledgeRecord(validRecord());
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  test("rejects unknown fields (additionalProperties false)", () => {
    const result = validateKnowledgeRecord(validRecord({ confidence: "high" }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /additional property/i.test(e.message)));
  });

  test("rejects comprovado without repository evidence", () => {
    const result = validateKnowledgeRecord(validRecord({ status: "comprovado" }));
    assert.equal(result.valid, false);
  });

  test("accepts comprovado with repository evidence", () => {
    const result = validateKnowledgeRecord(
      validRecord({
        status: "comprovado",
        evidence: [artifactEvidence(), repositoryEvidence()],
      }),
    );
    assert.equal(result.valid, true);
  });

  test("rejects invalid relation shape", () => {
    const result = validateRelation(validRelation({ from_record: "" }));
    assert.equal(result.valid, false);
  });

  test("validates artifact manifest, graph index, coverage report", () => {
    const manifest = validArtifactManifest();
    assert.equal(validateArtifactManifest(manifest).valid, true);

    const index = {
      id: "graph-index:x",
      namespace: NS,
      source_revision: REV,
      artifact_manifest_id: MANIFEST_ID,
      engine: { name: "graphify", profile: "default" },
      record_ids: ["service:billing"],
      relation_ids: [],
      counts: { records: 1, relations: 0 },
      canonical_graph_hash: SHA_A,
    };
    assert.equal(validateGraphIndex(index).valid, true);

    const report = minimalCoverageReport({
      graphIndexId: index.id,
      repositoryVerifiedPercentage: 0,
    });
    report.repeatability.canonical_graph_hash = SHA_A;
    assert.equal(validateCoverageReport(report).valid, true);
  });
});
