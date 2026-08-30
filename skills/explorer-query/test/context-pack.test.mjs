import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { buildContextPack } from "../src/context-pack.mjs";
import {
  bodyFromL1Pack,
  listProjections,
  writeHumanProjection,
} from "../src/generate-human.mjs";

const dir = mkdtempSync(join(tmpdir(), "eq-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("context-pack + human", () => {
  test("pack extracts code pointers from evidence", () => {
    const pack = buildContextPack({
      system_namespace: "sys",
      edges: [
        {
          edge_id: "e1",
          from: { logical_repo: "a" },
          to: { logical_repo: "b" },
          contract_key: "GET /x",
          match_kind: "path_contract",
          score: 0.55,
          evidence: [
            {
              side: "from",
              file: "A.kt",
              line: 2,
              snippet: "call",
              revision: "r",
            },
            {
              side: "to",
              file: "B.java",
              line: 9,
              snippet: "map",
              revision: "r",
            },
          ],
        },
      ],
    });
    assert.equal(pack.code_pointers.length, 2);
    const hum = writeHumanProjection({
      repo_root: dir,
      layer: "l1",
      meta: { system_namespace: "sys" },
      body_markdown: bodyFromL1Pack(pack),
    });
    assert.ok(hum.path.endsWith(".explorer/L1.md"));
    const list = listProjections(dir);
    assert.equal(list.projections.length, 1);
  });
});

// Baseline characterization for the LEGACY buildContextPack wrapper (opt-in
// rollout preserves this verbatim — Todo 14 adds projectContextPack alongside,
// never replacing this path). These pin the legacy output shape so the module
// adaptation cannot silently drift legacy callers (cli.mjs answer, e2e/run.mjs).
describe("buildContextPack (legacy wrapper) — baseline characterization", () => {
  test("legacy wrapper still carries generated_at (opt-in envelope, not the new canonical Pack)", () => {
    const pack = buildContextPack({
      system_namespace: "sys",
      edges: [],
    });
    assert.equal("generated_at" in pack, true);
    assert.equal(typeof pack.generated_at, "string");
    assert.ok(pack.generated_at.length > 0);
  });

  test("legacy wrapper preserves hops/code_pointers/projections shape", () => {
    const pack = buildContextPack({
      system_namespace: "sys",
      question: "q",
      edges: [
        {
          edge_id: "e1",
          from: { logical_repo: "a" },
          to: { logical_repo: "b" },
          contract_key: "GET /x",
          match_kind: "path_contract",
          score: 0.5,
          evidence: [{ side: "from", file: "A.kt", line: 2, snippet: "c", revision: "r" }],
        },
      ],
      projections: [{ layer: "l1", path: "/tmp/x" }],
    });
    assert.deepEqual(
      Object.keys(pack).sort(),
      [
        "code_pointers",
        "generated_at",
        "hop_count",
        "hops",
        "id_version",
        "journey_id",
        "journey_status",
        "pack_id",
        "projections",
        "question",
        "system_namespace",
        "version",
      ],
    );
    assert.equal(pack.pack_id.startsWith("pack:"), true);
    assert.equal(pack.id_version, 2);
    assert.equal(pack.hop_count, 1);
    assert.equal(pack.hops[0].edges.length, 1);
    assert.equal(pack.code_pointers.length, 1);
    assert.equal(pack.projections.length, 1);
  });

  test("legacy wrapper is deterministic in pack_id for identical input (clock-independent body)", () => {
    const input = {
      system_namespace: "sys",
      edges: [
        {
          edge_id: "e1",
          from: { logical_repo: "a" },
          to: { logical_repo: "b" },
          contract_key: "GET /x",
        },
      ],
    };
    const a = buildContextPack(input);
    const b = buildContextPack(input);
    assert.equal(a.pack_id, b.pack_id);
    // generated_at is a clock and MAY differ across calls — that is the legacy
    // envelope behavior the new canonical Pack removes.
    assert.deepEqual(a.hops, b.hops);
  });
});
