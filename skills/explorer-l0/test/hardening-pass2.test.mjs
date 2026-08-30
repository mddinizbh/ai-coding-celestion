/**
 * Pass-2 hardening: relation natural-key authority, closed coverage draft,
 * full store-boundary cross-document invariants.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  CandidatePackageError,
  canonicalizeCandidatePackage,
} from "../src/candidate-package.mjs";
import { createGraphIndex, canonicalGraphHash } from "../src/graph-hash.mjs";
import { StoreError, openStore, persistCandidate } from "../src/store.mjs";
import {
  MANIFEST_ID,
  NS,
  REPO,
  REV,
  SHA_A,
  SHA_B,
  artifactEvidence,
  coverageDraftInputs,
  draftRecord,
  draftRelation,
  explorerDraft,
} from "./fixtures.mjs";

const temps = [];

afterEach(() => {
  while (temps.length > 0) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "descobrir-p2-"));
  temps.push(dir);
  return openStore(join(dir, "s.sqlite"));
}

describe("relation endpoints always from natural keys", () => {
  test("ignores supplied from_record/to_record/id even when present", () => {
    const pkg = canonicalizeCandidatePackage(
      explorerDraft({
        records: [
          draftRecord({ natural_key: "billing" }),
          draftRecord({ type: "Endpoint", natural_key: "get:/billing", name: "GET /billing" }),
        ],
        relations: [
          draftRelation({
            id: "relation:llm-invented",
            from_record: "service:wrong-from",
            to_record: "endpoint:wrong-to",
            from_type: "Service",
            from_natural_key: "billing",
            to_type: "Endpoint",
            to_natural_key: "get:/billing",
          }),
        ],
      }),
    );
    assert.equal(pkg.relations[0].from_record, "l0:service:billing");
    assert.equal(pkg.relations[0].to_record, "l0:endpoint:get:/billing");
    // ADR 0009: relation id body holds canonical natural keys (not record ids).
    assert.equal(pkg.relations[0].id, "l0:rel:EXPOSES:billing->get:/billing");
    assert.notEqual(pkg.relations[0].id, "relation:llm-invented");
  });

  test("requires from_type/from_natural_key/to_type/to_natural_key", () => {
    assert.throws(
      () =>
        canonicalizeCandidatePackage(
          explorerDraft({
            records: [
              draftRecord({ natural_key: "billing" }),
              draftRecord({ type: "Endpoint", natural_key: "get:/billing", name: "E" }),
            ],
            relations: [
              {
                relation_type: "EXPOSES",
                from_record: "service:billing",
                to_record: "endpoint:get:/billing",
                status: "hipótese",
                evidence: [artifactEvidence()],
              },
            ],
          }),
        ),
      (err) =>
        err instanceof CandidatePackageError &&
        /from_type|from_natural_key|to_type|to_natural_key/i.test(err.message),
    );
  });
});

describe("closed coverage_report draft shape", () => {
  test("rejects derived authority fields such as passed/provenance/status_counts", () => {
    for (const field of [
      "passed",
      "provenance",
      "status_counts",
      "schema_result",
      "graph_index_id",
      "artifact_manifest_id",
      "namespace",
      "source_revision",
      "unresolved_ids",
    ]) {
      assert.throws(
        () =>
          canonicalizeCandidatePackage(
            explorerDraft({
              coverage_report: {
                ...coverageDraftInputs(),
                [field]: field === "passed" ? true : field === "provenance" ? {} : "x",
              },
            }),
          ),
        (err) =>
          err instanceof CandidatePackageError &&
          new RegExp(field, "i").test(err.message),
        `should reject coverage_report.${field}`,
      );
    }
  });

  test("rejects unknown coverage_report keys", () => {
    assert.throws(
      () =>
        canonicalizeCandidatePackage(
          explorerDraft({
            coverage_report: {
              ...coverageDraftInputs(),
              free_form_note: "nope",
            },
          }),
        ),
      CandidatePackageError,
    );
  });

  test("requires threshold and mutation inputs", () => {
    assert.throws(
      () =>
        canonicalizeCandidatePackage(
          explorerDraft({
            coverage_report: { id: "coverage:x" },
          }),
        ),
      (err) => err instanceof CandidatePackageError && /threshold|mutation/i.test(err.message),
    );
  });
});

describe("store boundary cross-document invariants", () => {
  test("rejects top-level namespace mismatch with manifest", () => {
    const store = tempStore();
    const pkg = canonicalizeCandidatePackage(explorerDraft());
    const tampered = {
      ...pkg,
      namespace: "other-ns",
      // keep hash consistent with records so only namespace mismatch fires
    };
    // re-hash so hash check does not fire first if records unchanged
    const hash = canonicalGraphHash({
      records: tampered.records,
      relations: tampered.relations,
    });
    tampered.graph_index = { ...tampered.graph_index, canonical_graph_hash: hash };
    tampered.coverage_report = {
      ...tampered.coverage_report,
      repeatability: {
        ...tampered.coverage_report.repeatability,
        canonical_graph_hash: hash,
      },
    };
    assert.throws(() => persistCandidate(store, tampered), StoreError);
    store.close();
  });

  test("rejects tampered graph_index record_ids despite matching graph hash", () => {
    const store = tempStore();
    const pkg = canonicalizeCandidatePackage(explorerDraft());
    const tampered = {
      ...pkg,
      graph_index: {
        ...pkg.graph_index,
        record_ids: ["service:ghost"],
        counts: { records: 1, relations: 0 },
      },
    };
    assert.throws(
      () => persistCandidate(store, tampered),
      (err) => err instanceof StoreError && /record_ids|index/i.test(err.message),
    );
    store.close();
  });

  test("rejects duplicate record ids in an otherwise hash-aligned package", () => {
    const store = tempStore();
    const pkg = canonicalizeCandidatePackage(explorerDraft());
    const dup = { ...pkg.records[0] };
    const records = [pkg.records[0], dup];
    // force same id twice — hash will include both; rebuild index lists wrongly
    const hash = canonicalGraphHash({ records, relations: [] });
    const graph_index = createGraphIndex({
      namespace: NS,
      sourceRevision: REV,
      artifactManifestId: MANIFEST_ID,
      engine: pkg.graph_index.engine,
      graph: { records, relations: [] },
    });
    // break uniqueness after index creation by keeping duplicate records but
    // using a hand-built package that still has matching hash
    const bad = {
      ...pkg,
      records,
      relations: [],
      graph_index: { ...graph_index, canonical_graph_hash: hash },
      coverage_report: {
        ...pkg.coverage_report,
        graph_index_id: graph_index.id,
        repeatability: {
          result: "pass",
          canonical_graph_hash: hash,
        },
        // leave passed/provenance — integrity will recompute and may fail;
        // primary assert is duplicate detection
      },
    };
    assert.throws(
      () => persistCandidate(store, bad),
      (err) => err instanceof StoreError && /duplicate/i.test(err.message),
    );
    store.close();
  });

  test("rejects dangling relation endpoints at store boundary", () => {
    const store = tempStore();
    const pkg = canonicalizeCandidatePackage(
      explorerDraft({
        records: [
          draftRecord({ natural_key: "billing" }),
          draftRecord({ type: "Endpoint", natural_key: "get:/billing", name: "E" }),
        ],
        relations: [draftRelation()],
      }),
    );
    // drop endpoint record but keep relation
    const records = pkg.records.filter((r) => r.id === "service:billing");
    const relations = pkg.relations;
    const hash = canonicalGraphHash({ records, relations });
    const graph_index = {
      ...pkg.graph_index,
      record_ids: records.map((r) => r.id).sort(),
      relation_ids: relations.map((r) => r.id).sort(),
      counts: { records: 1, relations: 1 },
      canonical_graph_hash: hash,
      id: `graph-index:${hash}`,
    };
    const bad = {
      ...pkg,
      records,
      relations,
      graph_index,
      coverage_report: {
        ...pkg.coverage_report,
        graph_index_id: graph_index.id,
        repeatability: { result: "pass", canonical_graph_hash: hash },
      },
    };
    assert.throws(
      () => persistCandidate(store, bad),
      (err) => err instanceof StoreError && /missing|endpoint|from_record|to_record/i.test(err.message),
    );
    store.close();
  });

  test("rejects artifact evidence that no longer resolves after manifest tamper + rehash", () => {
    const store = tempStore();
    const pkg = canonicalizeCandidatePackage(explorerDraft());
    const manifest = {
      ...pkg.artifact_manifest,
      artifacts: [
        {
          ...pkg.artifact_manifest.artifacts[0],
          content_sha256: SHA_B,
        },
      ],
    };
    // records still point at SHA_A — evidence no longer resolves
    const hash = canonicalGraphHash({
      records: pkg.records,
      relations: pkg.relations,
    });
    const bad = {
      ...pkg,
      artifact_manifest: manifest,
      graph_index: {
        ...pkg.graph_index,
        canonical_graph_hash: hash,
      },
      coverage_report: {
        ...pkg.coverage_report,
        artifact_manifest_id: manifest.id,
        repeatability: {
          ...pkg.coverage_report.repeatability,
          canonical_graph_hash: hash,
        },
      },
    };
    assert.throws(
      () => persistCandidate(store, bad),
      (err) => err instanceof StoreError && /artifact|manifest|resolve/i.test(err.message),
    );
    store.close();
  });

  test("rejects logical_repo / source_revision mismatch across package documents", () => {
    const store = tempStore();
    const pkg = canonicalizeCandidatePackage(explorerDraft());
    const bad = {
      ...pkg,
      logical_repo: "other-repo",
      source_revision: pkg.source_revision,
    };
    const hash = canonicalGraphHash({ records: bad.records, relations: bad.relations });
    bad.graph_index = { ...bad.graph_index, canonical_graph_hash: hash };
    bad.coverage_report = {
      ...bad.coverage_report,
      repeatability: { ...bad.coverage_report.repeatability, canonical_graph_hash: hash },
    };
    assert.throws(() => persistCandidate(store, bad), StoreError);
    store.close();
  });
});
