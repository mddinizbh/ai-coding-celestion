import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  listSystemEdges,
  openSystemStore,
  persistSystemEdges,
  systemStats,
} from "../src/system-store.mjs";

const dir = mkdtempSync(join(tmpdir(), "l1-store-"));
const dbPath = join(dir, "sys.sqlite");

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sampleEdge(id = "l1:edge1") {
  return {
    edge_id: id,
    from: {
      namespace: "acme",
      logical_repo: "acme-tax",
      fact_id: "ff:out:1",
    },
    to: {
      namespace: "acme",
      logical_repo: "tax-provider-controller",
      fact_id: "ff:in:1",
    },
    contract_key: "GET /api/debits/{param}/category/{param}/renavam/{param}",
    method: "GET",
    path: "/api/debits/{param}/category/{param}/renavam/{param}",
    evidence_class: "contract-matched",
    match_kind: "config_binding",
    score: 0.95,
    config_key: "PROVIDERCONTROLLER_API_URL",
    evidence: [],
  };
}

describe("system-store", () => {
  test("persist is idempotent by edge_id", () => {
    const store = openSystemStore(dbPath);
    try {
      const e = sampleEdge();
      const a = persistSystemEdges(store, "acme-system", [e]);
      assert.equal(a.inserted, 1);
      const b = persistSystemEdges(store, "acme-system", [e]);
      assert.equal(b.inserted, 0);
      assert.equal(b.skipped, 1);
      const listed = listSystemEdges(store, {
        system_namespace: "acme-system",
      });
      assert.equal(listed.length, 1);
      assert.equal(listed[0].evidence_class, "contract-matched");
      const stats = systemStats(store, "acme-system");
      assert.equal(stats.edge_count, 1);
    } finally {
      store.close();
    }
  });
});
