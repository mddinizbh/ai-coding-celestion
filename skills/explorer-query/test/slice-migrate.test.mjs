import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  dryRun,
  prepare,
  rebuild,
  MigrationCorruptionError,
  MixedVersionError,
} from "../src/slice-migrate.mjs";
import {
  migrateSliceSchema,
  SHARED_SCHEMA_VERSIONS_DDL,
} from "../src/slice-store-schema.mjs";
import {
  L1_COMPONENT,
  L1_SCHEMA_SUPPORTED_VERSION,
} from "../../explorer-l1/src/system-store.mjs";
import {
  L2_COMPONENT,
  L2_SCHEMA_SUPPORTED_VERSION,
} from "../../explorer-l2/src/journey-store.mjs";
import { migrateComponentSchema } from "../../explorer-l0/src/schema-versions.mjs";

function applyL1Schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_edges (
      edge_id TEXT PRIMARY KEY,
      system_namespace TEXT NOT NULL,
      from_namespace TEXT NOT NULL,
      from_logical_repo TEXT NOT NULL,
      from_fact_id TEXT NOT NULL,
      to_namespace TEXT NOT NULL,
      to_logical_repo TEXT NOT NULL,
      to_fact_id TEXT NOT NULL,
      contract_key TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      evidence_class TEXT NOT NULL,
      match_kind TEXT NOT NULL,
      score REAL NOT NULL,
      config_key TEXT,
      edge_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS system_stitch_runs (
      run_id TEXT PRIMARY KEY,
      system_namespace TEXT NOT NULL,
      repos_json TEXT NOT NULL,
      edge_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  migrateComponentSchema({ db, component: L1_COMPONENT, supportedVersion: L1_SCHEMA_SUPPORTED_VERSION, steps: [], errorCtor: Error });
}
function applyL2Schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS journey_specs (
      system_namespace TEXT NOT NULL, journey_id TEXT NOT NULL, spec_revision TEXT NOT NULL,
      spec_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (system_namespace, journey_id, spec_revision)
    );
    CREATE TABLE IF NOT EXISTS journey_binds (
      bind_id TEXT PRIMARY KEY, system_namespace TEXT NOT NULL, journey_id TEXT NOT NULL,
      spec_revision TEXT NOT NULL, journey_hash TEXT NOT NULL, status TEXT NOT NULL,
      steps_bound INTEGER NOT NULL, steps_gap INTEGER NOT NULL, members_json TEXT NOT NULL,
      bind_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS journey_step_edges (
      bind_id TEXT NOT NULL, step_id TEXT NOT NULL, edge_id TEXT NOT NULL, step_status TEXT NOT NULL,
      PRIMARY KEY (bind_id, step_id, edge_id)
    );
    CREATE TABLE IF NOT EXISTS journey_current (
      system_namespace TEXT NOT NULL, journey_id TEXT NOT NULL, bind_id TEXT NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY (system_namespace, journey_id)
    );
  `);
  migrateComponentSchema({ db, component: L2_COMPONENT, supportedVersion: L2_SCHEMA_SUPPORTED_VERSION, steps: [], errorCtor: Error });
}

function makeSeededDb() {
  const dir = mkdtempSync(join(tmpdir(), "slice-migrate-2phase-"));
  const dbPath = join(dir, "all.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE candidate_packages (candidate_id TEXT PRIMARY KEY, namespace TEXT, logical_repo TEXT, source_revision TEXT, canonical_graph_hash TEXT, package_json TEXT, created_at TEXT)`);
  db.exec(`CREATE TABLE accepted_baselines (namespace TEXT, logical_repo TEXT, candidate_id TEXT, approver TEXT, accepted_at TEXT, PRIMARY KEY (namespace, logical_repo))`);
  applyL1Schema(db);
  applyL2Schema(db);
  db.exec(SHARED_SCHEMA_VERSIONS_DDL);
  migrateSliceSchema(db);

  const v1Pkg = { namespace: "demo", logical_repo: "svc-a", source_revision: "rev1", records: [{ id: "service:billing", type: "Service", natural_key: "billing" }], relations: [] };
  db.prepare("INSERT INTO candidate_packages VALUES (?,?,?,?,?,?,?)").run("candidate:demo:svc-a:rev1:abc", "demo", "svc-a", "rev1", "abc", JSON.stringify(v1Pkg), "2025-01-01");
  db.prepare("INSERT INTO accepted_baselines VALUES (?,?,?,?,?)").run("demo", "svc-a", "candidate:demo:svc-a:rev1:abc", "Marley", "2025-01-01");
  db.prepare("INSERT INTO system_edges (edge_id, system_namespace, from_namespace, from_logical_repo, from_fact_id, to_namespace, to_logical_repo, to_fact_id, contract_key, method, path, evidence_class, match_kind, score, config_key, edge_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "l1:abc123", "demo-system", "demo", "svc-a", "ff:out:1", "demo", "svc-b", "ff:in:1",
    "GET /x", "GET", "/x", "contract-matched", "config_binding", 0.95, null, "{}", "2025-01-01",
  );
  db.prepare("INSERT INTO journey_binds VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("demo:j:hash", "demo-system", "j", "spec", "hash", "complete", 1, 0, "[]", "{}", "2025-01-01");
  db.prepare("INSERT INTO context_slices (slice_id, derivation_key, slice_hash, canonical_payload_json, provenance_json, coverage_json, policy_name, policy_version, status, system_namespace, seed_set_hash, id_version, created_at, updated_at, materialization_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("slice:old", "dk-old", "old", "{}", "{}", "{}", "journey", 1, "materialized", "demo-system", "ssh", 1, "2025-01-01", "2025-01-01", 0);
  return { db, dbPath, dir };
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

describe("slice-migrate — dryRun", () => {
  let ctx;
  beforeEach(() => { ctx = makeSeededDb(); });
  afterEach(() => { ctx.db.close(); rmSync(ctx.dir, { recursive: true, force: true }); });

  test("dryRun is read-only — counts unchanged, v1 detected", () => {
    const before = { edges: countRows(ctx.db, "system_edges"), binds: countRows(ctx.db, "journey_binds"), slices: countRows(ctx.db, "context_slices"), candidates: countRows(ctx.db, "candidate_packages") };
    const report = dryRun({ db: ctx.db });
    assert.equal(report.mode, "dry-run");
    assert.equal(report.l0.v1_detected, 1);
    assert.equal(report.l1.edges_before, 1);
    assert.equal(report.l2.binds_before, 1);
    assert.equal(report.slice.rows_before, 1);
    assert.equal(countRows(ctx.db, "system_edges"), before.edges);
    assert.equal(countRows(ctx.db, "journey_binds"), before.binds);
    assert.equal(countRows(ctx.db, "context_slices"), before.slices);
    assert.equal(countRows(ctx.db, "candidate_packages"), before.candidates);
  });

  test("dryRun inventories already-prefixed L0, L1, and L2 tables", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`
        CREATE TABLE l0_candidate_packages (
          candidate_id TEXT PRIMARY KEY, namespace TEXT, logical_repo TEXT,
          package_json TEXT
        );
        CREATE TABLE l0_accepted_baselines (
          namespace TEXT, logical_repo TEXT, candidate_id TEXT
        );
        CREATE TABLE l1_system_edges (edge_id TEXT PRIMARY KEY);
        CREATE TABLE l2_journey_binds (bind_id TEXT PRIMARY KEY);
        INSERT INTO l0_candidate_packages VALUES (
          'candidate:legacy', 'demo', 'svc-a',
          '{"records":[{"id":"service:billing"}]}'
        );
        INSERT INTO l0_accepted_baselines VALUES ('demo', 'svc-a', 'candidate:legacy');
        INSERT INTO l1_system_edges VALUES ('l1:legacy');
        INSERT INTO l2_journey_binds VALUES ('bind:legacy');
      `);

      const report = dryRun({ db });
      assert.equal(report.l0.accepted_baselines, 1);
      assert.equal(report.l0.v1_detected, 1);
      assert.equal(report.l1.edges_before, 1);
      assert.equal(report.l2.binds_before, 1);
    } finally {
      db.close();
    }
  });
});

