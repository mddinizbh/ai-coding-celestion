import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  exportFrontierFile,
  frontierFactsWithOrigins,
  frontierFromPackage,
} from "../src/frontier-export.mjs";

/**
 * Byte-compatibility golden for frontierFromPackage — captured AFTER ADR 0009
 * (id_version=2). Every FrontierFact id is `l0:ff:<kind>:<16-hex>` produced by
 * the shared `makeFrontierFactId` builder. If this string changes, the layered
 * identity contract is broken. Plan-locked (Task 8b).
 */
const FRONTIER_GOLDEN_JSON =
  '[{"namespace":"demo","logical_repo":"svc-a","source_revision":"abc","file":"C.java","line":10,"evidence_snippet":"list debits","kind":"http_inbound","method":"GET","path":"/api/debits/{param}","contract_key":"GET /api/debits/{param}","id":"l0:ff:http_inbound:884c98b97779e433"},{"namespace":"demo","logical_repo":"svc-a","source_revision":"abc","file":"Client.kt","line":3,"evidence_snippet":"calls B","kind":"http_outbound","method":"GET","path":"/api/debits/{param}","contract_key":"GET /api/debits/{param}","config_key":"B_URL","id":"l0:ff:http_outbound:5a2f0888a351eade"}]';

const dir = mkdtempSync(join(tmpdir(), "ff-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("frontierFromPackage", () => {
  test("maps Endpoint natural_key get:/api/x to inbound", () => {
    const facts = frontierFromPackage({
      namespace: "demo",
      logical_repo: "svc-a",
      source_revision: "abc",
      records: [
        {
          type: "Endpoint",
          natural_key: "get:/api/debits/{id}",
          name: "debits",
          summary: "list debits",
          attributes: { file: "C.java", line: 10 },
        },
        {
          type: "Endpoint",
          natural_key: "out",
          name: "client",
          summary: "calls B",
          attributes: {
            direction: "outbound",
            method: "GET",
            path: "/api/debits/{id}",
            config_key: "B_URL",
            file: "Client.kt",
            line: 3,
          },
        },
      ],
    });
    assert.equal(facts.length, 2);
    const inn = facts.find((f) => f.kind === "http_inbound");
    const out = facts.find((f) => f.kind === "http_outbound");
    assert.ok(inn);
    assert.ok(out);
    assert.equal(inn.contract_key, out.contract_key);
    assert.equal(out.config_key, "B_URL");
  });

  test("exportFrontierFile writes json", () => {
    const pkgPath = join(dir, "pkg.json");
    writeFileSync(
      pkgPath,
      JSON.stringify({
        namespace: "demo",
        logical_repo: "svc-a",
        source_revision: "abc",
        frontier: [
          {
            kind: "http_inbound",
            namespace: "demo",
            logical_repo: "svc-a",
            source_revision: "abc",
            method: "GET",
            path: "/ping",
            contract_key: "GET /ping",
            file: "x",
            line: 1,
            evidence_snippet: "ping",
            id: "ff:in:1",
          },
        ],
        records: [],
      }),
    );
    const r = exportFrontierFile(pkgPath, dir);
    assert.equal(r.fact_count, 1);
    const body = JSON.parse(readFileSync(r.output, "utf8"));
    assert.equal(body.facts[0].contract_key, "GET /ping");
  });

  test("frontierFromPackage byte-compat golden (additive change proof)", () => {
    const pkg = {
      namespace: "demo",
      logical_repo: "svc-a",
      source_revision: "abc",
      records: [
        {
          type: "Endpoint",
          natural_key: "get:/api/debits/{id}",
          name: "debits",
          summary: "list debits",
          attributes: { file: "C.java", line: 10 },
        },
        {
          type: "Endpoint",
          natural_key: "out",
          name: "client",
          summary: "calls B",
          attributes: {
            direction: "outbound",
            method: "GET",
            path: "/api/debits/{id}",
            config_key: "B_URL",
            file: "Client.kt",
            line: 3,
          },
        },
      ],
    };
    const json = JSON.stringify(frontierFromPackage(pkg));
    assert.equal(json, FRONTIER_GOLDEN_JSON);
  });
});

describe("frontierFactsWithOrigins", () => {
  test("one fact maps to one or more record IDs, canonically sorted", () => {
    // Two records with DIFFERENT natural_keys but same contract_key + file +
    // line → dedup to ONE fact. source_record_ids must list both, sorted by
    // raw code-unit compare (NOT localeCompare).
    const pkg = {
      namespace: "demo",
      logical_repo: "svc-b",
      source_revision: "def",
      records: [
        {
          type: "Endpoint",
          natural_key: "get:/api/items",
          name: "items-v1",
          summary: "items controller",
          attributes: { file: "A.java", line: 1 },
        },
        {
          type: "Endpoint",
          natural_key: "alt-items",
          name: "items-v2",
          summary: "items duplicate",
          attributes: { method: "GET", path: "/api/items", file: "A.java", line: 1 },
        },
      ],
    };
    const facts = frontierFromPackage(pkg);
    assert.equal(facts.length, 1, "both records dedup to one fact");

    const withOrigins = frontierFactsWithOrigins(pkg);
    assert.equal(withOrigins.length, 1);
    const { fact, source_record_ids } = withOrigins[0];
    assert.equal(fact.id, facts[0].id, "fact identity matches frontierFromPackage");
    assert.equal(source_record_ids.length, 2, "two source records");
    // Raw code-unit compare: "alt-items" (0x61) < "get:/api/items" (0x67).
    assert.deepEqual(source_record_ids, ["alt-items", "get:/api/items"]);
  });

  test("reuses recordToFact — fact payload identical to frontierFromPackage", () => {
    const pkg = {
      namespace: "demo",
      logical_repo: "svc-c",
      source_revision: "xyz",
      records: [
        {
          type: "Endpoint",
          natural_key: "post:/api/create",
          name: "create",
          summary: "create item",
          attributes: { file: "C.java", line: 42 },
        },
      ],
    };
    const [origin] = frontierFactsWithOrigins(pkg);
    const [classic] = frontierFromPackage(pkg);
    assert.deepEqual(origin.fact, classic);
    assert.deepEqual(origin.source_record_ids, ["post:/api/create"]);
  });

  test("builds Map<fact_id, record_id[]> shape for anchor resolution", () => {
    const pkg = {
      namespace: "demo",
      logical_repo: "svc-d",
      source_revision: "rev1",
      records: [
        {
          type: "Endpoint",
          natural_key: "get:/api/x",
          name: "x",
          attributes: { file: "X.java", line: 1 },
        },
        {
          type: "Endpoint",
          natural_key: "get:/api/y",
          name: "y",
          attributes: { file: "Y.java", line: 2 },
        },
      ],
    };
    const withOrigins = frontierFactsWithOrigins(pkg);
    const map = new Map(withOrigins.map((o) => [o.fact.id, o.source_record_ids]));
    assert.equal(map.size, 2);
    for (const ids of map.values()) {
      assert.ok(Array.isArray(ids) && ids.length >= 1);
    }
  });
});
