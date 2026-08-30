import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { loadAcceptedBaselines } from "../src/stitch.mjs";

test("loadAcceptedBaselines reads an already-prefixed L0 schema read-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "l1-baseline-table-names-"));
  const dbPath = join(dir, "descobrir.sqlite");
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE l0_candidate_packages (
        candidate_id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        logical_repo TEXT NOT NULL,
        source_revision TEXT NOT NULL,
        canonical_graph_hash TEXT NOT NULL
      );
      CREATE TABLE l0_accepted_baselines (
        namespace TEXT NOT NULL,
        logical_repo TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        approver TEXT NOT NULL,
        accepted_at TEXT NOT NULL
      );
      INSERT INTO l0_candidate_packages VALUES (
        'candidate:legacy', 'acme', 'acme-cron', 'abc123', 'graph-hash'
      );
      INSERT INTO l0_accepted_baselines VALUES (
        'acme', 'acme-cron', 'candidate:legacy', 'Marley',
        '2026-08-07T12:00:00.000Z'
      );
    `);
    db.close();

    const rows = loadAcceptedBaselines(dbPath, "acme", ["acme-cron"]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].candidate_id, "candidate:legacy");
    assert.equal(rows[0].source_revision, "abc123");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
