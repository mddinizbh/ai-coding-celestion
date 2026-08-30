import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { matchFrontiers } from "../src/matcher.mjs";
import { contractKey } from "../src/path-normalize.mjs";
import { makeFrontierFactId } from "../../explorer-l0/src/layered-id.mjs";

function fact(partial) {
  // Default v2 FrontierFact id derived from canonical identity inputs.
  const defaultId = makeFrontierFactId({
    kind: partial.kind || "http_inbound",
    namespace: partial.namespace || "acme",
    logical_repo: partial.logical_repo || "acme-tax",
    source_revision: partial.source_revision || "abc",
    identity_key: partial.contract_key || "GET /x",
    file: partial.file || "x.kt",
    line: partial.line || 1,
  });
  return {
    namespace: "acme",
    source_revision: "abc",
    file: "x.kt",
    line: 1,
    evidence_snippet: "snip",
    id: defaultId,
    ...partial,
  };
}

describe("matchFrontiers", () => {
  test("config binding scores higher than path-only", () => {
    const ck = contractKey(
      "GET",
      "/api/debits/{state}/category/{category}/renavam/{renavam}",
    );
    // Use distinct logical_repos so the canonical ff ids differ. id is derived
    // by fact() from canonical identity inputs; explicit id overrides removed.
    const from = [
      fact({
        kind: "http_outbound",
        logical_repo: "acme-tax",
        method: "GET",
        path: "/api/debits/{param}/category/{param}/renavam/{param}",
        contract_key: ck,
        config_key: "PROVIDERCONTROLLER_API_URL",
      }),
    ];
    const to = [
      fact({
        kind: "http_inbound",
        logical_repo: "tax-provider-controller",
        method: "GET",
        path: "/api/debits/{param}/category/{param}/renavam/{param}",
        contract_key: ck,
      }),
    ];
    const edges = matchFrontiers(from, to);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].match_kind, "config_binding");
    assert.ok(edges[0].score >= 0.9);
    assert.equal(edges[0].evidence_class, "contract-matched");
    // ADR 0009: edge_id is l1:edge:<32-hex>; endpoints reference l0:ff:*.
    assert.match(edges[0].edge_id, /^l1:edge:[a-f0-9]{32}$/);
    assert.match(edges[0].from.fact_id, /^l0:ff:http_outbound:[a-f0-9]{16}$/);
    assert.match(edges[0].to.fact_id, /^l0:ff:http_inbound:[a-f0-9]{16}$/);
  });

  test("skips when config maps to a different target repo", () => {
    const ck = contractKey("GET", "/private/debits/{a}/{b}/pay");
    const from = [
      fact({
        kind: "http_outbound",
        logical_repo: "acme-tax",
        method: "GET",
        path: "/private/debits/{param}/{param}/pay",
        contract_key: ck,
        config_key: "TAX_PROVIDER_ALT_URL",
      }),
    ];
    const to = [
      fact({
        kind: "http_inbound",
        logical_repo: "tax-provider-controller",
        method: "GET",
        path: "/private/debits/{param}/{param}/pay",
        contract_key: ck,
      }),
    ];
    const edges = matchFrontiers(from, to);
    assert.equal(edges.length, 0);
  });
});
