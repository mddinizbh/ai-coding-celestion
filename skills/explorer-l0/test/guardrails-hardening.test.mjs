/**
 * RED→GREEN hardening: CLI bypass, self-promote, self-pass, graph consistency,
 * artifact resolution, store integrity.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { main } from "../cli.mjs";
import {
  CandidatePackageError,
  canonicalizeCandidatePackage,
} from "../src/candidate-package.mjs";
import { StoreError, openStore, persistCandidate } from "../src/store.mjs";
import {
  MANIFEST_ID,
  NS,
  REPO,
  REV,
  SHA_A,
  SHA_B,
  artifactEvidence,
  draftRecord,
  draftRelation,
  explorerDraft,
  coverageDraftInputs,
  repositoryEvidence,
  validArtifactManifest,
} from "./fixtures.mjs";

const temps = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "descobrir-hard-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

describe("CLI always canonicalizes Explorer drafts", () => {
  test("persist-candidate rejects a tampered 'canonical' package that skips draft validation", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "store.sqlite");
    const inputPath = join(dir, "bad.json");

    // Heuristic-shaped package: has graph_index + record.id, no natural_key,
    // but carries banned confidence and a fake hash — must NOT be trusted.
    const bypass = {
      namespace: NS,
      logical_repo: REPO,
      source_revision: REV,
      artifact_manifest: validArtifactManifest(),
      records: [
        {
          id: "service:billing",
          namespace: NS,
          type: "Service",
          name: "Billing",
          summary: "x",
          attributes: {},
          status: "hipótese",
          source_revision: REV,
          source_engine: {
            name: "x",
            profile: "y",
            adapter_version: "1",
            artifact_manifest_id: MANIFEST_ID,
          },
          evidence: [artifactEvidence()],
          confidence: "high",
        },
      ],
      relations: [],
      graph_index: {
        id: "graph-index:fake",
        namespace: NS,
        source_revision: REV,
        artifact_manifest_id: MANIFEST_ID,
        engine: { name: "graphify", profile: "default" },
        record_ids: ["service:billing"],
        relation_ids: [],
        counts: { records: 1, relations: 0 },
        canonical_graph_hash: "f".repeat(64),
      },
      coverage_report: coverageDraftInputs(),
    };
    writeFileSync(inputPath, `${JSON.stringify(bypass)}\n`, "utf8");

    const code = await main([
      "persist-candidate",
      "--db",
      dbPath,
      "--input",
      inputPath,
    ]);
    assert.notEqual(code, 0, "must reject bypass package (no natural_key / banned field)");
  });
});

describe("status comprovado requires pinned-revision verification", () => {
  test("downgrades draft comprovado to hipótese when no readAtRevision is injected", () => {
    const pkg = canonicalizeCandidatePackage(
      explorerDraft({
        records: [
          draftRecord({
            status: "comprovado",
            evidence: [artifactEvidence(), repositoryEvidence()],
          }),
        ],
      }),
    );
    assert.equal(pkg.records[0].status, "hipótese");
  });

  test("promotes to comprovado only when readAtRevision verifies the pinned bytes", () => {
    const source = "line1\n".repeat(60);
    const pkg = canonicalizeCandidatePackage(
      explorerDraft({
        records: [
          draftRecord({
            status: "hipótese",
            evidence: [artifactEvidence(), repositoryEvidence()],
          }),
        ],
      }),
      {
        readAtRevision: ({ path, revision }) => {
          assert.equal(revision, REV);
          assert.equal(path, "domains/iam/controller/service_register.go");
          return source;
        },
      },
    );
    assert.equal(pkg.records[0].status, "comprovado");
  });

  test("keeps hipótese when readAtRevision cannot resolve the path", () => {
    const err = new Error("missing");
    err.name = "GitSourceError";
    const pkg = canonicalizeCandidatePackage(
      explorerDraft({
        records: [
          draftRecord({
            status: "comprovado",
            evidence: [artifactEvidence(), repositoryEvidence()],
          }),
        ],
      }),
      {
        readAtRevision: () => {
          throw err;
        },
      },
    );
    assert.equal(pkg.records[0].status, "hipótese");
  });
});

describe("coverage_report.passed is never LLM authority", () => {
  test("ignores draft passed:true when threshold cannot be met", () => {
    const pkg = canonicalizeCandidatePackage(
      explorerDraft({
        coverage_report: {
          ...coverageDraftInputs(),
          threshold: {
            minimum_repository_verified_percentage: 100,
            require_schema_valid: true,
            require_repeatability_pass: true,
            require_mutation_equivalent: true,
            require_producer_reconciliation_pass: true,
          },
        },
      }),
    );
    assert.equal(pkg.coverage_report.passed, false);
    assert.equal(pkg.coverage_report.provenance.repository_verified_percentage, 0);
    assert.equal(pkg.coverage_report.status_counts.hipótese, 1);
    assert.equal(
      pkg.coverage_report.repeatability.canonical_graph_hash,
      pkg.graph_index.canonical_graph_hash,
    );
  });

  test("recomputes passed:true from deterministic inputs when gate is satisfied", () => {
    const pkg = canonicalizeCandidatePackage(
      explorerDraft({
        coverage_report: {
          ...coverageDraftInputs(),
          threshold: {
            minimum_repository_verified_percentage: 0,
            require_schema_valid: true,
            require_repeatability_pass: true,
            require_mutation_equivalent: true,
            require_producer_reconciliation_pass: true,
          },
        },
      }),
    );
    assert.equal(pkg.coverage_report.passed, true);
  });
});

describe("graph internal consistency", () => {
  test("rejects duplicate canonical record ids", () => {
    assert.throws(
      () =>
        canonicalizeCandidatePackage(
          explorerDraft({
            records: [
              draftRecord({ natural_key: "billing", name: "A" }),
              draftRecord({ natural_key: "Billing", name: "B" }),
            ],
          }),
        ),
      (err) => err instanceof CandidatePackageError && /duplicate/i.test(err.message),
    );
  });

  test("rejects relations whose endpoints are missing from the record set", () => {
    assert.throws(
      () =>
        canonicalizeCandidatePackage(
          explorerDraft({
            records: [draftRecord({ natural_key: "billing" })],
            relations: [draftRelation()],
          }),
        ),
      (err) =>
        err instanceof CandidatePackageError && /missing|endpoint|from_record|to_record/i.test(err.message),
    );
  });

  test("rejects artifact evidence that does not resolve against the manifest", () => {
    assert.throws(
      () =>
        canonicalizeCandidatePackage(
          explorerDraft({
            records: [
              draftRecord({
                evidence: [
                  {
                    kind: "artifact",
                    manifest_id: MANIFEST_ID,
                    artifact_path: ".claude/explorer/endpoints.md",
                    content_sha256: SHA_B,
                    range: { start_line: 1, end_line: 1 },
                  },
                ],
              }),
            ],
          }),
        ),
      (err) => err instanceof CandidatePackageError && /artifact|manifest|resolve/i.test(err.message),
    );
  });

  test("rejects artifact evidence with wrong manifest_id", () => {
    assert.throws(
      () =>
        canonicalizeCandidatePackage(
          explorerDraft({
            records: [
              draftRecord({
                evidence: [
                  {
                    ...artifactEvidence(),
                    manifest_id: "manifest:other-load",
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

describe("store boundary integrity", () => {
  test("persistCandidate rejects mismatched canonical_graph_hash", () => {
    const store = openStore(join(tempDir(), "s.sqlite"));
    const pkg = canonicalizeCandidatePackage(explorerDraft());
    const tampered = {
      ...pkg,
      graph_index: {
        ...pkg.graph_index,
        canonical_graph_hash: "e".repeat(64),
      },
    };
    assert.throws(() => persistCandidate(store, tampered), StoreError);
    assert.equal(store.listCandidates({ namespace: NS, logical_repo: REPO }).length, 0);
    store.close();
  });

  test("persistCandidate rejects coverage_report.passed flipped without recompute", () => {
    const store = openStore(join(tempDir(), "s.sqlite"));
    const pkg = canonicalizeCandidatePackage(
      explorerDraft({
        coverage_report: {
          ...coverageDraftInputs(),
          threshold: {
            minimum_repository_verified_percentage: 100,
            require_schema_valid: true,
            require_repeatability_pass: true,
            require_mutation_equivalent: true,
            require_producer_reconciliation_pass: true,
          },
        },
      }),
    );
    assert.equal(pkg.coverage_report.passed, false);
    const tampered = {
      ...pkg,
      coverage_report: { ...pkg.coverage_report, passed: true },
    };
    assert.throws(() => persistCandidate(store, tampered), StoreError);
    store.close();
  });
});
