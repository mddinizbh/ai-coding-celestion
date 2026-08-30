/**
 * P0 fixes from ROADMAP:
 * 1. Composite PK (system_namespace, edge_id) — two namespaces may own the
 *    same edge_id; neither is dropped (schema v3, lossless migration).
 * 2. Restitch replaces the run's scope atomically — no duplicate edges after
 *    re-extraction, edges outside the run's scope survive, crash rolls back.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  L1_COMPONENT,
  L1_MIGRATION_STEPS,
  L1_SCHEMA_SUPPORTED_VERSION,
  listSystemEdges,
  openSystemStore,
  persistSystemEdges,
  replaceSystemEdges,
  systemStats,
} from "../src/system-store.mjs";
import { migrateComponentSchema } from "../../explorer-l0/src/schema-versions.mjs";
import { SystemStoreError } from "../src/errors.mjs";

const dir = mkdtempSync(join(tmpdir(), "l1-pk-"));

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sampleEdge(id, fromRepo, toRepo) {
  return {
    edge_id: id,
    from: {
      namespace: "acme",
      logical_repo: fromRepo,
      fact_id: `ff:out:${fromRepo}`,
    },
    to: {
      namespace: "acme",
      logical_repo: toRepo,
      fact_id: `ff:in:${toRepo}`,
    },
    contract_key: "GET /api/debits",
    method: "GET",
    path: "/api/debits",
    evidence_class: "contract-matched",
    match_kind: "config_binding",
    score: 0.95,
    config_key: "PROVIDERCONTROLLER_API_URL",
    evidence: [],
  };
}

describe("composite PK (system_namespace, edge_id)", () => {
  test("two namespaces owning the same edge_id both persist — nothing dropped", () => {
    const dbPath = join(dir, "two-ns.sqlite");
    const store = openSystemStore(dbPath);
    try {
      const e = sampleEdge("l1:edge:shared", "acme-tax", "tax-provider-controller");
      const a = persistSystemEdges(store, "acme-system", [e]);
      const b = persistSystemEdges(store, "demo-system", [e]);
      assert.equal(a.inserted, 1);
      assert.equal(b.inserted, 1, "second namespace must NOT be dropped");

      const acme = listSystemEdges(store, { system_namespace: "acme-system" });
      const demo = listSystemEdges(store, { system_namespace: "demo-system" });
      assert.equal(acme.length, 1);
      assert.equal(demo.length, 1);
      assert.equal(systemStats(store, "acme-system").edge_count, 1);
      assert.equal(systemStats(store, "demo-system").edge_count, 1);
    } finally {
      store.close();
    }
  });

  test("same-namespace re-persist stays idempotent", () => {
    const dbPath = join(dir, "idem.sqlite");
    const store = openSystemStore(dbPath);
    try {
      const e = sampleEdge("l1:edge:idem", "acme-tax", "tax-provider-controller");
      assert.equal(persistSystemEdges(store, "acme-system", [e]).inserted, 1);
      const again = persistSystemEdges(store, "acme-system", [e]);
      assert.equal(again.inserted, 0);
      assert.equal(again.skipped, 1);
      assert.equal(systemStats(store, "acme-system").edge_count, 1);
    } finally {
      store.close();
    }
  });
});

describe("v3 migration (composite PK) is lossless", () => {
  test("v2 store migrates keeping every row; cross-namespace inserts work after", () => {
    const dbPath = join(dir, "legacy-v2.sqlite");

    // Build a legacy v2 store by hand (v1 create + v2 id_version).
    const legacy = new DatabaseSync(dbPath);
    try {
      migrateComponentSchema({
        db: legacy,
        component: L1_COMPONENT,
        supportedVersion: 2,
        steps: L1_MIGRATION_STEPS.slice(0, 2),
        errorCtor: SystemStoreError,
      });
      legacy
        .prepare(
          `INSERT INTO l1_system_edges (
             edge_id, system_namespace,
             from_namespace, from_logical_repo, from_fact_id,
             to_namespace, to_logical_repo, to_fact_id,
             contract_key, method, path, evidence_class, match_kind, score,
             config_key, edge_json, created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          "l1:edge:legacy",
          "acme-system",
          "acme", "acme-tax", "ff:out:1",
          "acme", "tax-provider-controller", "ff:in:1",
          "GET /api/debits", "GET", "/api/debits",
          "contract-matched", "config_binding", 0.95,
          null, '{"edge_id":"l1:edge:legacy"}',
          "2026-08-01T00:00:00.000Z",
        );
    } finally {
      legacy.close();
    }

    // Opening through the store migrates v2 → v3.
    const store = openSystemStore(dbPath);
    try {
      const v = store._db
        .prepare(
          "SELECT version FROM explorer_schema_versions WHERE component = ?",
        )
        .get(L1_COMPONENT);
      assert.equal(v.version, L1_SCHEMA_SUPPORTED_VERSION);

      // Every legacy row survived.
      const listed = listSystemEdges(store, { system_namespace: "acme-system" });
      assert.equal(listed.length, 1);
      assert.equal(listed[0].edge_id, "l1:edge:legacy");

      // And the new PK accepts the same edge_id in another namespace.
      const e = sampleEdge("l1:edge:legacy", "acme-tax", "tax-provider-controller");
      const r = persistSystemEdges(store, "demo-system", [e]);
      assert.equal(r.inserted, 1);
    } finally {
      store.close();
    }
  });
});

describe("replaceSystemEdges (restitch wipe, scoped, atomic)", () => {
  test("restitch supersedes scope edges instead of accumulating", () => {
    const dbPath = join(dir, "restitch.sqlite");
    const store = openSystemStore(dbPath);
    try {
      const ns = "acme-system";
      replaceSystemEdges(
        store,
        ns,
        [sampleEdge("l1:edge:old", "acme-cron", "acme-tax")],
        ["acme-cron", "acme-tax"],
      );
      // Re-extraction produced a different edge_id for the same contract
      // (code moved a line): restitch must replace, not duplicate.
      const r = replaceSystemEdges(
        store,
        ns,
        [
          sampleEdge("l1:edge:new", "acme-cron", "acme-tax"),
          sampleEdge("l1:edge:new-2", "acme-cron", "acme-tax"),
        ],
        ["acme-cron", "acme-tax"],
      );
      assert.equal(r.removed, 1);
      assert.equal(r.inserted, 2);
      const listed = listSystemEdges(store, { system_namespace: ns });
      assert.equal(listed.length, 2, "old edge must be superseded");
      assert.ok(listed.every((e) => e.edge_id !== "l1:edge:old"));
    } finally {
      store.close();
    }
  });

  test("edges outside the run's scope and other namespaces survive", () => {
    const dbPath = join(dir, "scope.sqlite");
    const store = openSystemStore(dbPath);
    try {
      const ns = "acme-system";
      replaceSystemEdges(
        store,
        ns,
        [
          sampleEdge("l1:edge:ab", "acme-cron", "acme-tax"),
          sampleEdge("l1:edge:ac", "acme-cron", "cloud-portal"),
        ],
        ["acme-cron", "acme-tax", "cloud-portal"],
      );
      // Partial restitch: only repos cron+tax in scope.
      replaceSystemEdges(
        store,
        ns,
        [sampleEdge("l1:edge:ab-v2", "acme-cron", "acme-tax")],
        ["acme-cron", "acme-tax"],
      );
      const listed = listSystemEdges(store, { system_namespace: ns });
      assert.equal(listed.length, 2, "a->c edge must survive the scoped restitch");
      assert.ok(listed.some((e) => e.edge_id === "l1:edge:ac"));
      assert.ok(listed.some((e) => e.edge_id === "l1:edge:ab-v2"));

      // Another namespace is never touched by this namespace's restitch.
      replaceSystemEdges(store, "demo-system", [], ["acme-cron", "acme-tax"]);
      assert.equal(listSystemEdges(store, { system_namespace: ns }).length, 2);
      assert.equal(systemStats(store, "demo-system").edge_count, 0);
    } finally {
      store.close();
    }
  });

  test("failure mid-insert rolls back: wipe is never left half-applied", () => {
    const dbPath = join(dir, "atomic.sqlite");
    const store = openSystemStore(dbPath);
    try {
      const ns = "acme-system";
      replaceSystemEdges(
        store,
        ns,
        [sampleEdge("l1:edge:before", "acme-cron", "acme-tax")],
        ["acme-cron", "acme-tax"],
      );

      // Malformed edge (no from/to) throws mid-loop → tx must roll back,
      // leaving the pre-existing edge in place. Note: NOT NULL violations
      // don't work as injectors here — INSERT OR IGNORE swallows them.
      const bad = { edge_id: "l1:edge:bad" };
      assert.throws(
        () => replaceSystemEdges(store, ns, [bad], ["acme-cron", "acme-tax"]),
        SystemStoreError,
      );

      const listed = listSystemEdges(store, { system_namespace: ns });
      assert.equal(listed.length, 1, "pre-existing edge must survive the rollback");
      assert.equal(listed[0].edge_id, "l1:edge:before");
    } finally {
      store.close();
    }
  });
});
