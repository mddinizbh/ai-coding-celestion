import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { enrichFromL0 } from "../src/enrich-from-l0.mjs";
import { proposeFromL1 } from "../src/propose-from-l1.mjs";
import { synthesizeJourney } from "../src/synthesize.mjs";

const edges = [
  {
    edge_id: "l1:tpc",
    from: { logical_repo: "acme-tax", namespace: "acme", fact_id: "a" },
    to: {
      logical_repo: "tax-provider-controller",
      namespace: "acme",
      fact_id: "b",
    },
    contract_key: "GET /api/debits/{param}/category/{param}/renavam/{param}",
    method: "GET",
    path: "/api/debits/{param}/category/{param}/renavam/{param}",
    match_kind: "config_binding",
    score: 0.95,
    config_key: "PROVIDERCONTROLLER_API_URL",
    trigger: "cron",
    interaction: "http",
    schedule: "*/5 * * * *",
    evidence: [
      {
        side: "from",
        file: "src/main/kotlin/com/acme/tax/provider/TaxProviderControllerClient.kt",
        line: 30,
        snippet: "retrieve",
      },
      {
        side: "to",
        file: "src/main/java/br/com/acme/taxprovidercontroller/controller/DebitsController.java",
        line: 28,
        snippet: "fetchDebits",
      },
    ],
  },
  {
    edge_id: "l1:weak",
    from: { logical_repo: "tax-provider-alt", namespace: "acme", fact_id: "c" },
    to: { logical_repo: "acme-tax", namespace: "acme", fact_id: "d" },
    contract_key: "GET /private/celcoin/balance",
    method: "GET",
    path: "/private/celcoin/balance",
    match_kind: "path_contract",
    score: 0.55,
    evidence: [],
  },
];

describe("propose-from-l1", () => {
  test("builds steps only from L1 edges, no domain claims", () => {
    const { spec, stats } = proposeFromL1(edges, {
      system_namespace: "acme-system",
      from_repo: "acme-tax",
      to_repo: "tax-provider-controller",
      min_score: 0.9,
      journey_id: "journey-test-tpc",
    });
    assert.equal(stats.filtered_edges, 1);
    assert.equal(spec.steps.length, 1);
    assert.equal(spec.steps[0].from, "acme-tax");
    assert.equal(spec.steps[0].to, "tax-provider-controller");
    assert.equal(spec.steps[0].provenance.source, "l1");
    assert.equal(spec.steps[0].trigger, "cron");
    assert.ok(spec.title?.includes("tax") || spec.title?.includes("tpc"));
    assert.ok(spec.id.startsWith("integration-") || spec.id === "journey-test-tpc");
    assert.ok(spec.steps[0].description.includes("HTTP"));
    assert.ok(spec.steps[0].id.includes("to-"));
    assert.ok(!/RENDIMENTO|default partner/i.test(JSON.stringify(spec)));
    // no robotic pipeline dump as the only description
    assert.ok(!/^Auto-proposed from L1/i.test(spec.description));
  });

  test("emits a code read plan with edge evidence, hotspots, and internal continuity", () => {
    const { spec: draft } = proposeFromL1(edges, {
      system_namespace: "acme-system",
      from_repo: "acme-tax",
      to_repo: "tax-provider-controller",
      min_score: 0.9,
    });
    const packages = {
      "acme-tax": {
        records: [
          {
            id: "method:retrieve",
            type: "Method",
            name: "retrieveDebits()",
            summary: "Method retrieveDebits() at L30",
            status: "comprovado",
            attributes: {
              source_file:
                "src/main/kotlin/com/acme/tax/provider/TaxProviderControllerClient.kt",
              line: 30,
            },
          },
          {
            id: "method:submit",
            type: "Method",
            name: "verifyAndSubmit()",
            summary: "Method verifyAndSubmit() at L53",
            status: "comprovado",
            attributes: {
              source_file:
                "src/main/kotlin/com/acme/tax/service/IpvaSubmitService.kt",
              line: 53,
            },
          },
        ],
        relations: [
          {
            id: "calls:retrieve-submit",
            relation_type: "CALLS",
            from_record: "method:retrieve",
            to_record: "method:submit",
            evidence: [],
          },
        ],
      },
      "tax-provider-controller": {
        records: [
          {
            id: "method:fetch",
            type: "Method",
            name: "fetchDebits()",
            summary: "Method fetchDebits() at L28",
            status: "comprovado",
            attributes: {
              source_file:
                "src/main/java/br/com/acme/taxprovidercontroller/controller/DebitsController.java",
              line: 28,
            },
          },
        ],
        relations: [],
      },
    };

    const { spec } = enrichFromL0(draft, { packages_by_repo: packages });
    assert.ok(Array.isArray(spec.read_plan));
    assert.ok(
      spec.read_plan.some(
        (item) =>
          item.reason === "edge_endpoint" &&
          item.file.endsWith("TaxProviderControllerClient.kt") &&
          item.line === 30,
      ),
    );
    assert.ok(
      spec.read_plan.some(
        (item) =>
          item.trigger === "internal" &&
          item.symbol === "verifyAndSubmit()" &&
          item.relation_type === "CALLS",
      ),
    );
    assert.ok(spec.read_plan.every((item) => item.status === "pending"));
    assert.equal(spec.pipeline.code_read_required, true);
  });
});

