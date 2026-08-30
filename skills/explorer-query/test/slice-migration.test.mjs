import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  migrateSliceSchema,
  getSliceSchemaVersion,
  SLICE_COMPONENT,
  SLICE_SCHEMA_SUPPORTED_VERSION,
  SHARED_SCHEMA_VERSIONS_DDL,
} from "../src/slice-store-schema.mjs";
import { SliceMigrationError } from "../src/slice-errors.mjs";

/** The six Slice-owned tables (the shared versions table is managed separately). */
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

/**
 * @param {InstanceType<typeof DatabaseSync>} db
 */
function listTables(db) {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all()
    .map((r) => r.name);
}

describe("slice-store-schema — v0→v2 migration (ADR 0009)", () => {
  test("fresh :memory: DB migrates from v0 to supported and creates all seven tables", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const result = migrateSliceSchema(db);
      assert.equal(result.migrated, true, "first run should report migrated=true");
      assert.equal(result.from, 0);
      assert.equal(result.to, SLICE_SCHEMA_SUPPORTED_VERSION);
      assert.ok(result.steps.length >= 1, "at least one DDL step must be reported");

      const v = db
        .prepare(
          `SELECT version, applied_at FROM explorer_schema_versions WHERE component = ?`,
        )
        .get(SLICE_COMPONENT);
      assert.equal(v.version, SLICE_SCHEMA_SUPPORTED_VERSION);
      assert.ok(
        typeof v.applied_at === "string" && v.applied_at.length > 0,
        "applied_at must be a non-empty ISO timestamp",
      );

      for (const t of SLICE_TABLES) {
        assert.equal(tableExists(db, t), true, `expected Slice table ${t} after migration`);
      }
      assert.equal(
        tableExists(db, "explorer_schema_versions"),
        true,
        "shared versions table must exist",
      );

      // ADR 0009: id_version column must exist on context_slices.
      const cols = db
        .prepare(`PRAGMA table_info(context_slices)`)
        .all()
        .map((c) => c.name);
      assert.ok(cols.includes("id_version"), "id_version column must exist after migration");
    } finally {
      db.close();
    }
  });

  test("migrateSliceSchema is idempotent — second call on the same handle is a no-op", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateSliceSchema(db);
      const firstAppliedAt = db
        .prepare(
          `SELECT applied_at FROM explorer_schema_versions WHERE component = ?`,
        )
        .get(SLICE_COMPONENT).applied_at;

      const second = migrateSliceSchema(db);
      assert.equal(second.migrated, false, "second call must be a no-op");
      assert.equal(second.from, SLICE_SCHEMA_SUPPORTED_VERSION);
      assert.equal(second.to, SLICE_SCHEMA_SUPPORTED_VERSION);

      const secondAppliedAt = db
        .prepare(
          `SELECT applied_at FROM explorer_schema_versions WHERE component = ?`,
        )
        .get(SLICE_COMPONENT).applied_at;
      assert.equal(
        secondAppliedAt,
        firstAppliedAt,
        "applied_at must not change on idempotent reopen",
      );
    } finally {
      db.close();
    }
  });

  test("version > supported throws SliceMigrationError and leaves zero Slice tables", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(SHARED_SCHEMA_VERSIONS_DDL);
      db.prepare(
        `INSERT INTO explorer_schema_versions (component, version, applied_at) VALUES (?,?,?)`,
      ).run(SLICE_COMPONENT, 99, "2030-01-01T00:00:00.000Z");

      assert.throws(
        () => migrateSliceSchema(db),
        (err) => err instanceof SliceMigrationError && /99/.test(err.message),
      );

      const tables = listTables(db);
      for (const t of SLICE_TABLES) {
        assert.equal(
          tables.includes(t),
          false,
          `unexpected Slice table ${t} created after failed migration`,
        );
      }
    } finally {
      db.close();
    }
  });

  test("getSliceSchemaVersion returns 0 for fresh DB and 1 after migration", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(SHARED_SCHEMA_VERSIONS_DDL);
      assert.equal(getSliceSchemaVersion(db), 0);
      migrateSliceSchema(db);
      assert.equal(getSliceSchemaVersion(db), SLICE_SCHEMA_SUPPORTED_VERSION);
    } finally {
      db.close();
    }
  });

});

describe("slice-store-schema — shared-DB coexistence", () => {
  test("migration alongside pre-existing L1/L2 tables leaves them byte-identical", () => {
    const db = new DatabaseSync(":memory:");
    try {
      // Simulate L1 having created system_edges + its own row in versions table.
      db.exec(`
        CREATE TABLE system_edges (edge_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        INSERT INTO system_edges VALUES ('e1', 'l1-original');
      `);
      db.exec(SHARED_SCHEMA_VERSIONS_DDL);
      db.prepare(
        `INSERT INTO explorer_schema_versions (component, version, applied_at) VALUES (?,?,?)`,
      ).run("l1-stitch", 1, "2025-01-01T00:00:00.000Z");

      migrateSliceSchema(db);

      // L1 table untouched
      const row = db.prepare(`SELECT payload FROM system_edges WHERE edge_id = ?`).get("e1");
      assert.equal(row.payload, "l1-original");

      // L1 version row untouched; context-slice row added
      const versions = db
        .prepare(`SELECT component, version FROM explorer_schema_versions ORDER BY component`)
        .all();
      assert.deepEqual(
        versions.map((v) => v.component),
        ["context-slice", "l1-stitch"],
      );
    } finally {
      db.close();
    }
  });
});
