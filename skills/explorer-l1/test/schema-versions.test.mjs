import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  L1_COMPONENT,
  L1_SCHEMA_SUPPORTED_VERSION,
  UnsupportedSchemaVersionError,
  openSystemStore,
  persistSystemEdges,
  listSystemEdges,
} from "../src/system-store.mjs";
import {
  SHARED_SCHEMA_VERSIONS_DDL,
  getComponentSchemaVersion,
  tableExists,
} from "../../explorer-l0/src/schema-versions.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "l1-schema-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("L1 system-store — component-scoped schema versioning (ADR 0009)", () => {
  test("fresh DB migrates to L1_SCHEMA_SUPPORTED_VERSION and adds id_version column", () => {
    const dbPath = join(dir, "l1.sqlite");
    const store = openSystemStore(dbPath);
    try {
      const v = store._db
        .prepare(`SELECT version FROM explorer_schema_versions WHERE component = ?`)
        .get(L1_COMPONENT);
      assert.equal(v.version, L1_SCHEMA_SUPPORTED_VERSION);

      const cols = store._db
        .prepare(`PRAGMA table_info(l1_system_edges)`)
        .all()
        .map((c) => c.name);
      assert.ok(cols.includes("id_version"), "id_version column must exist after migration");
      assert.equal(tableExists(store._db, "system_edges"), false);
      assert.equal(tableExists(store._db, "system_stitch_runs"), false);
    } finally {
      store.close();
    }
  });

  test("reopen is idempotent — version row stays put, no error", () => {
    const dbPath = join(dir, "l1.sqlite");
    const a = openSystemStore(dbPath);
    a.close();
    const b = openSystemStore(dbPath);
    try {
      const v = b._db
        .prepare(`SELECT version FROM explorer_schema_versions WHERE component = ?`)
        .get(L1_COMPONENT);
      assert.equal(v.version, L1_SCHEMA_SUPPORTED_VERSION);
    } finally {
      b.close();
    }
  });

  test("renames a versioned legacy L1 schema without losing edges or stitch runs", () => {
    const dbPath = join(dir, "legacy-names.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`${SHARED_SCHEMA_VERSIONS_DDL}
      CREATE TABLE system_edges (
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
        created_at TEXT NOT NULL,
        id_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_system_edges_ns ON system_edges(system_namespace);
      CREATE TABLE system_stitch_runs (
        run_id TEXT PRIMARY KEY,
        system_namespace TEXT NOT NULL,
        repos_json TEXT NOT NULL,
        edge_count INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO system_edges VALUES (
        'l1:edge:legacy', 'acme', 'acme', 'acme-cron', 'outbound',
        'acme', 'acme-tax', 'inbound', 'POST /pay', 'POST', '/pay',
        'contract-matched', 'path_template', 1.0, NULL,
        '{"edge_id":"l1:edge:legacy"}', '2026-08-07T12:00:00.000Z', 1
      );
      INSERT INTO system_stitch_runs VALUES (
        'run:legacy', 'acme', '["acme-cron","acme-tax"]', 1,
        '2026-08-07T12:01:00.000Z'
      );
    `);
    db.prepare(
      `INSERT INTO explorer_schema_versions (component, version, applied_at) VALUES (?,?,?)`,
    ).run(L1_COMPONENT, L1_SCHEMA_SUPPORTED_VERSION, "2026-08-07T12:02:00.000Z");
    db.close();

    const store = openSystemStore(dbPath);
    try {
      assert.equal(store._db.prepare(`SELECT COUNT(*) AS n FROM l1_system_edges`).get().n, 1);
      assert.equal(
        store._db.prepare(`SELECT COUNT(*) AS n FROM l1_system_stitch_runs`).get().n,
        1,
      );
      assert.equal(tableExists(store._db, "system_edges"), false);
      assert.equal(tableExists(store._db, "system_stitch_runs"), false);
      const indexes = store._db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`)
        .all()
        .map((row) => row.name);
      assert.ok(indexes.includes("idx_l1_system_edges_ns"));
      assert.ok(!indexes.includes("idx_system_edges_ns"));
    } finally {
      store.close();
    }
  });

  test("future version throws UnsupportedSchemaVersionError before any write", () => {
    const dbPath = join(dir, "future.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(SHARED_SCHEMA_VERSIONS_DDL);
      db.prepare(
        `INSERT INTO explorer_schema_versions (component, version, applied_at) VALUES (?,?,?)`,
      ).run(L1_COMPONENT, 99, "2030-01-01T00:00:00.000Z");
      db.exec(`CREATE TABLE system_stitch_runs (run_id TEXT PRIMARY KEY)`);
      db.close();
    } catch (e) {
      db.close();
      throw e;
    }

    assert.throws(
      () => openSystemStore(dbPath),
      (err) =>
        err instanceof UnsupportedSchemaVersionError &&
        err.component === L1_COMPONENT &&
        err.current === 99 &&
        err.supported === L1_SCHEMA_SUPPORTED_VERSION,
    );

    // Verify NO system_edges table was created by the failed open.
    const after = new DatabaseSync(dbPath);
    try {
      assert.equal(
        tableExists(after, "system_edges"),
        false,
        "failed migration must not create system_edges",
      );
      assert.equal(tableExists(after, "system_stitch_runs"), true);
      assert.equal(tableExists(after, "l1_system_stitch_runs"), false);
    } finally {
      after.close();
    }
  });

  test("id_version column participates in persist + read (defaults to 1 for legacy rows)", () => {
    const dbPath = join(dir, "persist.sqlite");
    const store = openSystemStore(dbPath);
    try {
      const edge = {
        edge_id: "l1:edge:abc",
        from: { namespace: "demo", logical_repo: "svc-a", fact_id: "l0:ff:http_outbound:abc" },
        to: { namespace: "demo", logical_repo: "svc-b", fact_id: "l0:ff:http_inbound:def" },
        contract_key: "GET /x",
        method: "GET",
        path: "/x",
        evidence_class: "contract-matched",
        match_kind: "config_binding",
        score: 0.95,
        evidence: [],
      };
      persistSystemEdges(store, "demo-system", [edge]);
      const rows = listSystemEdges(store, { system_namespace: "demo-system" });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].edge_id, "l1:edge:abc");
    } finally {
      store.close();
    }
  });
});