describe("slice-migrate — Phase A prepare", () => {
  let ctx;
  beforeEach(() => { ctx = makeSeededDb(); });
  afterEach(() => { ctx.db.close(); rmSync(ctx.dir, { recursive: true, force: true }); });

  test("prepare dryRun=true performs ZERO writes", () => {
    const before = countRows(ctx.db, "candidate_packages");
    const report = prepare({ db: ctx.db, dryRun: true, l0Store: { persistV2Candidate: () => ({ candidate_id: "x" }) } });
    assert.equal(report.l0.v2_candidates_created, 0);
    assert.equal(countRows(ctx.db, "candidate_packages"), before);
  });

  test("prepare dryRun=false creates ONE v2 candidate; never accepts it; Human Gate pending", () => {
    const candidatesBefore = countRows(ctx.db, "candidate_packages");
    const acceptedBefore = countRows(ctx.db, "accepted_baselines");
    const report = prepare({
      db: ctx.db,
      dryRun: false,
      l0Store: {
        persistV2Candidate: (payload, txDb) => {
          const newId = "candidate:demo:svc-a:rev1:v2";
          txDb.prepare("INSERT INTO candidate_packages VALUES (?,?,?,?,?,?,?)").run(newId, payload.namespace, payload.logical_repo, payload.source_revision, "v2hash", JSON.stringify(payload) + "-v2", "2025-01-02");
          return { candidate_id: newId };
        },
      },
    });
    assert.equal(report.l0.v2_candidates_created, 1);
    assert.equal(report.l0.human_gate_pending, 1);
    assert.equal(countRows(ctx.db, "candidate_packages"), candidatesBefore + 1);
    assert.equal(countRows(ctx.db, "accepted_baselines"), acceptedBefore);
    const row = ctx.db.prepare(`SELECT candidate_id FROM accepted_baselines WHERE namespace=? AND logical_repo=?`).get("demo", "svc-a");
    assert.equal(row.candidate_id, "candidate:demo:svc-a:rev1:abc");
  });

  test("prepare failure mid-loop ROLLS BACK — no partial candidates survive", () => {
    const before = countRows(ctx.db, "candidate_packages");
    const report = prepare({
      db: ctx.db,
      dryRun: false,
      l0Store: {
        persistV2Candidate: (_p, txDb) => {
          txDb.prepare("INSERT INTO candidate_packages VALUES (?,?,?,?,?,?,?)").run("c-tmp", "demo", "svc-a", "r", "h", "{}", "2025-01-02");
          throw new Error("simulated boom");
        },
      },
    });
    assert.equal(report.rolled_back, true);
    assert.match(report.error, /prepare failed/);
    assert.equal(countRows(ctx.db, "candidate_packages"), before);
    const surviving = ctx.db.prepare(`SELECT COUNT(*) AS n FROM candidate_packages WHERE candidate_id = ?`).get("c-tmp").n;
    assert.equal(surviving, 0);
  });

  test("prepare WITHOUT l0Store in execute mode returns rolled_back report", () => {
    const before = countRows(ctx.db, "candidate_packages");
    const report = prepare({ db: ctx.db, dryRun: false });
    assert.equal(report.rolled_back, true);
    assert.match(report.error, /persistV2Candidate/);
    assert.equal(countRows(ctx.db, "candidate_packages"), before);
  });
});

