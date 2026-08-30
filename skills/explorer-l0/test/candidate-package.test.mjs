import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CandidatePackageError,
  canonicalizeCandidatePackage,
} from "../src/candidate-package.mjs";
import { canonicalGraphHash } from "../src/graph-hash.mjs";
import {
  REV,
  SHA_A,
  artifactEvidence,
  coverageDraftInputs,
  draftRecord,
  draftRelation,
  explorerDraft,
} from "./fixtures.mjs";
// coverageDraftInputs used for draft coverage shape


describe("canonicalizeCandidatePackage", () => {
  test("rejects unknown top-level fields such as confidence prose", () => {
    assert.throws(
      () => canonicalizeCandidatePackage(explorerDraft({ confidence: "pretty sure" })),
      (err) => err instanceof CandidatePackageError && /unknown|confidence|additional/i.test(err.message),
    );
  });

  test("rejects confidence on records", () => {
    assert.throws(
      () =>
        canonicalizeCandidatePackage(
          explorerDraft({
            records: [draftRecord({ confidence: "high" })],
          }),
        ),
      CandidatePackageError,
    );
  });

  test("never treats LLM-supplied ids as authority — recomputes canonical ids", () => {
    const pkg = canonicalizeCandidatePackage(
      explorerDraft({
        records: [
          draftRecord({
            id: "artifact_id:invented-by-llm",
            type: "Service",
            natural_key: "billing",
          }),
          draftRecord({
            type: "Endpoint",
            natural_key: "get:/billing",
            name: "GET /billing",
          }),
        ],
        relations: [
          draftRelation({
            id: "call-chain:fake",
            from_type: "Service",
            from_natural_key: "billing",
            to_type: "Endpoint",
            to_natural_key: "get:/billing",
          }),
        ],
      }),
    );

    assert.equal(pkg.records[0].id, "l0:endpoint:get:/billing");
    assert.equal(pkg.records[1].id, "l0:service:billing");
    assert.notEqual(pkg.records[1].id, "l0:artifact_id:invented-by-llm");
    // ADR 0009: relation id body carries canonical NATURAL KEYS, not record ids.
    assert.equal(pkg.relations[0].id, "l0:rel:EXPOSES:billing->get:/billing");
    // Endpoints continue to store full L0 record ids.
    assert.equal(pkg.relations[0].from_record, "l0:service:billing");
    assert.equal(pkg.relations[0].to_record, "l0:endpoint:get:/billing");
    assert.ok(!("confidence" in pkg.records[1]));
  });

  test("rejects schema-invalid evidence shapes", () => {
    assert.throws(
      () =>
        canonicalizeCandidatePackage(
          explorerDraft({
            records: [
              draftRecord({
                evidence: [{ kind: "artifact", path: "/abs/secret" }],
              }),
            ],
          }),
        ),
      CandidatePackageError,
    );
  });

  test("produces deterministic hash and stable ordering independent of input order", () => {
    const r1 = draftRecord({ natural_key: "billing", name: "Billing" });
    const r2 = draftRecord({ natural_key: "orders", name: "Orders" });
    const forward = canonicalizeCandidatePackage(
      explorerDraft({
        records: [r1, r2],
        relations: [],
        coverage_report: coverageDraftInputs(),
      }),
    );
    const reversed = canonicalizeCandidatePackage(
      explorerDraft({
        records: [r2, r1],
        relations: [],
        coverage_report: coverageDraftInputs(),
      }),
    );

    assert.deepEqual(
      forward.records.map((r) => r.id),
      ["l0:service:billing", "l0:service:orders"],
    );
    assert.equal(forward.graph_index.canonical_graph_hash, reversed.graph_index.canonical_graph_hash);
    assert.equal(
      forward.graph_index.canonical_graph_hash,
      canonicalGraphHash({ records: forward.records, relations: forward.relations }),
    );
    assert.match(forward.graph_index.canonical_graph_hash, /^[a-f0-9]{64}$/);
  });

  test("pins source_revision and namespace on every entity", () => {
    const pkg = canonicalizeCandidatePackage(explorerDraft());
    assert.equal(pkg.records[0].source_revision, REV);
    assert.equal(pkg.records[0].namespace, "demo");
    assert.equal(pkg.records[0].source_engine.artifact_manifest_id, pkg.artifact_manifest.id);
    assert.ok(pkg.records[0].evidence.some((e) => e.kind === "artifact"));
  });

  test("rejects empty draft", () => {
    assert.throws(() => canonicalizeCandidatePackage(null), CandidatePackageError);
    assert.throws(() => canonicalizeCandidatePackage({}), CandidatePackageError);
  });

  test("coverage_report is recomputed — hash linkage and gate from deterministic inputs", () => {
    const pkg = canonicalizeCandidatePackage(
      explorerDraft({
        coverage_report: coverageDraftInputs(),
      }),
    );
    // LLM passed:false is ignored when threshold is satisfiable
    assert.equal(pkg.coverage_report.passed, true);
    assert.equal(
      pkg.coverage_report.repeatability.canonical_graph_hash,
      pkg.graph_index.canonical_graph_hash,
    );
    assert.equal(pkg.coverage_report.graph_index_id, pkg.graph_index.id);
    assert.equal(pkg.coverage_report.provenance.total_entities, 1);
    assert.equal(pkg.coverage_report.status_counts.hipótese, 1);
  });

  test("evidence content_sha256 must be lowercase hex", () => {
    assert.throws(
      () =>
        canonicalizeCandidatePackage(
          explorerDraft({
            records: [
              draftRecord({
                evidence: [
                  {
                    ...artifactEvidence(),
                    content_sha256: "Z".repeat(64),
                  },
                ],
              }),
            ],
          }),
        ),
      CandidatePackageError,
    );
  });
});
