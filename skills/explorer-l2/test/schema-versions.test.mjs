import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  L2_COMPONENT,
  L2_SCHEMA_SUPPORTED_VERSION,
  UnsupportedSchemaVersionError,
  openJourneyStore,
} from "../src/journey-store.mjs";
import {
  SHARED_SCHEMA_VERSIONS_DDL,
  tableExists,
} from "../../explorer-l0/src/schema-versions.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "l2-schema-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("L2 journey-store — component-scoped schema versioning (ADR 0009)", () => {
  test("fresh DB migrates to L2_SCHEMA_SUPPORTED_VERSION and adds id_version column", () => {
    const dbPath = join(dir, "l2.sqlite");
    const store = openJourneyStore(dbPath);
    try {
      const v = store._db
        .prepare(`SELECT version FROM explorer_schema_versions WHERE component = ?`)
        .get(L2_COMPONENT);
      assert.equal(v.version, L2_SCHEMA_SUPPORTED_VERSION);

      const cols = store._db
        .prepare(`PRAGMA table_info(l2_journey_binds)`)
        .all()
        .map((c) => c.name);
      assert.ok(cols.includes("id_version"), "id_version column must exist after migration");
      for (const table of [
        "journey_specs",
        "journey_binds",
        "journey_step_edges",
        "journey_current",
      ]) {
        assert.equal(tableExists(store._db, table), false);
      }
    } finally {
      store.close();
    }
  });

  test("reopen is idempotent", () => {
    const dbPath = join(dir, "l2.sqlite");
    const a = openJourneyStore(dbPath);
    a.close();
    const b = openJourneyStore(dbPath);
    try {
      const v = b._db
        .prepare(`SELECT version FROM explorer_schema_versions WHERE component = ?`)
        .get(L2_COMPONENT);
      assert.equal(v.version, L2_SCHEMA_SUPPORTED_VERSION);
    } finally {
      b.close();
    }
  });

  test("renames a versioned legacy L2 schema without losing journey relations", () => {
    const dbPath = join(dir, "legacy-names.sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`${SHARED_SCHEMA_VERSIONS_DDL}
      CREATE TABLE journey_specs (
        system_namespace TEXT NOT NULL,
        journey_id TEXT NOT NULL,
        spec_revision TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (system_namespace, journey_id, spec_revision)
      );
      CREATE TABLE journey_binds (
        bind_id TEXT PRIMARY KEY,
        system_namespace TEXT NOT NULL,
        journey_id TEXT NOT NULL,
        spec_revision TEXT NOT NULL,
        journey_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        steps_bound INTEGER NOT NULL,
        steps_gap INTEGER NOT NULL,
        members_json TEXT NOT NULL,
        bind_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        id_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_journey_binds_ns_id
        ON journey_binds(system_namespace, journey_id, created_at DESC);
      CREATE TABLE journey_step_edges (
        bind_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        edge_id TEXT NOT NULL,
        step_status TEXT NOT NULL,
        PRIMARY KEY (bind_id, step_id, edge_id)
      );
      CREATE INDEX idx_journey_step_edges_edge ON journey_step_edges(edge_id);
      CREATE TABLE journey_current (
        system_namespace TEXT NOT NULL,
        journey_id TEXT NOT NULL,
        bind_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (system_namespace, journey_id)
      );
      INSERT INTO journey_specs VALUES (
        'acme', 'l2:journey:settlement', 'rev-1', '{}',
        '2026-08-07T12:00:00.000Z'
      );
      INSERT INTO journey_binds VALUES (
        'l2:bind:legacy', 'acme', 'l2:journey:settlement', 'rev-1',
        'hash-1', 'bound', 1, 0, '[]', '{}',
        '2026-08-07T12:01:00.000Z', 1
      );
      INSERT INTO journey_step_edges VALUES (
        'l2:bind:legacy', 'step-1', 'l1:edge:legacy', 'bound'
      );
      INSERT INTO journey_current VALUES (
        'acme', 'l2:journey:settlement', 'l2:bind:legacy',
        '2026-08-07T12:02:00.000Z'
      );
    `);
    db.prepare(
      `INSERT INTO explorer_schema_versions (component, version, applied_at) VALUES (?,?,?)`,
    ).run(L2_COMPONENT, L2_SCHEMA_SUPPORTED_VERSION, "2026-08-07T12:03:00.000Z");
    db.close();

    const store = openJourneyStore(dbPath);
    try {
      for (const table of [
        "l2_journey_specs",
        "l2_journey_binds",
        "l2_journey_step_edges",
        "l2_journey_current",
      ]) {
        assert.equal(store._db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1);
      }
      for (const table of [
        "journey_specs",
        "journey_binds",
        "journey_step_edges",
        "journey_current",
      ]) {
        assert.equal(tableExists(store._db, table), false);
      }
      const indexes = store._db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'`)
        .all()
        .map((row) => row.name);
      assert.ok(indexes.includes("idx_l2_journey_binds_ns_id"));
      assert.ok(indexes.includes("idx_l2_journey_step_edges_edge"));
      assert.ok(!indexes.includes("idx_journey_binds_ns_id"));
      assert.ok(!indexes.includes("idx_journey_step_edges_edge"));
    } finally {
      store.close();
    }
  });

  test("future version throws UnsupportedSchemaVersionError before any write", () => {
    const dbPath = join(dir, "future.sqlite");
    const seed = new DatabaseSync(dbPath);
    try {
      seed.exec(SHARED_SCHEMA_VERSIONS_DDL);
      seed.prepare(
        `INSERT INTO explorer_schema_versions (component, version, applied_at) VALUES (?,?,?)`,
      ).run(L2_COMPONENT, 99, "2030-01-01T00:00:00.000Z");
      seed.exec(`CREATE TABLE journey_current (journey_id TEXT PRIMARY KEY)`);
      seed.close();
    } catch (e) {
      seed.close();
      throw e;
    }

    assert.throws(
      () => openJourneyStore(dbPath),
      (err) =>
        err instanceof UnsupportedSchemaVersionError &&
        err.component === L2_COMPONENT &&
        err.current === 99 &&
        err.supported === L2_SCHEMA_SUPPORTED_VERSION,
    );

    const after = new DatabaseSync(dbPath);
    try {
      assert.equal(
        tableExists(after, "journey_binds"),
        false,
        "failed migration must not create journey_binds",
      );
      assert.equal(tableExists(after, "journey_current"), true);
      assert.equal(tableExists(after, "l2_journey_current"), false);
    } finally {
      after.close();
    }
  });
});
