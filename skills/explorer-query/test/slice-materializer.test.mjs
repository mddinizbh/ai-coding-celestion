import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { materializeSlice } from "../src/slice-materializer.mjs";
import { openSliceStore } from "../src/slice-store.mjs";
import { SliceMaterializationError, exitCodeForError } from "../src/slice-errors.mjs";
import { frontierFactsWithOrigins } from "../../explorer-l0/src/frontier-export.mjs";

/**
 * Build a valid L0 accepted package whose `records` produce a REAL frontier
 * fact (Map<fact_id, record_id[]>) via `frontierFactsWithOrigins`. An endpoint
 * record is used because `recordToFact` recognizes type:"endpoint" and emits a
 * deterministic `l0:ff:http_inbound:<16-hex>` fact id.
 *
 * `graphHash` controls `graph_index.canonical_graph_hash` — a policy-relevant
 * baseline field that enters the derivation key and canonical payload.
 */
function makeValidL0Package({ sourceRevision = "r1", graphHash } = {}) {
  const pkg = {
    namespace: "test",
    logical_repo: "r1",
    source_revision: sourceRevision,
    records: [
      {
        type: "endpoint",
        name: "getUser",
        natural_key: "get:/api/users",
        attributes: { method: "GET", path: "/api/users", file: "src/users.js", line: 5 },
      },
    ],
  };
  if (graphHash !== undefined) pkg.graph_index = { canonical_graph_hash: graphHash };
  return pkg;
}

/**
 * Hermetic store bundle: real `openSliceStore(':memory:')` Slice store +
 * in-memory fake L0/L1/L2 stores. The seed's `fact_id` is derived from the
 * REAL frontier fact so the anchor resolver produces a non-empty
 * Map<fact_id, record_id[]> lookup (not a synthetic id that never resolves).
 */
function makeHermeticStores(pkgOverride) {
  const pkg = pkgOverride || makeValidL0Package();
  const origins = frontierFactsWithOrigins(pkg);
  if (origins.length === 0) {
    throw new Error("fixture package produced no frontier facts — records must yield a frontier fact");
  }
  const factId = origins[0].fact.id;
  const l0Store = {
    getAcceptedBaseline: () => ({ candidate_id: "c1" }),
    getAcceptedPackage: () => pkg,
  };
  const l1Store = { listSystemEdges: () => [] };
  const l2Store = { listJourneys: () => [], showJourney: () => null };
  const store = openSliceStore(":memory:");
  return { l0Store, l1Store, l2Store, store, cleanup: () => { store.close(); }, factId };
}

function seedRequest(factId, policyName = "journey", extra = {}) {
  return {
    systemNamespace: "test",
    policy: { name: policyName, version: 1 },
    seeds: [{ kind: "l0_fact", namespace: "test", logical_repo: "r1", fact_id: factId }],
    ...extra,
  };
}

describe("slice-materializer (real store contract + valid fixtures)", () => {
  it("first call returns materialized, second identical call returns cache_hit with byte-identical slice and same hash", async () => {
    const { l0Store, l1Store, l2Store, store, cleanup, factId } = makeHermeticStores();
    try {
      const req = seedRequest(factId);
      const r1 = await materializeSlice({ request: req, l0Store, l1Store, l2Store, store });
      assert.equal(r1.status, "materialized");
      const r2 = await materializeSlice({ request: req, l0Store, l1Store, l2Store, store });
      assert.equal(r2.status, "cache_hit");
      assert.equal(r2.sliceHash, r1.sliceHash);
      // Byte-identical canonical payload: DB read-back (r1) === fresh canonical (r2).
      assert.deepEqual(r2.slice, r1.slice);
    } finally {
      cleanup();
    }
  });

  it("changing policy-relevant baseline hash produces miss + new slice", async () => {
    const pkg1 = makeValidL0Package();
    const { l0Store, l1Store, l2Store, store, cleanup, factId } = makeHermeticStores(pkg1);
    try {
      const req = seedRequest(factId);
      const r1 = await materializeSlice({ request: req, l0Store, l1Store, l2Store, store });
      assert.equal(r1.status, "materialized");
      // Swap accepted package: same frontier facts (same source_revision) but a
      // different canonical_graph_hash — a policy-relevant baseline change that
      // must invalidate the cache and produce a distinct slice_hash.
      l0Store.getAcceptedPackage = () => makeValidL0Package({ graphHash: "h2-different" });
      const r2 = await materializeSlice({ request: req, l0Store, l1Store, l2Store, store });
      assert.equal(r2.status, "materialized");
      assert.notEqual(r2.sliceHash, r1.sliceHash);
    } finally {
      cleanup();
    }
  });

  it("ceiling failure throws SliceMaterializationError (exit 2), zero rows, zero current change", async () => {
    const { l0Store, l1Store, l2Store, store, cleanup, factId } = makeHermeticStores();
    try {
      // maxNodes=0 is below the 1-node fixture: a real safety ceiling before persist.
      const req = seedRequest(factId, "journey", { limits: { maxNodes: 0, maxEdges: 0 } });
      const rowsBefore = store._db.prepare("SELECT COUNT(*) AS c FROM context_slices").get().c;
      assert.equal(rowsBefore, 0);
      const currentBefore = store._db.prepare("SELECT COUNT(*) AS c FROM context_slice_current").get().c;
      assert.equal(currentBefore, 0);

      let caught = null;
      try {
        await materializeSlice({ request: req, l0Store, l1Store, l2Store, store });
      } catch (e) {
        caught = e;
      }
      assert.ok(
        caught instanceof SliceMaterializationError,
        `expected SliceMaterializationError, got ${caught && caught.name}`,
      );
      assert.equal(caught.code, "CEILING_EXCEEDED");
      assert.equal(exitCodeForError(caught), 2);

      const rowsAfter = store._db.prepare("SELECT COUNT(*) AS c FROM context_slices").get().c;
      assert.equal(rowsAfter, 0);
      const currentAfter = store._db.prepare("SELECT COUNT(*) AS c FROM context_slice_current").get().c;
      assert.equal(currentAfter, 0);
    } finally {
      cleanup();
    }
  });

  it("sequential duplicate calls converge: first materialized, rest cache_hit, same hash", async () => {
    const { l0Store, l1Store, l2Store, store, cleanup, factId } = makeHermeticStores();
    try {
      const req = seedRequest(factId, "impact");
      const results = [];
      for (let i = 0; i < 3; i++) {
        results.push(await materializeSlice({ request: req, l0Store, l1Store, l2Store, store }));
      }
      assert.equal(results[0].status, "materialized");
      assert.equal(results[1].status, "cache_hit");
      assert.equal(results[2].status, "cache_hit");
      assert.equal(results[0].sliceHash, results[1].sliceHash);
      assert.equal(results[1].sliceHash, results[2].sliceHash);
    } finally {
      cleanup();
    }
  });
});
