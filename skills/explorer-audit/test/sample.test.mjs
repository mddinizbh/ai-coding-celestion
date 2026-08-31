import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { persistSystemEdges, openSystemStore } from "../../explorer-l1/src/system-store.mjs";
import { main } from "../cli.mjs";
import { classifyPathMatch, sampleEdges } from "../src/sample.mjs";

function edge(id, pathMatch) {
  return {
    edge_id: id,
    path_match: pathMatch,
    score: pathMatch === "exact" ? 0.95 : 0.5,
    contract_key: pathMatch === "template" ? "GET /private/{param}" : "GET /crlv",
    method: "GET",
    path: pathMatch === "template" ? "/private/{param}" : "/crlv",
    evidence_class: "contract-matched",
    match_kind: "path_contract",
    from: { namespace: "ns", logical_repo: "tax", fact_id: "l0:ff:a" },
    to: { namespace: "ns", logical_repo: "crlv", fact_id: "l0:ff:b" },
    evidence: [{ side: "from", file: "A.kt", line: 10, revision: "abc1234", snippet: "get()" }],
  };
}

describe("sampleEdges", () => {
  test("classifies exact vs template vs other", () => {
    assert.equal(classifyPathMatch({ path_match: "exact" }), "exact");
    assert.equal(classifyPathMatch({ path_match: "template" }), "template");
    assert.equal(classifyPathMatch({}), "other");
  });

  test("stratifies and caps per class, stable by edge_id", () => {
    const edges = [
      edge("l1:edge:z", "exact"),
      edge("l1:edge:a", "template"),
      edge("l1:edge:m", "exact"),
      edge("l1:edge:b", "template"),
      edge("l1:edge:c", "template"),
      edge("l1:edge:t", "other"),
    ];
    const out = sampleEdges(edges, { perClass: 2 });
    assert.equal(out.counts.exact, 2);
    assert.equal(out.counts.template, 3);
    assert.equal(out.counts.other, 1);
    assert.equal(out.sample.exact.length, 2);
    assert.equal(out.sample.template.length, 2);
    assert.equal(out.sample.exact[0].edge_id, "l1:edge:m");
    assert.equal(out.sample.exact[1].edge_id, "l1:edge:z");
    assert.equal(out.sample.exact[0].evidence[0].snippet, undefined);
  });
});

describe("cli sample", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-sample-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("blocked when namespace has no L1 edges", () => {
    const db = join(dir, "empty.sqlite");
    openSystemStore(db).close();
    const chunks = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (c) => {
      chunks.push(String(c));
      return true;
    };
    try {
      const code = main(["sample", "--namespace", "ns", "--db", db]);
      assert.equal(code, 2);
      const body = JSON.parse(chunks.join(""));
      assert.equal(body.code, "no_l1_edges");
    } finally {
      process.stdout.write = orig;
    }
  });

  test("samples persisted exact and template", () => {
    const db = join(dir, "full.sqlite");
    const store = openSystemStore(db);
    persistSystemEdges(store, "ns", [edge("l1:edge:aa", "exact"), edge("l1:edge:bb", "template")]);
    store.close();
    const chunks = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (c) => {
      chunks.push(String(c));
      return true;
    };
    try {
      const code = main(["sample", "--namespace", "ns", "--db", db, "--per-class", "5"]);
      assert.equal(code, 0);
      const body = JSON.parse(chunks.join(""));
      assert.equal(body.status, "ok");
      assert.equal(body.counts.exact, 1);
      assert.equal(body.counts.template, 1);
      assert.equal(body.sample.exact[0].path, "/crlv");
    } finally {
      process.stdout.write = orig;
    }
  });
});
