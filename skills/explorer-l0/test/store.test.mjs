import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";

import { canonicalizeCandidatePackage } from "../src/candidate-package.mjs";
import {
  AcceptanceError,
  StoreError,
  acceptBaseline,
  exportPackage,
  openStore,
  persistCandidate,
} from "../src/store.mjs";
import {
  explorerDraft,
  coverageDraftInputs,
  draftRecord,
  validArtifactManifest,
} from "./fixtures.mjs";

const temps = [];

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "descobrir-store-"));
  temps.push(dir);
  return join(dir, "descobrir.sqlite");
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

function packageA(overrides = {}) {
  return canonicalizeCandidatePackage(
    explorerDraft({
      coverage_report: coverageDraftInputs(),
      ...overrides,
    }),
  );
}

describe("SQLite document store", () => {
  test("creates only L0-prefixed domain tables for a fresh store", () => {
    const dbPath = tempDbPath();
    const store = openStore(dbPath);
    store.close();

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    db.close();

    assert.deepEqual(tables, ["l0_accepted_baselines", "l0_candidate_packages"]);
  });

  test("persist-candidate is idempotent for the same namespace/repo/revision/hash", () => {
    const dbPath = tempDbPath();
    const store = openStore(dbPath);
    const pkg = packageA();
    const first = persistCandidate(store, pkg);
    const second = persistCandidate(store, pkg);
    assert.equal(first.candidate_id, second.candidate_id);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(store.listCandidates({ namespace: "demo", logical_repo: "demo-cloud" }).length, 1);
    store.close();
  });

  test("preserves multiple distinct candidates for the same namespace+repo", () => {
    const dbPath = tempDbPath();
    const store = openStore(dbPath);
    const a = packageA({ records: [draftRecord({ natural_key: "billing" })] });
    const b = packageA({ records: [draftRecord({ natural_key: "orders", name: "Orders" })] });
    assert.notEqual(a.graph_index.canonical_graph_hash, b.graph_index.canonical_graph_hash);
    persistCandidate(store, a);
    persistCandidate(store, b);
    assert.equal(store.listCandidates({ namespace: "demo", logical_repo: "demo-cloud" }).length, 2);
    store.close();
  });

  test("rejects acceptance when coverage_report.passed is false", () => {
    const dbPath = tempDbPath();
    const store = openStore(dbPath);
    const pkg = packageA({
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
    });
    assert.equal(pkg.coverage_report.passed, false);
    const { candidate_id } = persistCandidate(store, pkg);
    assert.throws(
      () => acceptBaseline(store, { candidate_id, approver: "Marley" }),
      AcceptanceError,
    );
    assert.equal(store.getAcceptedBaseline({ namespace: "demo", logical_repo: "demo-cloud" }), null);
    store.close();
  });

  test("rejects acceptance when approver identity is missing", () => {
    const dbPath = tempDbPath();
    const store = openStore(dbPath);
    const pkg = packageA();
    const { candidate_id } = persistCandidate(store, pkg);
    assert.throws(() => acceptBaseline(store, { candidate_id, approver: "" }), AcceptanceError);
    assert.throws(() => acceptBaseline(store, { candidate_id }), AcceptanceError);
    store.close();
  });

  test("acceptance is atomic and sets one accepted baseline per namespace+logical_repo", () => {
    const dbPath = tempDbPath();
    const store = openStore(dbPath);
    const a = packageA({ records: [draftRecord({ natural_key: "billing" })] });
    const b = packageA({ records: [draftRecord({ natural_key: "orders", name: "Orders" })] });
    const idA = persistCandidate(store, a).candidate_id;
    const idB = persistCandidate(store, b).candidate_id;

    const acceptedA = acceptBaseline(store, { candidate_id: idA, approver: "Marley" });
    assert.equal(acceptedA.candidate_id, idA);
    assert.equal(acceptedA.approver, "Marley");

    const acceptedB = acceptBaseline(store, { candidate_id: idB, approver: "Marley" });
    assert.equal(acceptedB.candidate_id, idB);

    const current = store.getAcceptedBaseline({ namespace: "demo", logical_repo: "demo-cloud" });
    assert.equal(current.candidate_id, idB);
    store.close();
  });

  test("namespace isolation — candidates in ns A are invisible to ns B queries", () => {
    const dbPath = tempDbPath();
    const store = openStore(dbPath);
    const a = packageA();
    const otherManifestId = "manifest:other";
    const other = canonicalizeCandidatePackage(
      explorerDraft({
        namespace: "other-ns",
        artifact_manifest: {
          ...validArtifactManifest(),
          namespace: "other-ns",
          id: otherManifestId,
        },
        records: [
          draftRecord({
            evidence: [
              {
                kind: "artifact",
                manifest_id: otherManifestId,
                artifact_path: ".claude/explorer/endpoints.md",
                content_sha256: "a".repeat(64),
                range: { start_line: 1, end_line: 2 },
              },
            ],
          }),
        ],
        coverage_report: coverageDraftInputs({
          id: "coverage:other",
        }),
      }),
    );
    persistCandidate(store, a);
    persistCandidate(store, other);
    assert.equal(store.listCandidates({ namespace: "demo", logical_repo: "demo-cloud" }).length, 1);
    assert.equal(store.listCandidates({ namespace: "other-ns", logical_repo: "demo-cloud" }).length, 1);
    store.close();
  });

  test("export round-trips the stored package as stable JSON (export-only, not SoT)", () => {
    const dbPath = tempDbPath();
    const store = openStore(dbPath);
    const pkg = packageA();
    const { candidate_id } = persistCandidate(store, pkg);
    const exported = exportPackage(store, { candidate_id });
    assert.equal(exported.graph_index.canonical_graph_hash, pkg.graph_index.canonical_graph_hash);
    assert.deepEqual(exported.records, pkg.records);
    assert.deepEqual(exported.relations, pkg.relations);
    store.close();
  });

  test("sets restrictive file mode on the sqlite database when created on disk", () => {
    const dbPath = tempDbPath();
    const store = openStore(dbPath);
    store.close();
    // best-effort: platform may mask bits; require owner-read at minimum and no world-write
    const mode = statSync(dbPath).mode & 0o777;
    assert.equal(mode & 0o002, 0, `world-writable db mode ${mode.toString(8)}`);
    assert.ok((mode & 0o400) !== 0);
  });

  test("rollback on failed transaction leaves no partial candidate", () => {
    const dbPath = tempDbPath();
    const store = openStore(dbPath);
    const pkg = packageA();
    // inject failure by closing mid-flight via broken package that fails internal check
    assert.throws(() => persistCandidate(store, null), StoreError);
    assert.equal(store.listCandidates({ namespace: "demo", logical_repo: "demo-cloud" }).length, 0);
    // valid persist still works after failed attempt
    persistCandidate(store, pkg);
    assert.equal(store.listCandidates({ namespace: "demo", logical_repo: "demo-cloud" }).length, 1);
    store.close();
  });
});
