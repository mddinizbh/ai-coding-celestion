import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { canonicalGraphHash, createGraphIndex } from "../src/graph-hash.mjs";
import { NS, REV, SHA_A, artifactEvidence, sourceEngine } from "./fixtures.mjs";

const RECORD = {
  id: "l0:service:billing",
  namespace: NS,
  type: "Service",
  name: "Billing",
  summary: "Narrative must not affect identity.",
  attributes: { z: 2, a: 1 },
  status: "hipótese",
  source_revision: REV,
  source_engine: sourceEngine(),
  evidence: [artifactEvidence()],
};

describe("canonicalGraphHash", () => {
  test("is independent of discovery order and object key order", () => {
    const second = { ...RECORD, id: "l0:service:orders", name: "Orders" };
    const forward = canonicalGraphHash({ records: [RECORD, second], relations: [] });
    const reversed = canonicalGraphHash({ records: [second, RECORD], relations: [] });
    assert.equal(forward, reversed);
    assert.match(forward, /^[a-f0-9]{64}$/);
  });

  test("excludes summary from the hash payload", () => {
    const a = canonicalGraphHash({ records: [RECORD], relations: [] });
    const b = canonicalGraphHash({
      records: [{ ...RECORD, summary: "totally different narrative" }],
      relations: [],
    });
    assert.equal(a, b);
  });
});

describe("createGraphIndex", () => {
  test("sorts ids and sets counts + hash", () => {
    const second = { ...RECORD, id: "l0:service:orders", name: "Orders" };
    const index = createGraphIndex({
      namespace: NS,
      sourceRevision: REV,
      artifactManifestId: "manifest:x",
      engine: { name: "graphify", profile: "default" },
      graph: { records: [second, RECORD], relations: [] },
    });
    assert.deepEqual(index.record_ids, ["l0:service:billing", "l0:service:orders"]);
    assert.equal(index.counts.records, 2);
    assert.equal(index.canonical_graph_hash, SHA_A.length === 64
      ? canonicalGraphHash({ records: [RECORD, second], relations: [] })
      : index.canonical_graph_hash);
    assert.match(index.id, /^graph-index:[a-f0-9]{64}$/);
  });
});
