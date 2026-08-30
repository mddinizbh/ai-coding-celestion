import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { runGc } from "../src/slice-gc.mjs";
import { openSliceStore } from "../src/slice-store.mjs";
import { SliceStoreError } from "../src/slice-errors.mjs";
import {
  canonicalSlicePayload,
  sliceHash,
  seedSetHash,
  optionsHash,
  edgeSetHash,
} from "../src/slice-canonical.mjs";
import { migrateComponentSchema } from "../../explorer-l0/src/schema-versions.mjs";
import {
  L1_COMPONENT,
  L1_SCHEMA_SUPPORTED_VERSION,
  L1_MIGRATION_STEPS,
} from "../../explorer-l1/src/system-store.mjs";
import {
  L2_COMPONENT,
  L2_SCHEMA_SUPPORTED_VERSION,
  L2_MIGRATION_STEPS,
} from "../../explorer-l2/src/journey-store.mjs";
import { stableStringify } from "../../explorer-l0/src/stable-json.mjs";

// --- Fixtures ----------------------------------------------------------------

function sampleSeeds() {
  return [
    { kind: "l0_fact", namespace: "ns-a", logical_repo: "repo-a", fact_id: "fact-1" },
    { kind: "l1_edge", system_namespace: "ns-sys", edge_id: "edge-2" },
    {
      kind: "l2_journey",
      system_namespace: "ns-sys",
      journey_id: "j-1",
      bind_id: "b-1",
    },
  ];
}

function buildCanonicalPayload(seedSetHashValue) {
  const seeds = sampleSeeds();
  const nodes = [{ id: "node-a", kind: "record", logical_repo: "repo-a" }];
  const edges = [
    { edge_id: "edge-a", system_namespace: "ns-sys", contract_key: "GET /a", from: "node-a", to: "node-b" },
  ];
  const misses = [];
  const baselines = [
    {
      namespace: "ns-a",
      logical_repo: "repo-a",
      candidate_id: "cand-1",
      source_revision: "rev-1",
      canonical_graph_hash: "h-1",
    },
  ];
  const bindings = [{ journey_id: "j-1", bind_id: "b-1", journey_hash: "jh-1" }];
  return {
    schema_version: 1,
    engine_version: "context-slice-engine/v2",
    system_namespace: "ns-sys",
    policy: { name: "journey", version: 1, options_hash: optionsHash({}) },
    seeds,
    seed_set_hash: seedSetHashValue || seedSetHash(seeds),
    nodes,
    edges,
    edge_set_hash: edgeSetHash(edges),
    misses,
    l0_baselines: baselines,
    l1: { system_namespace: "ns-sys", edge_set_hash: edgeSetHash(edges) },
    l2_bindings: bindings,
    coverage: { nodes: nodes.length, edges: edges.length, misses: misses.length },
  };
}

/**
 * Persist a slice and optionally backdate its created_at for older-than tests.
 * @param {object} store
 * @param {object} [opts]
 */
function persistSlice(store, opts = {}) {
  const {
    derivationKey = "a".repeat(64),
    seedSetHashVal = "set-a",
    createdAt = null,
  } = opts;
  const canonicalPayload = buildCanonicalPayload(seedSetHashVal);
  const canonical = canonicalSlicePayload(canonicalPayload);
  const hash = sliceHash(canonical);
  const res = store.persist({
    derivationKey,
    sliceHash: hash,
    canonicalPayload,
    provenance: { source: "test" },
    coverage: canonical.coverage,
    policy: { name: "journey", version: 1 },
    systemNamespace: "ns-sys",
    seedSetHash: seedSetHashVal,
    status: "materialized",
  });
  if (createdAt) {
    store._db
      .prepare(`UPDATE context_slices SET created_at = ? WHERE slice_id = ?`)
      .run(createdAt, res.slice_id);
  }
  return { ...res, slice_hash: hash };
}

/** @param {InstanceType<typeof DatabaseSync>} db */
function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}