describe("enrich-from-l0", () => {
  test("anchors methods on evidence files and flags hotspots", () => {
    const { spec: draft } = proposeFromL1(edges, {
      system_namespace: "acme-system",
      from_repo: "acme-tax",
      to_repo: "tax-provider-controller",
      min_score: 0.9,
    });
    const packages = {
      "acme-tax": {
        records: [
          {
            id: "method:1",
            type: "Method",
            name: "retrieveDebits()",
            summary: "Method retrieveDebits() at L30",
            status: "comprovado",
            attributes: {
              source_file:
                "src/main/kotlin/com/acme/tax/provider/TaxProviderControllerClient.kt",
            },
          },
          {
            id: "method:2",
            type: "Method",
            name: "choosePartner()",
            summary: "Method choosePartner() at L12",
            status: "comprovado",
            attributes: {
              source_file:
                "src/main/kotlin/com/acme/tax/helper/PartnerHelper.kt",
            },
          },
        ],
      },
      "tax-provider-controller": {
        records: [
          {
            id: "method:3",
            type: "Method",
            name: "fetchDebits()",
            summary: "Method fetchDebits() at L28",
            status: "comprovado",
            attributes: {
              source_file:
                "src/main/java/br/com/acme/taxprovidercontroller/controller/DebitsController.java",
            },
          },
        ],
      },
    };
    const { spec, warnings, stats } = enrichFromL0(draft, {
      packages_by_repo: packages,
    });
    assert.ok(stats.steps_with_anchors >= 1);
    const step = spec.steps[0];
    assert.ok((step.provenance.l0_anchors || []).length >= 1);
    assert.ok(
      (step.provenance.l0_anchors || []).some((a) => a.name.includes("retrieveDebits")),
    );
    assert.ok(
      (step.provenance.l0_anchors || []).some((a) => a.name.includes("fetchDebits")),
    );
    // choosePartner is hotspot in same provider dir tree may or may not attach;
    // body_read_required should fire if hotspot present
    assert.equal(spec.pipeline.stage, "enrich-from-l0");
    assert.ok(
      (spec.enrichment.claims_blocked_until_body_read || []).length >= 1,
    );
    assert.ok(Array.isArray(warnings));
  });
});

describe("synthesize", () => {
  test("runs full pipeline and binds L1 steps", () => {
    const packages = {
      "acme-tax": {
        records: [
          {
            type: "Method",
            name: "retrieveDebits()",
            summary: "x",
            attributes: {
              source_file:
                "src/main/kotlin/com/acme/tax/provider/TaxProviderControllerClient.kt",
            },
          },
        ],
      },
      "tax-provider-controller": {
        records: [
          {
            type: "Method",
            name: "fetchDebits()",
            summary: "y",
            attributes: {
              source_file:
                "src/main/java/br/com/acme/taxprovidercontroller/controller/DebitsController.java",
            },
          },
        ],
      },
    };
    const result = synthesizeJourney({
      edges,
      system_namespace: "acme-system",
      journey_id: "journey-synth-tpc",
      from_repo: "acme-tax",
      to_repo: "tax-provider-controller",
      min_score: 0.9,
      packages_by_repo: packages,
    });
    assert.equal(result.bind.steps_bound, 1);
    assert.equal(result.bind.steps_gap, 0);
    assert.equal(result.bind.status, "complete");
    assert.equal(result.bind.structural_status, "complete");
    assert.equal(result.bind.understanding_status, "code-read-required");
    assert.ok(result.read_plan.length > 0);
    assert.equal(result.bind.bound[0].trigger, "cron");
    assert.ok(result.pipeline.includes("propose-from-l1"));
  });
});
