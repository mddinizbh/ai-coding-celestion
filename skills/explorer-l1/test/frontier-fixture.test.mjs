import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dedupeFrontier } from "../src/frontier-extract.mjs";
import { matchFrontiers } from "../src/matcher.mjs";
import { contractKey } from "../src/path-normalize.mjs";
import { makeFrontierFactId } from "../../explorer-l0/src/layered-id.mjs";

/**
 * Synthetic Acme-shaped facts (no real monorepo in unit CI).
 * As of ADR 0009 every fact id is built by the shared `makeFrontierFactId`.
 */
describe("frontier fixture Acme-shaped", () => {
  test("acme-tax outbound + controller inbound match on debits contract", () => {
    const ck = contractKey(
      "GET",
      "/api/debits/{state}/category/{category}/renavam/{renavam}",
    );
    const acmeOutId = makeFrontierFactId({
      kind: "http_outbound",
      namespace: "acme",
      logical_repo: "acme-tax",
      source_revision: "abc",
      identity_key: ck,
      file: "TaxProviderControllerClient.kt",
      line: 30,
    });
    const ctlInId = makeFrontierFactId({
      kind: "http_inbound",
      namespace: "acme",
      logical_repo: "tax-provider-controller",
      source_revision: "def",
      identity_key: ck,
      file: "DebitsController.java",
      line: 28,
    });
    const acme = dedupeFrontier([
      {
        kind: "http_outbound",
        namespace: "acme",
        logical_repo: "acme-tax",
        source_revision: "abc",
        method: "GET",
        path: "/api/debits/{param}/category/{param}/renavam/{param}",
        contract_key: ck,
        config_key: "PROVIDERCONTROLLER_API_URL",
        file: "TaxProviderControllerClient.kt",
        line: 30,
        evidence_snippet: 'val url = "$taxProviderControllerURL/api/debits/..."',
        id: acmeOutId,
      },
    ]);
    const ctl = dedupeFrontier([
      {
        kind: "http_inbound",
        namespace: "acme",
        logical_repo: "tax-provider-controller",
        source_revision: "def",
        method: "GET",
        path: "/api/debits/{param}/category/{param}/renavam/{param}",
        contract_key: ck,
        file: "DebitsController.java",
        line: 28,
        evidence_snippet:
          '@GetMapping("/{state}/category/{category}/renavam/{renavam}")',
        id: ctlInId,
      },
    ]);
    assert.equal(acme.length, 1);
    assert.equal(ctl.length, 1);
    const edges = matchFrontiers(acme, ctl);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].match_kind, "config_binding");
    assert.match(edges[0].contract_key, /debits/);
    // ADR 0009: edge_id is l1:edge:<32-hex>; endpoints reference l0:ff:*.
    assert.match(edges[0].edge_id, /^l1:edge:[a-f0-9]{32}$/);
    assert.match(edges[0].from.fact_id, /^l0:ff:http_outbound:[a-f0-9]{16}$/);
    assert.match(edges[0].to.fact_id, /^l0:ff:http_inbound:[a-f0-9]{16}$/);
  });
});