/** Snapshot all context_slice_* counts. */
function sliceCounts(db) {
  return {
    slices: count(db, "context_slices"),
    seeds: count(db, "context_slice_seeds"),
    nodes: count(db, "context_slice_nodes"),
    edges: count(db, "context_slice_edges"),
    misses: count(db, "context_slice_misses"),
    current: count(db, "context_slice_current"),
  };
}

/**
 * Insert a minimal L1 system-edge row + L2 journey row into the DB so GC
 * invariant tests can prove those layers are untouched.
 * @param {InstanceType<typeof import("node:sqlite").DatabaseSync>} db
 */
function seedL1L2(db) {
  // L1 schema + tables.
  migrateComponentSchema({
    db,
    component: L1_COMPONENT,
    supportedVersion: L1_SCHEMA_SUPPORTED_VERSION,
    steps: L1_MIGRATION_STEPS,
    errorCtor: Error,
  });
  // L2 schema + tables.
  migrateComponentSchema({
    db,
    component: L2_COMPONENT,
    supportedVersion: L2_SCHEMA_SUPPORTED_VERSION,
    steps: L2_MIGRATION_STEPS,
    errorCtor: Error,
  });
  // L1 edge.
  db.prepare(
    `INSERT INTO l1_system_edges (
       edge_id, system_namespace, from_namespace, from_logical_repo, from_fact_id,
       to_namespace, to_logical_repo, to_fact_id, contract_key, method, path,
       evidence_class, match_kind, score, config_key, edge_json, created_at, id_version
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "l1:edge:abcdef0123456789abcdef0123456789",
    "ns-sys", "ns-a", "repo-a", "l0:ff:http_inbound:abc123def456",
    "ns-b", "repo-b", "l0:ff:http_outbound:xyz789abc012",
    "GET /api/x", "GET", "/api/x",
    "contract", "exact", 0.99, null,
    stableStringify({ edge_id: "l1:edge:abcdef0123456789abcdef0123456789" }),
    "2026-01-01T00:00:00.000Z",
    2,
  );
  // L2 journey spec.
  db.prepare(
    `INSERT INTO l2_journey_specs (
       system_namespace, journey_id, spec_revision, spec_json, created_at
     ) VALUES (?,?,?,?,?)`,
  ).run(
    "ns-sys", "l2:journey:j-1", "rev-1",
    stableStringify({ id: "j-1", steps: [] }),
    "2026-01-01T00:00:00.000Z",
  );
  // L2 journey bind.
  db.prepare(
    `INSERT INTO l2_journey_binds (
       bind_id, system_namespace, journey_id, spec_revision, journey_hash,
       status, steps_bound, steps_gap, members_json, bind_json, created_at, id_version
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "l2:bind:abcdef0123456789abcdef0123456789",
    "ns-sys", "l2:journey:j-1", "rev-1", "jh-1",
    "bound", 2, 0, stableStringify([]),
    stableStringify({ bind_id: "l2:bind:abcdef0123456789abcdef0123456789" }),
    "2026-01-01T00:00:00.000Z",
    2,
  );
}

/** Snapshot L1/L2 row counts + edge_json content for invariant comparison. */
function l1l2Snapshot(db) {
  return {
    l1_edges: count(db, "l1_system_edges"),
    l1_edge_json: db
      .prepare(`SELECT edge_json FROM l1_system_edges LIMIT 1`)
      .get()?.edge_json ?? null,
    l2_binds: count(db, "l2_journey_binds"),
    l2_specs: count(db, "l2_journey_specs"),
  };
}

// --- Tests -------------------------------------------------------------------

describe("slice-gc — dry-run default does not change counts", () => {
  test("dry-run on populated DB reports eligible but deletes nothing", () => {
    const store = openSliceStore(":memory:");
    try {
      const db = store._db;
      persistSlice(store, { derivationKey: "a".repeat(64), seedSetHashVal: "set-a" });
      persistSlice(store, { derivationKey: "b".repeat(64), seedSetHashVal: "set-b" });

      const before = sliceCounts(db);
      const report = runGc({
        db,
        filters: { olderThan: null, exceptHash: [], keepCurrent: false },
        dryRun: true,
      });
      const after = sliceCounts(db);

      assert.equal(report.mode, "dry-run");
      assert.equal(report.deleted_count, 0);
      assert.equal(after.slices, before.slices, "dry-run must not delete slices");
      assert.equal(after.seeds, before.seeds, "dry-run must not delete seeds");
      assert.equal(after.current, before.current, "dry-run must not delete current");
      assert.ok(report.eligible.length >= 2, "dry-run reports eligible slices");
    } finally {
      store.close();
    }
  });

  test("dry-run on empty DB returns eligible=[] and zero deletes", () => {
    const store = openSliceStore(":memory:");
    try {
      const report = runGc({
        db: store._db,
        filters: { olderThan: null, exceptHash: [], keepCurrent: false },
        dryRun: true,
      });
      assert.equal(report.mode, "dry-run");
      assert.equal(report.deleted_count, 0);
      assert.deepEqual(report.eligible, []);
    } finally {
      store.close();
    }
  });
});

describe("slice-gc — execute removes only eligible slices", () => {
  test("--older-than removes only old slices; recent slices survive", () => {
    const store = openSliceStore(":memory:");
    try {
      const db = store._db;
      const old1 = persistSlice(store, {
        derivationKey: "a".repeat(64),
        seedSetHashVal: "set-a",
        createdAt: "2020-01-01T00:00:00.000Z",
      });
      const old2 = persistSlice(store, {
        derivationKey: "b".repeat(64),
        seedSetHashVal: "set-b",
        createdAt: "2020-06-01T00:00:00.000Z",
      });
      const recent = persistSlice(store, {
        derivationKey: "c".repeat(64),
        seedSetHashVal: "set-c",
        createdAt: "2026-08-07T00:00:00.000Z",
      });

      const before = sliceCounts(db);
      assert.equal(before.slices, 3);

      const report = runGc({
        db,
        filters: {
          olderThan: "2025-01-01T00:00:00.000Z",
          exceptHash: [],
          keepCurrent: false,
        },
        dryRun: false,
      });

      assert.equal(report.mode, "execute");
      assert.equal(report.deleted_count, 2);
      assert.ok(report.eligible.includes(old1.slice_id));
      assert.ok(report.eligible.includes(old2.slice_id));
      assert.ok(!report.eligible.includes(recent.slice_id));

      const after = sliceCounts(db);
      assert.equal(after.slices, 1, "only the recent slice survives");
      // Verify the surviving slice is the recent one.
      const survivors = db
        .prepare(`SELECT slice_id FROM context_slices`)
        .all()
        .map((r) => r.slice_id);
      assert.deepEqual(survivors, [recent.slice_id]);
    } finally {
      store.close();
    }
  });

  test("execute with no filters removes ALL slices", () => {
    const store = openSliceStore(":memory:");
    try {
      const db = store._db;
      persistSlice(store, { derivationKey: "a".repeat(64), seedSetHashVal: "set-a" });
      persistSlice(store, { derivationKey: "b".repeat(64), seedSetHashVal: "set-b" });

      const report = runGc({
        db,
        filters: { olderThan: null, exceptHash: [], keepCurrent: false },
        dryRun: false,
      });
      assert.equal(report.deleted_count, 2);
      assert.equal(sliceCounts(db).slices, 0);
    } finally {
      store.close();
    }
  });
});

describe("slice-gc — FK cascade removes child rows", () => {
  test("deleting a slice cascades to seeds/nodes/edges/misses/current", () => {
    const store = openSliceStore(":memory:");
    try {
      const db = store._db;
      persistSlice(store, { derivationKey: "a".repeat(64), seedSetHashVal: "set-a" });
      persistSlice(store, { derivationKey: "b".repeat(64), seedSetHashVal: "set-b" });

      const before = sliceCounts(db);
      assert.ok(before.seeds > 0, "seeds exist before GC");
      assert.ok(before.current > 0, "current pointers exist before GC");

      runGc({
        db,
        filters: { olderThan: null, exceptHash: [], keepCurrent: false },
        dryRun: false,
      });

      const after = sliceCounts(db);
      assert.equal(after.slices, 0);
      assert.equal(after.seeds, 0, "seeds cascaded");
      assert.equal(after.nodes, 0, "nodes cascaded");
      assert.equal(after.edges, 0, "edges cascaded");
      assert.equal(after.misses, 0, "misses cascaded");
      assert.equal(after.current, 0, "current cascaded");
    } finally {
      store.close();
    }
  });
});

describe("slice-gc --keep-current preserves current pointers", () => {
  test("--keep-current excludes slices referenced by context_slice_current", () => {
    const store = openSliceStore(":memory:");
    try {
      const db = store._db;
      const current1 = persistSlice(store, {
        derivationKey: "a".repeat(64),
        seedSetHashVal: "set-a",
      });
      const current2 = persistSlice(store, {
        derivationKey: "b".repeat(64),
        seedSetHashVal: "set-b",
      });
      // A third slice with no current pointer.
      const orphan = persistSlice(store, {
        derivationKey: "c".repeat(64),
        seedSetHashVal: "set-c",
      });
      // Remove the orphan's current pointer so --keep-current does NOT protect it.
      db.prepare(`DELETE FROM context_slice_current WHERE slice_id = ?`).run(
        orphan.slice_id,
      );

      const before = sliceCounts(db);
      assert.equal(before.current, 2, "two current pointers (set-a + set-b)");
      assert.equal(before.slices, 3);

      const report = runGc({
        db,
        filters: { olderThan: null, exceptHash: [], keepCurrent: true },
        dryRun: false,
      });

      assert.equal(report.deleted_count, 1);
      assert.ok(report.eligible.includes(orphan.slice_id));
      assert.ok(!report.eligible.includes(current1.slice_id));
      assert.ok(!report.eligible.includes(current2.slice_id));

      const after = sliceCounts(db);
      assert.equal(after.slices, 2, "current slices survive");
      assert.equal(after.current, 2, "current pointers preserved");

      // Verify the surviving slices are exactly the current-pointed ones.
      const survivors = db
        .prepare(`SELECT slice_id FROM context_slices`)
        .all()
        .map((r) => r.slice_id)
        .sort();
      assert.deepEqual(
        survivors,
        [current1.slice_id, current2.slice_id].sort(),
      );
    } finally {
      store.close();
    }
  });
});

describe("slice-gc --except-hash preserves specified slices", () => {
  test("--except-hash excludes the named slice_hash from deletion", () => {
    const store = openSliceStore(":memory:");
    try {
      const db = store._db;
      const s1 = persistSlice(store, {
        derivationKey: "a".repeat(64),
        seedSetHashVal: "set-a",
      });
      const s2 = persistSlice(store, {
        derivationKey: "b".repeat(64),
        seedSetHashVal: "set-b",
      });
      const s3 = persistSlice(store, {
        derivationKey: "c".repeat(64),
        seedSetHashVal: "set-c",
      });

      const report = runGc({
        db,
        filters: {
          olderThan: null,
          exceptHash: [s2.slice_hash],
          keepCurrent: false,
        },
        dryRun: false,
      });

      assert.equal(report.deleted_count, 2);
      assert.ok(!report.eligible.includes(s2.slice_id));

      const survivors = db
        .prepare(`SELECT slice_id FROM context_slices`)
        .all()
        .map((r) => r.slice_id);
      assert.deepEqual(survivors, [s2.slice_id]);
    } finally {
      store.close();
    }
  });

  test("multiple --except-hash values all preserved", () => {
    const store = openSliceStore(":memory:");
    try {
      const db = store._db;
      const s1 = persistSlice(store, { derivationKey: "a".repeat(64), seedSetHashVal: "set-a" });
      const s2 = persistSlice(store, { derivationKey: "b".repeat(64), seedSetHashVal: "set-b" });
      const s3 = persistSlice(store, { derivationKey: "c".repeat(64), seedSetHashVal: "set-c" });
      const s4 = persistSlice(store, { derivationKey: "d".repeat(64), seedSetHashVal: "set-d" });

      const report = runGc({
        db,
        filters: {
          olderThan: null,
          exceptHash: [s1.slice_hash, s3.slice_hash],
          keepCurrent: false,
        },
        dryRun: false,
      });

      assert.equal(report.deleted_count, 2);
      const survivors = db
        .prepare(`SELECT slice_id FROM context_slices`)
        .all()
        .map((r) => r.slice_id)
        .sort();
      assert.deepEqual(survivors, [s1.slice_id, s3.slice_id].sort());
    } finally {
      store.close();
    }
  });
});

describe("slice-gc — invalid filters rejected without delete", () => {
  test("invalid --older-than (not ISO 8601) throws and deletes nothing", () => {
    const store = openSliceStore(":memory:");
    try {
      const db = store._db;
      persistSlice(store, { derivationKey: "a".repeat(64), seedSetHashVal: "set-a" });
      const before = sliceCounts(db);

      assert.throws(
        () =>
          runGc({
            db,
            filters: {
              olderThan: "not-a-date",
              exceptHash: [],
              keepCurrent: false,
            },
            dryRun: false,
          }),
        (err) => {
          assert.ok(err instanceof SliceStoreError, "must be SliceStoreError");
          return true;
        },
      );

      const after = sliceCounts(db);
      assert.equal(after.slices, before.slices, "no slice deleted on invalid filter");
      assert.equal(after.seeds, before.seeds, "no child rows deleted");
    } finally {
      store.close();
    }
  });

  test("invalid --except-hash (not 64-hex) throws and deletes nothing", () => {
    const store = openSliceStore(":memory:");
    try {
      const db = store._db;
      persistSlice(store, { derivationKey: "a".repeat(64), seedSetHashVal: "set-a" });
      const before = sliceCounts(db);

      assert.throws(
        () =>
          runGc({
            db,
            filters: {
              olderThan: null,
              exceptHash: ["not-a-hash"],
              keepCurrent: false,
            },
            dryRun: false,
          }),
        (err) => {
          assert.ok(err instanceof SliceStoreError, "must be SliceStoreError");
          return true;
        },
      );

      const after = sliceCounts(db);
      assert.equal(after.slices, before.slices, "no slice deleted on invalid hash");
    } finally {
      store.close();
    }
  });

  test("invalid filter in dry-run also throws (validation is pre-DB)", () => {
    const store = openSliceStore(":memory:");
    try {
      assert.throws(
        () =>
          runGc({
            db: store._db,
            filters: { olderThan: "garbage", exceptHash: [], keepCurrent: false },
            dryRun: true,
          }),
        SliceStoreError,
      );
    } finally {
      store.close();
    }
  });
});

describe("slice-gc — L0/L1/L2 invariants (never touches canonical layers)", () => {
  test("L1 system-edge row count + edge_json byte-identical before and after GC", () => {
    const store = openSliceStore(":memory:");
    try {
      const db = store._db;
      seedL1L2(db); // add L1/L2 tables + rows on the SAME connection
      persistSlice(store, { derivationKey: "a".repeat(64), seedSetHashVal: "set-a" });

      const snapBefore = l1l2Snapshot(db);

      runGc({
        db,
        filters: { olderThan: null, exceptHash: [], keepCurrent: false },
        dryRun: false,
      });

      const snapAfter = l1l2Snapshot(db);
      assert.equal(snapAfter.l1_edges, snapBefore.l1_edges, "L1 edge count unchanged");
      assert.equal(snapAfter.l1_edge_json, snapBefore.l1_edge_json, "L1 edge_json byte-identical");
      assert.equal(snapAfter.l2_binds, snapBefore.l2_binds, "L2 binds unchanged");
      assert.equal(snapAfter.l2_specs, snapBefore.l2_specs, "L2 specs unchanged");
    } finally {
      store.close();
    }
  });

  test("L0/L1/L2 survive even when all slices are deleted", () => {
    const store = openSliceStore(":memory:");
    try {
      const db = store._db;
      seedL1L2(db);
      persistSlice(store, { derivationKey: "a".repeat(64), seedSetHashVal: "set-a" });
      persistSlice(store, { derivationKey: "b".repeat(64), seedSetHashVal: "set-b" });

      const snapBefore = l1l2Snapshot(db);

      const report = runGc({
        db,
        filters: { olderThan: null, exceptHash: [], keepCurrent: false },
        dryRun: false,
      });
      assert.equal(report.deleted_count, 2);

      const snapAfter = l1l2Snapshot(db);
      assert.equal(snapAfter.l1_edges, snapBefore.l1_edges, "L1 untouched");
      assert.equal(snapAfter.l1_edge_json, snapBefore.l1_edge_json, "L1 content identical");
      assert.equal(snapAfter.l2_binds, snapBefore.l2_binds, "L2 binds untouched");
      assert.equal(snapAfter.l2_specs, snapBefore.l2_specs, "L2 specs untouched");
    } finally {
      store.close();
    }
  });
});

describe("slice-gc — never runs VACUUM", () => {
  test("no VACUUM statement appears in the query log during GC", () => {
    const store = openSliceStore(":memory:");
    try {
      const db = store._db;
      persistSlice(store, { derivationKey: "a".repeat(64), seedSetHashVal: "set-a" });

      // Monkeypatch db.exec to capture every statement.
      const origExec = db.exec.bind(db);
      const statements = [];
      db.exec = (sql) => {
        statements.push(sql);
        return origExec(sql);
      };

      runGc({
        db,
        filters: { olderThan: null, exceptHash: [], keepCurrent: false },
        dryRun: false,
      });

      db.exec = origExec; // restore for cleanup.

      const vacuumCalls = statements.filter((s) =>
        /\bVACUUM\b/i.test(s),
      );
      assert.equal(vacuumCalls.length, 0, "GC must NEVER issue VACUUM");
    } finally {
      store.close();
    }
  });
});

describe("slice-gc — combined filters", () => {
  test("--older-than + --except-hash + --keep-current all apply together", () => {
    const store = openSliceStore(":memory:");
    try {
      const db = store._db;
      const old_current = persistSlice(store, {
        derivationKey: "a".repeat(64),
        seedSetHashVal: "set-a",
        createdAt: "2020-01-01T00:00:00.000Z",
      });
      const old_excepted = persistSlice(store, {
        derivationKey: "b".repeat(64),
        seedSetHashVal: "set-b",
        createdAt: "2020-01-01T00:00:00.000Z",
      });
      const old_eligible = persistSlice(store, {
        derivationKey: "c".repeat(64),
        seedSetHashVal: "set-c",
        createdAt: "2020-01-01T00:00:00.000Z",
      });
      const recent = persistSlice(store, {
        derivationKey: "d".repeat(64),
        seedSetHashVal: "set-d",
        createdAt: "2026-08-07T00:00:00.000Z",
      });
      // Remove old_eligible's current pointer so --keep-current does NOT protect it.
      db.prepare(`DELETE FROM context_slice_current WHERE slice_id = ?`).run(
        old_eligible.slice_id,
      );

      const report = runGc({
        db,
        filters: {
          olderThan: "2025-01-01T00:00:00.000Z",
          exceptHash: [old_excepted.slice_hash],
          keepCurrent: true,
        },
        dryRun: false,
      });

      // Only old_eligible qualifies: old + not excepted + not current.
      assert.equal(report.deleted_count, 1);
      assert.ok(report.eligible.includes(old_eligible.slice_id));
      assert.ok(!report.eligible.includes(old_current.slice_id), "current preserved");
      assert.ok(!report.eligible.includes(old_excepted.slice_id), "excepted preserved");
      assert.ok(!report.eligible.includes(recent.slice_id), "recent preserved");

      const survivors = db
        .prepare(`SELECT slice_id FROM context_slices`)
        .all()
        .map((r) => r.slice_id)
        .sort();
      assert.deepEqual(
        survivors,
        [old_current.slice_id, old_excepted.slice_id, recent.slice_id].sort(),
      );
    } finally {
      store.close();
    }
  });
});
