import assert from "node:assert/strict";
import { test } from "node:test";
import { makeObservationId, canonicalizeSignal, makeGapKey } from "../src/canonical-observation.mjs";

test("canonicalizeSignal produces target_signature via stableStringify of signal_key", () => {
  const input = {capability: "java-call", fields: {class: "C", method: "m", params: "String"}};
  const out = canonicalizeSignal(input);
  assert.equal(out.target_signature, '{"capability":"java-call","fields":{"class":"C","method":"m","params":"String"}}');
  assert.equal(out.signal_key.capability, "java-call");
  assert.equal(out.complete, true);
});

test("canonicalizeSignal rejects unknown, missing and extra fields", () => {
  assert.throws(() => canonicalizeSignal({capability: "unknown", fields: {name: "x"}}), /unknown capability/);
  assert.throws(() => canonicalizeSignal({capability: "kafka", fields: {topic: "orders", direction: "publish"}}), /expected fields/);
  assert.throws(() => canonicalizeSignal({capability: "kafka", fields: {topic: "orders", direction: "publish", client: "bus", extra: "x"}}), /expected fields/);
});

test("canonicalizeSignal preserves an incomplete known signal for UNKNOWN classification", () => {
  const out = canonicalizeSignal({capability: "kafka", fields: {topic: "orders", direction: "publish", client: ""}});
  assert.equal(out.complete, false);
});

test("makeObservationId excludes revision and line from identity by destructuring only declared fields", () => {
  const base = {capability: "java-call", target_signature: '{"class":"C","method":"m"}', source_evidence_identity: {logical_repo: "r", relative_file: "f.java", source_anchor: "C.m"}};
  const id1 = makeObservationId(Object.assign({}, base, {source_revision: "abc", line: 42}));
  const id2 = makeObservationId(Object.assign({}, base, {source_revision: "def", line: 99}));
  assert.equal(id1, id2);
});

test("makeObservationId produces exact deterministic SHA-256 for representative payload", () => {
  const input = {capability: "java-call", target_signature: '{"class":"C","method":"m"}', source_evidence_identity: {logical_repo: "r", relative_file: "f.java", source_anchor: "C.m"}};
  const id = makeObservationId(input);
  assert.equal(id, "6f6552bee9267f8d94a3dc3b41a2b043c9cd2ec06d32c08c686d407a1c6ebe22");
});

test("makeGapKey is deterministic hash of reason+scope+capability+target_signature", () => {
  const scope = {namespace: "ns", logical_repos: ["checkout"]};
  const k1 = makeGapKey({reason: "missing-frontier-fact", scope, capability: "kafka", target_signature: '{"topic":"t"}'});
  const k2 = makeGapKey({reason: "missing-frontier-fact", scope, capability: "kafka", target_signature: '{"topic":"t"}'});
  assert.equal(k1, k2);
});

test("makeGapKey produces exact deterministic SHA-256 for representative payload", () => {
  const scope = {namespace: "ns", logical_repos: ["checkout"]};
  const k = makeGapKey({reason: "missing-frontier-fact", scope, capability: "kafka", target_signature: '{"topic":"t"}'});
  assert.equal(k, "de939e6820e8fa405b94345f761e44c21a984e7ac62d38dbf69eff29452c4f02");
});