describe("slice-migrate — Phase B rebuild", () => {
  let ctx;
  beforeEach(() => { ctx = makeSeededDb(); });
  afterEach(() => { ctx.db.close(); rmSync(ctx.dir, { recursive: true, force: true }); });

  test("rebuild with empty acceptedV2CandidateIds clears derived tables", () => {
    const report = rebuild({ db: ctx.db, acceptedV2CandidateIds: [] });
    assert.equal(report.rolled_back, undefined);
    assert.equal(report.slice.reset, true);
    assert.equal(countRows(ctx.db, "system_edges"), 0);
    assert.equal(countRows(ctx.db, "journey_binds"), 0);
    assert.equal(countRows(ctx.db, "context_slices"), 0);
  });

  test("rebuild with claimed-but-not-accepted candidate FAILS CLOSED — derived data untouched", () => {
    const edgesBefore = countRows(ctx.db, "system_edges");
    const report = rebuild({ db: ctx.db, acceptedV2CandidateIds: ["candidate:demo:svc-a:rev1:not-yet-accepted"] });
    assert.equal(report.rolled_back, true);
    assert.match(report.error, /NOT recorded as accepted/);
    assert.equal(countRows(ctx.db, "system_edges"), edgesBefore, "derived data must be UNTOUCHED");
  });

  test("rebuild SUCCESS: reset + rebuildL1 + rebuildL2 all in ONE transaction", () => {
    ctx.db.prepare("INSERT INTO candidate_packages VALUES (?,?,?,?,?,?,?)").run("candidate:demo:svc-a:rev1:v2", "demo", "svc-a", "rev1", "v2hash", "{}", "2025-01-02");
    ctx.db.prepare(`UPDATE accepted_baselines SET candidate_id = ? WHERE namespace = ? AND logical_repo = ?`).run("candidate:demo:svc-a:rev1:v2", "demo", "svc-a");

    const report = rebuild({
      db: ctx.db,
      acceptedV2CandidateIds: ["candidate:demo:svc-a:rev1:v2"],
      rebuildL1: (txDb) => {
        txDb.prepare("INSERT INTO system_edges (edge_id, system_namespace, from_namespace, from_logical_repo, from_fact_id, to_namespace, to_logical_repo, to_fact_id, contract_key, method, path, evidence_class, match_kind, score, config_key, edge_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
          "l1:edge:newv2", "demo-system", "demo", "svc-a", "l0:ff:http_outbound:abc",
          "demo", "svc-b", "l0:ff:http_inbound:def", "GET /x", "GET", "/x",
          "contract-matched", "config_binding", 0.95, null, "{}", "2025-01-02",
        );
        return { edges_after: 1 };
      },
      rebuildL2: (txDb) => {
        txDb.prepare("INSERT INTO journey_binds VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("l2:bind:newhash", "demo-system", "l2:journey:j", "spec2", "newhash", "complete", 1, 0, "[]", "{}", "2025-01-02");
        return { binds_after: 1 };
      },
    });
    assert.equal(report.rolled_back, undefined);
    assert.equal(report.l1.edges_after, 1);
    assert.equal(report.l2.binds_after, 1);
    assert.equal(countRows(ctx.db, "system_edges"), 1);
    assert.equal(countRows(ctx.db, "journey_binds"), 1);
    assert.equal(countRows(ctx.db, "context_slices"), 0);
  });

  test("rebuild FAILURE mid-rebuildL1 ROLLS BACK deletes AND new writes", () => {
    const edgesBefore = countRows(ctx.db, "system_edges");
    const bindsBefore = countRows(ctx.db, "journey_binds");
    const slicesBefore = countRows(ctx.db, "context_slices");
    const report = rebuild({
      db: ctx.db,
      acceptedV2CandidateIds: [],
      rebuildL1: (txDb) => {
        txDb.prepare("INSERT INTO system_edges (edge_id, system_namespace, from_namespace, from_logical_repo, from_fact_id, to_namespace, to_logical_repo, to_fact_id, contract_key, method, path, evidence_class, match_kind, score, config_key, edge_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
          "l1:edge:doomed", "demo-system", "demo", "svc-a", "l0:ff:http_outbound:x",
          "demo", "svc-b", "l0:ff:http_inbound:y", "GET /x", "GET", "/x",
          "contract-matched", "config_binding", 0.95, null, "{}", "2025-01-02",
        );
        throw new Error("rebuildL1 exploded");
      },
    });
    assert.equal(report.rolled_back, true);
    assert.match(report.error, /rebuild failed: rebuildL1 exploded/);
    assert.equal(countRows(ctx.db, "system_edges"), edgesBefore, "L1 edges must be restored");
    assert.equal(countRows(ctx.db, "journey_binds"), bindsBefore, "L2 binds must be restored");
    assert.equal(countRows(ctx.db, "context_slices"), slicesBefore, "Slice rows must be restored");
    const doomed = ctx.db.prepare(`SELECT COUNT(*) AS n FROM system_edges WHERE edge_id = ?`).get("l1:edge:doomed").n;
    assert.equal(doomed, 0);
  });

  test("rebuild FAILURE mid-rebuildL2 (after rebuildL1 succeeded) ROLLS BACK everything", () => {
    const edgesBefore = countRows(ctx.db, "system_edges");
    const bindsBefore = countRows(ctx.db, "journey_binds");
    const report = rebuild({
      db: ctx.db,
      acceptedV2CandidateIds: [],
      rebuildL1: (txDb) => {
        txDb.prepare("INSERT INTO system_edges (edge_id, system_namespace, from_namespace, from_logical_repo, from_fact_id, to_namespace, to_logical_repo, to_fact_id, contract_key, method, path, evidence_class, match_kind, score, config_key, edge_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
          "l1:edge:temp", "demo-system", "demo", "svc-a", "l0:ff:http_outbound:x",
          "demo", "svc-b", "l0:ff:http_inbound:y", "GET /x", "GET", "/x",
          "contract-matched", "config_binding", 0.95, null, "{}", "2025-01-02",
        );
      },
      rebuildL2: () => { throw new Error("rebuildL2 exploded"); },
    });
    assert.equal(report.rolled_back, true);
    assert.equal(countRows(ctx.db, "system_edges"), edgesBefore, "L1 must be fully restored");
    assert.equal(countRows(ctx.db, "journey_binds"), bindsBefore, "L2 must be restored");
    const temp = ctx.db.prepare(`SELECT COUNT(*) AS n FROM system_edges WHERE edge_id = ?`).get("l1:edge:temp").n;
    assert.equal(temp, 0, "rebuildL1 write must NOT survive when rebuildL2 fails");
  });
});

describe("slice-migrate — fail-closed data handling", () => {
  test("corrupt package_json throws MigrationCorruptionError (no silent skip)", () => {
    const dir = mkdtempSync(join(tmpdir(), "slice-migrate-corrupt-"));
    const dbPath = join(dir, "all.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(SHARED_SCHEMA_VERSIONS_DDL);
      migrateSliceSchema(db);
      db.exec(`CREATE TABLE candidate_packages (candidate_id TEXT PRIMARY KEY, namespace TEXT, logical_repo TEXT, source_revision TEXT, canonical_graph_hash TEXT, package_json TEXT, created_at TEXT)`);
      db.exec(`CREATE TABLE accepted_baselines (namespace TEXT, logical_repo TEXT, candidate_id TEXT, approver TEXT, accepted_at TEXT, PRIMARY KEY (namespace, logical_repo))`);
      db.prepare("INSERT INTO candidate_packages VALUES (?,?,?,?,?,?,?)").run("c1", "n", "r", "s", "h", "{NOT VALID JSON", "2025-01-01");
      db.prepare("INSERT INTO accepted_baselines VALUES (?,?,?,?,?)").run("n", "r", "c1", "Marley", "2025-01-01");
      assert.throws(
        () => dryRun({ db }),
        (err) => err instanceof MigrationCorruptionError && /corrupt JSON/i.test(err.message),
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("absent optional tables in dryRun report zeros (not corruption)", () => {
    const dir = mkdtempSync(join(tmpdir(), "slice-migrate-empty-"));
    const dbPath = join(dir, "empty.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(SHARED_SCHEMA_VERSIONS_DDL);
      const report = dryRun({ db });
      assert.equal(report.l0.accepted_baselines, 0);
      assert.equal(report.l0.v1_detected, 0);
      assert.equal(report.l1.edges_before, 0);
      assert.equal(report.l2.binds_before, 0);
      assert.equal(report.slice.rows_before, 0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("MixedVersionError is exported for callers", () => {
    assert.ok(MixedVersionError);
  });
});
