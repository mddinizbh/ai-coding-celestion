import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bindJourney } from "../src/journey-bind.mjs";

describe("bindJourney", () => {
  test("binds matching step and reports gap", () => {
    const edges = [
      {
        edge_id: "e1",
        from: { logical_repo: "a" },
        to: { logical_repo: "b" },
        contract_key: "GET /api/x",
        match_kind: "config_binding",
        score: 0.95,
      },
    ];
    const r = bindJourney(
      {
        id: "j1",
        system_namespace: "sys",
        members: ["a", "b"],
        steps: [
          {
            id: "s1",
            trigger: "http-sync",
            from: "a",
            to: "b",
            contract_prefix: "GET /api",
          },
          {
            id: "s2",
            trigger: "http-sync",
            from: "a",
            to: "b",
            contract_key: "POST /missing",
          },
        ],
        read_plan: [
          {
            id: "read:s1:caller",
            step_id: "s1",
            file: "Caller.kt",
            line: 10,
            status: "pending",
          },
        ],
      },
      edges,
    );
    assert.equal(r.steps_bound, 1);
    assert.equal(r.steps_gap, 1);
    assert.equal(r.status, "partial");
    assert.equal(r.structural_status, "partial");
    assert.equal(r.understanding_status, "code-read-required");
    assert.equal(r.code_reads_pending, 1);
  });

  test("reports confirmed understanding only when every read item is verified", () => {
    const r = bindJourney(
      {
        id: "j2",
        system_namespace: "sys",
        members: ["a", "b"],
        steps: [
          {
            id: "s1",
            trigger: "queue",
            from: "a",
            to: "b",
            contract_key: "TOPIC payment-approved",
          },
        ],
        read_plan: [
          {
            id: "read:s1:consumer",
            step_id: "s1",
            file: "Listener.kt",
            line: 20,
            status: "verified",
          },
        ],
      },
      [
        {
          edge_id: "topic-edge",
          from: { logical_repo: "a" },
          to: { logical_repo: "b" },
          contract_key: "TOPIC payment-approved",
          match_kind: "topic_contract",
          score: 0.9,
          trigger: "queue",
          interaction: "topic",
        },
      ],
    );

    assert.equal(r.structural_status, "complete");
    assert.equal(r.understanding_status, "confirmed");
    assert.equal(r.code_reads_pending, 0);
    assert.equal(r.bound[0].trigger, "queue");
  });

  test("changes journey hash when a required code read is verified", () => {
    const edge = {
      edge_id: "e1",
      from: { logical_repo: "a" },
      to: { logical_repo: "b" },
      contract_key: "GET /x",
      match_kind: "path_contract",
      score: 0.55,
    };
    const spec = {
      id: "j3",
      system_namespace: "sys",
      members: ["a", "b"],
      steps: [
        {
          id: "s1",
          trigger: "http-sync",
          from: "a",
          to: "b",
          contract_key: "GET /x",
        },
      ],
      read_plan: [
        {
          id: "read:s1:caller",
          step_id: "s1",
          file: "Caller.kt",
          line: 10,
          status: "pending",
        },
      ],
    };

    const pending = bindJourney(spec, [edge]);
    const verified = bindJourney(
      {
        ...spec,
        read_plan: spec.read_plan.map((item) => ({ ...item, status: "verified" })),
      },
      [edge],
    );

    assert.notEqual(pending.journey_hash, verified.journey_hash);
  });
});
