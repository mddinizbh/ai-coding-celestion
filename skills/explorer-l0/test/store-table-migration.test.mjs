import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";

import { openStore } from "../src/store.mjs";

const temps = [];

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "descobrir-l0-migration-"));
  temps.push(dir);
  return join(dir, "descobrir.sqlite");
}

afterEach(() => {
  while (temps.length > 0) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

describe("L0 table-name migration", () => {
  test("renames legacy tables atomically and preserves candidates, baselines, indexes, and foreign keys", () => {
    const dbPath = tempDbPath();
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE candidate_packages (
        candidate_id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        logical_repo TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        canonical_graph_hash TEXT NOT NULL,
        package_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (namespace, logical_repo, source_revision, canonical_graph_hash)
      );
      CREATE TABLE accepted_baselines (
        namespace TEXT NOT NULL,
        logical_repo TEXT NOT NULL,
        candidate_id TEXT NOT NULL REFERENCES candidate_packages(candidate_id),
        approver TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        PRIMARY KEY (namespace, logical_repo)
      );
      CREATE INDEX idx_candidates_ns_repo
        ON candidate_packages (namespace, logical_repo);
      INSERT INTO candidate_packages VALUES (
        'candidate:legacy', 'acme', 'acme-cron', 'abc123',
        'graph-hash', '{"legacy":true}', '2026-08-07T12:00:00.000Z'
      );
      INSERT INTO accepted_baselines VALUES (
        'acme', 'acme-cron', 'candidate:legacy', 'Marley',
        '2026-08-07T12:01:00.000Z'
      );
    `);
    legacy.close();

    const store = openStore(dbPath);
    assert.equal(
      store.listCandidates({ namespace: "acme", logical_repo: "acme-cron" })[0]
        .candidate_id,
      "candidate:legacy",
    );
    assert.equal(
      store.getAcceptedBaseline({ namespace: "acme", logical_repo: "acme-cron" })
        .candidate_id,
      "candidate:legacy",
    );
    store.close();

    const migrated = new DatabaseSync(dbPath, { readOnly: true });
    const objects = migrated
      .prepare(
        `SELECT type, name FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all()
      .map((row) => `${row.type}:${row.name}`);
    const foreignKeyViolations = migrated.prepare("PRAGMA foreign_key_check").all();
    migrated.close();

    assert.deepEqual(objects, [
      "index:idx_l0_candidates_ns_repo",
      "table:l0_accepted_baselines",
      "table:l0_candidate_packages",
    ]);
    assert.deepEqual(foreignKeyViolations, []);
  });

  test("fails before mutation when legacy and layered table names collide", () => {
    const dbPath = tempDbPath();
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE candidate_packages (candidate_id TEXT PRIMARY KEY);
      CREATE TABLE l0_candidate_packages (candidate_id TEXT PRIMARY KEY);
      CREATE TABLE system_edges (edge_id TEXT PRIMARY KEY);
    `);
    db.close();

    assert.throws(
      () => openStore(dbPath),
      /legacy\/layered schema name collision: candidate_packages\+l0_candidate_packages/,
    );

    const unchanged = new DatabaseSync(dbPath, { readOnly: true });
    const tables = unchanged
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => row.name);
    unchanged.close();

    assert.deepEqual(tables, [
      "candidate_packages",
      "l0_candidate_packages",
      "system_edges",
    ]);
  });
});
