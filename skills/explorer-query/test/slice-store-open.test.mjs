import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSliceStore } from "../src/slice-store.mjs";
import { SliceMigrationError, SliceStoreError } from "../src/slice-errors.mjs";
import {
  SLICE_COMPONENT,
  SLICE_SCHEMA_SUPPORTED_VERSION,
  SHARED_SCHEMA_VERSIONS_DDL,
} from "../src/slice-store-schema.mjs";

const SLICE_TABLES = [
  "context_slices",
  "context_slice_seeds",
  "context_slice_nodes",
  "context_slice_edges",
  "context_slice_misses",
  "context_slice_current",
];

/**
 * @param {InstanceType<typeof DatabaseSync>} db
 * @param {string} name
 */
function tableExists(db, name) {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(name) !== undefined
  );
}

describe("slice-store — open/close lifecycle", () => {
  test("openSliceStore(':memory:') works, migrates, and close() releases the handle", () => {
    const store = openSliceStore(":memory:");
    assert.equal(store.dbPath, ":memory:");
    assert.ok(store._db instanceof DatabaseSync);

    const v = store._db
      .prepare(`SELECT version FROM explorer_schema_versions WHERE component = ?`)
      .get(SLICE_COMPONENT);
    assert.equal(v.version, SLICE_SCHEMA_SUPPORTED_VERSION);

    for (const t of SLICE_TABLES) {
      assert.equal(tableExists(store._db, t), true, `expected ${t} on :memory: open`);
    }

    store.close();
    // closing again must throw — proves the first close released the handle
    assert.throws(() => store.close(), /not open|closed|SQLITE/i);
  });

  test("file DB reopen is idempotent — version stays 1, applied_at unchanged, tables intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "slice-store-reopen-"));
    const dbPath = join(dir, "slice.sqlite");
    try {
      const s1 = openSliceStore(dbPath);
      const appliedAt1 = s1._db
        .prepare(`SELECT applied_at FROM explorer_schema_versions WHERE component = ?`)
        .get(SLICE_COMPONENT).applied_at;
      s1.close();

      const s2 = openSliceStore(dbPath);
      const appliedAt2 = s2._db
        .prepare(`SELECT applied_at FROM explorer_schema_versions WHERE component = ?`)
        .get(SLICE_COMPONENT).applied_at;
      assert.equal(appliedAt2, appliedAt1, "applied_at must not change on reopen");

      for (const t of SLICE_TABLES) {
        assert.equal(tableExists(s2._db, t), true, `expected ${t} to survive reopen`);
      }
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file DB has mode 0600 after open", () => {
    const dir = mkdtempSync(join(tmpdir(), "slice-store-mode-"));
    const dbPath = join(dir, "slice.sqlite");
    try {
      const store = openSliceStore(dbPath);
      store.close();
      const st = statSync(dbPath);
      const mode = st.mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got 0o${mode.toString(8)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("opening the Slice store migrates shared legacy layer table names", () => {
    const dir = mkdtempSync(join(tmpdir(), "slice-store-layer-names-"));
    const dbPath = join(dir, "slice.sqlite");
    try {
      const seed = new DatabaseSync(dbPath);
      seed.exec(`
        CREATE TABLE system_stitch_runs (
          run_id TEXT PRIMARY KEY,
          system_namespace TEXT NOT NULL,
          repos_json TEXT NOT NULL,
          edge_count INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO system_stitch_runs VALUES (
          'run:legacy', 'acme', '[]', 0, '2026-08-07T12:00:00.000Z'
        );
      `);
      seed.close();

      const store = openSliceStore(dbPath);
      assert.equal(tableExists(store._db, "system_stitch_runs"), false);
      assert.equal(tableExists(store._db, "l1_system_stitch_runs"), true);
      assert.equal(
        store._db.prepare(`SELECT COUNT(*) AS n FROM l1_system_stitch_runs`).get().n,
        1,
      );
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("opening a DB pre-seeded with version 99 throws SliceMigrationError and leaves no Slice tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "slice-store-future-"));
    const dbPath = join(dir, "slice.sqlite");
    try {
      const seed = new DatabaseSync(dbPath);
      seed.exec(SHARED_SCHEMA_VERSIONS_DDL);
      seed.prepare(
        `INSERT INTO explorer_schema_versions (component, version, applied_at) VALUES (?,?,?)`,
      ).run(SLICE_COMPONENT, 99, "2030-01-01T00:00:00.000Z");
      seed.exec(`CREATE TABLE system_stitch_runs (run_id TEXT PRIMARY KEY)`);
      seed.close();

      assert.throws(
        () => openSliceStore(dbPath),
        (err) => err instanceof SliceMigrationError,
      );

      // failed open must not have created any Slice tables
      const verify = new DatabaseSync(dbPath);
      try {
        for (const t of SLICE_TABLES) {
          assert.equal(
            tableExists(verify, t),
            false,
            `unexpected Slice table ${t} after failed open`,
          );
        }
        assert.equal(tableExists(verify, "system_stitch_runs"), true);
        assert.equal(tableExists(verify, "l1_system_stitch_runs"), false);
      } finally {
        verify.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("openSliceStore rejects empty / non-string dbPath with SliceStoreError", () => {
    assert.throws(
      () => openSliceStore(""),
      (err) => err instanceof SliceStoreError,
    );
    assert.throws(
      () => openSliceStore(/** @type {unknown} */ (null)),
      (err) => err instanceof SliceStoreError,
    );
  });
});
