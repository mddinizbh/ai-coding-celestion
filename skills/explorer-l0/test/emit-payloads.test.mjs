/**
 * Mechanical L0 encoder: closed payloads from Graphify facts, no LLM.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildNodeIndex,
  payloadForChunk,
  relationType,
} from "../src/emit-payloads.mjs";

const nA = {
  key: "n:alpha",
  kind: "node",
  graphify_id: "pkg.Alpha",
  label: "Alpha",
  source_file: "src/Alpha.java",
  source_location: "L1",
  origin: "ast",
};
const nB = {
  key: "n:beta",
  kind: "node",
  graphify_id: "ext.Beta",
  origin: "ast",
};
const eOk = {
  key: "e:edge1",
  kind: "edge",
  source_key: "n:alpha",
  target_key: "n:beta",
  source_graphify_id: "pkg.Alpha",
  target_graphify_id: "ext.Beta",
  relation: "imports",
};
const eSelf = {
  key: "e:self",
  kind: "edge",
  source_key: "n:alpha",
  target_key: "n:alpha",
  relation: "inherits",
};
const eOrphan = {
  key: "e:orphan",
  kind: "edge",
  source_key: "n:alpha",
  target_key: "n:missing",
  relation: "calls",
};

describe("payloadForChunk — mechanical encoder", () => {
  test("copies graphify_id as natural_key and Class vs ExternalSymbol from locator", () => {
    const index = buildNodeIndex([nA, nB]);
    const { payload, skipped_relations } = payloadForChunk("c:0000", [nA, nB, eOk], index);
    assert.equal(payload.chunk_key, "c:0000");
    assert.equal(payload.records.length, 2);
    assert.equal(payload.records[0].node_key, "n:alpha");
    assert.equal(payload.records[0].natural_key, "pkg.Alpha");
    assert.equal(payload.records[0].type, "Class");
    assert.deepEqual(payload.records[0].attributes, {});
    assert.equal(payload.records[1].type, "ExternalSymbol");
    assert.equal(payload.records[1].natural_key, "ext.Beta");
    assert.equal(skipped_relations, 0);
  });

  test("emits a relation when both endpoints exist in the run-wide index (even if target is another chunk)", () => {
    const index = buildNodeIndex([nA, nB]);
    const { payload } = payloadForChunk("c:0001", [eOk], index);
    assert.equal(payload.records.length, 0);
    assert.equal(payload.relations.length, 1);
    assert.equal(payload.relations[0].edge_key, "e:edge1");
    assert.equal(payload.relations[0].relation_type, "IMPORTS");
    assert.equal(payload.relations[0].from_type, "Class");
    assert.equal(payload.relations[0].from_natural_key, "pkg.Alpha");
    assert.equal(payload.relations[0].to_type, "ExternalSymbol");
    assert.equal(payload.relations[0].to_natural_key, "ext.Beta");
  });

  test("skips self-edges and edges whose target node is not in the index", () => {
    const index = buildNodeIndex([nA]);
    const { payload, skipped_relations } = payloadForChunk("c:0002", [nA, eSelf, eOrphan], index);
    assert.equal(payload.records.length, 1);
    assert.equal(payload.relations.length, 0);
    assert.equal(skipped_relations, 2);
  });

  test("relation_type is uppercase with non-alnum folded to underscore", () => {
    assert.equal(relationType({ relation: "imports" }), "IMPORTS");
    assert.equal(relationType({ relation: "rationale-for" }), "RATIONALE_FOR");
    assert.equal(relationType({}), "RELATED");
  });
});
