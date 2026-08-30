import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { bindJourney } from "../src/journey-bind.mjs";
import {
  journeysForEdge,
  listJourneys,
  openJourneyStore,
  persistJourneyBind,
  showJourney,
} from "../src/journey-store.mjs";

describe("journey-store", () => {
  test("persist bind + list + show + journeys-for-edge", () => {
    const dir = mkdtempSync(join(tmpdir(), "l2-store-"));
    const dbPath = join(dir, "t.sqlite");
    try {
      const store = openJourneyStore(dbPath);
      const edges = [
        {
          edge_id: "l1:edge-a",
          from: { logical_repo: "acme-tax" },
          to: { logical_repo: "tax-provider-controller" },
          contract_key: "GET /api/debits/x",
          match_kind: "config_binding",
          score: 0.95,
        },
      ];
      const spec = {
        id: "journey-consulta-debitos",
        system_namespace: "acme-system",
        members: ["acme-tax", "tax-provider-controller"],
        steps: [
          {
            id: "tax-tpc",
            trigger: "http-sync",
            from: "acme-tax",
            to: "tax-provider-controller",
            contract_prefix: "GET /api/debits",
          },
          {
            id: "missing",
            trigger: "internal",
            from: "acme-tax",
            to: "acme-tax",
          },
        ],
        read_plan: [
          {
            id: "read:tax-tpc:caller",
            step_id: "tax-tpc",
            file: "TaxProviderControllerClient.kt",
            line: 30,
            status: "pending",
          },
        ],
      };
      const bind = bindJourney(spec, edges);
      const persisted = persistJourneyBind(store, { spec, bind });
      assert.equal(persisted.bind_created, true);
      // ADR 0009: bind_id is l2:bind:<32-hex>; journey_id is l2:journey:<id>.
      assert.match(persisted.bind_id, /^l2:bind:[a-f0-9]{32}$/);
      assert.equal(persisted.journey_id, "l2:journey:journey-consulta-debitos");

      const listed = listJourneys(store, "acme-system");
      assert.equal(listed.length, 1);
      assert.equal(listed[0].journey_id, "l2:journey:journey-consulta-debitos");
      assert.equal(listed[0].steps_bound, 1);
      assert.equal(listed[0].steps_gap, 1);
      assert.equal(listed[0].structural_status, "partial");
      assert.equal(listed[0].understanding_status, "code-read-required");
      assert.equal(listed[0].code_reads_pending, 1);

      // showJourney accepts either the raw spec.id or the prefixed v2 form.
      const shown = showJourney(store, {
        system_namespace: "acme-system",
        journey_id: "journey-consulta-debitos",
      });
      assert.ok(shown);
      assert.equal(shown.journey_id, "l2:journey:journey-consulta-debitos");
      assert.equal(shown.spec.id, "journey-consulta-debitos");
      assert.equal(shown.bind.understanding_status, "code-read-required");
      assert.equal(shown.spec.read_plan.length, 1);
      assert.ok(shown.step_edges.some((s) => s.edge_id === "l1:edge-a"));

      const hits = journeysForEdge(store, {
        system_namespace: "acme-system",
        edge_id: "l1:edge-a",
      });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].step_id, "tax-tpc");
      assert.equal(hits[0].is_current, true);
      assert.equal(hits[0].understanding_status, "code-read-required");

      // idempotent re-persist
      const again = persistJourneyBind(store, { spec, bind });
      assert.equal(again.bind_created, false);
      assert.equal(listJourneys(store, "acme-system").length, 1);

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
