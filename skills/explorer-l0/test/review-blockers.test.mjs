/**
 * Post-review blockers: same-key collision, accept re-integrity, mutation recompute,
 * closed draft rejects graph_index.
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
import { stableStringify } from "../src/stable-json.mjs";
import {
  AcceptanceError,
  StoreError,
  acceptBaseline,
  openStore,
  persistCandidate,
} from "../src/store.mjs";
import {
  coverageDraftInputs,
  draftRecord,
  explorerDraft,
} from "./fixtures.mjs";

const temps = [];

afterEach(() => {
  while (temps.length > 0) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "descobrir-rb-"));
  temps.push(dir);
  return openStore(join(dir, "s.sqlite"));
}

describe("same-key divergent package collision", () => {
  test("idempotent when stored package JSON is canonically equal", () => {
    const store = tempStore();
    const pkg = canonicalizeCandidatePackage(explorerDraft());
    const first = persistCandidate(store, pkg);
    const second = persistCandidate(store, structuredClone(pkg));
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.candidate_id, second.candidate_id);
    store.close();
  });

  test("throws StoreError when same key has divergent package JSON", () => {
    const store = tempStore();
    const a = canonicalizeCandidatePackage(
      explorerDraft({
        records: [draftRecord({ summary: "summary A" })],
      }),
    );
    const b = canonicalizeCandidatePackage(
      explorerDraft({
        records: [draftRecord({ summary: "summary B" })],
      }),
    );
    // summary is excluded from graph hash — same key, divergent package body
    assert.equal(
      a.graph_index.canonical_graph_hash,
      b.graph_index.canonical_graph_hash,
    );
    assert.notEqual(stableStringify(a), stableStringify(b));

    persistCandidate(store, a);
    assert.throws(
      () => persistCandidate(store, b),
      (err) =>
        err instanceof StoreError &&
        /divergent|collision|same key/i.test(err.message),
    );
    // stored package remains A
    const row = store._db
      .prepare(`SELECT package_json FROM l0_candidate_packages WHERE candidate_id = ?`)
      .get(persistCandidate(store, a).candidate_id);
    const stored = JSON.parse(/** @type {string} */ (row.package_json));
    assert.equal(stored.records[0].summary, "summary A");
    store.close();
  });
});

describe("acceptBaseline revalidates stored integrity", () => {
  test("rejects when package_json was tampered after persist", () => {
    const store = tempStore();
    const pkg = canonicalizeCandidatePackage(explorerDraft());
    assert.equal(pkg.coverage_report.passed, true);
    const { candidate_id } = persistCandidate(store, pkg);

    const row = store._db
      .prepare(`SELECT package_json FROM l0_candidate_packages WHERE candidate_id = ?`)
      .get(candidate_id);
    const tampered = JSON.parse(/** @type {string} */ (row.package_json));
    tampered.coverage_report.passed = false;
    // flip passed while leaving other fields — integrity recompute will disagree
    // Actually passed:false with threshold 0 would recompute true... so flip hash instead
    // Better: set passed true but break provenance so recompute fails
    tampered.coverage_report.passed = true;
    tampered.coverage_report.provenance = {
      ...tampered.coverage_report.provenance,
      repository_verified_percentage: 99,
    };
    store._db
      .prepare(`UPDATE l0_candidate_packages SET package_json = ? WHERE candidate_id = ?`)
      .run(stableStringify(tampered), candidate_id);

    assert.throws(
      () => acceptBaseline(store, { candidate_id, approver: "Marley" }),
      (err) =>
        err instanceof AcceptanceError &&
        /integrity|provenance|recomputed|invalid/i.test(err.message),
    );
    assert.equal(
      store.getAcceptedBaseline({ namespace: pkg.namespace, logical_repo: pkg.logical_repo }),
      null,
    );
    store.close();
  });
});

describe("mutation.equivalent is recomputed", () => {
  test("divergent pre/post with caller equivalent:true yields equivalent:false and failed gate", () => {
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);
    const pkg = canonicalizeCandidatePackage(
      explorerDraft({
        coverage_report: coverageDraftInputs({
          mutation: {
            pre: { summary_hash: hashA, tracked_file_count: 1 },
            post: { summary_hash: hashB, tracked_file_count: 2 },
            equivalent: true,
          },
          threshold: {
            minimum_repository_verified_percentage: 0,
            require_schema_valid: true,
            require_repeatability_pass: true,
            require_mutation_equivalent: true,
            require_producer_reconciliation_pass: true,
          },
        }),
      }),
    );
    assert.equal(pkg.coverage_report.mutation.equivalent, false);
    assert.equal(pkg.coverage_report.passed, false);
  });

  test("identical pre/post with caller equivalent:false yields equivalent:true", () => {
    const hash = "c".repeat(64);
    const snap = { summary_hash: hash, tracked_file_count: 3 };
    const pkg = canonicalizeCandidatePackage(
      explorerDraft({
        coverage_report: coverageDraftInputs({
          mutation: {
            pre: snap,
            post: { ...snap },
            equivalent: false,
          },
        }),
      }),
    );
    assert.equal(pkg.coverage_report.mutation.equivalent, true);
    assert.equal(pkg.coverage_report.passed, true);
  });
});

describe("closed draft rejects graph_index", () => {
  test("draft-supplied graph_index is rejected", () => {
    assert.throws(
      () =>
        canonicalizeCandidatePackage(
          explorerDraft({
            graph_index: {
              id: "graph-index:fake",
              namespace: "demo",
              source_revision: "x",
              artifact_manifest_id: "m",
              engine: { name: "g", profile: "d" },
              record_ids: [],
              relation_ids: [],
              counts: { records: 0, relations: 0 },
              canonical_graph_hash: "d".repeat(64),
            },
          }),
        ),
      (err) =>
        err instanceof CandidatePackageError && /graph_index|unknown field/i.test(err.message),
    );
  });
});
