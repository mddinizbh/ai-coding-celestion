#!/usr/bin/env node
/**
 * Hermetic e2e: frontiers → ensure stitch → answer pack → generate-human → list
 * No network, no IdeaProjects.
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stitchL1 } from "../../explorer-l1/src/stitch.mjs";
import { bindJourney } from "../../explorer-l2/src/journey-bind.mjs";
import { buildContextPack } from "../src/context-pack.mjs";
import {
  bodyFromL1Pack,
  listProjections,
  writeHumanProjection,
} from "../src/generate-human.mjs";
import { makeFrontierFactId } from "../../explorer-l0/src/layered-id.mjs";

const root = join(tmpdir(), `explorer-e2e-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const frontierDir = join(root, "frontiers");
mkdirSync(frontierDir);

// svc-a outbound + svc-b inbound same contract + config (ADR 0009 v2 ids).
const ck = "GET /api/debits/{param}";
const fact = (partial) => ({
  namespace: "demo",
  source_revision: "fix",
  file: "X.kt",
  line: 1,
  evidence_snippet: "demo",
  ...partial,
});
const outId = makeFrontierFactId({
  kind: "http_outbound",
  namespace: "demo",
  logical_repo: "svc-a",
  source_revision: "fix",
  identity_key: ck,
  file: "X.kt",
  line: 1,
});
const inId = makeFrontierFactId({
  kind: "http_inbound",
  namespace: "demo",
  logical_repo: "svc-b",
  source_revision: "fix",
  identity_key: ck,
  file: "X.kt",
  line: 1,
});

writeFileSync(
  join(frontierDir, "svc-a.frontier.json"),
  JSON.stringify({
    logical_repo: "svc-a",
    namespace: "demo",
    facts: [
      fact({
        id: outId,
        kind: "http_outbound",
        logical_repo: "svc-a",
        method: "GET",
        path: "/api/debits/{param}",
        contract_key: ck,
        config_key: "B_URL",
      }),
    ],
  }),
);
writeFileSync(
  join(frontierDir, "svc-b.frontier.json"),
  JSON.stringify({
    logical_repo: "svc-b",
    namespace: "demo",
    facts: [
      fact({
        id: inId,
        kind: "http_inbound",
        logical_repo: "svc-b",
        method: "GET",
        path: "/api/debits/{param}",
        contract_key: ck,
      }),
    ],
  }),
);

const stitched = stitchL1({
  namespace: "demo",
  system_namespace: "demo-system",
  system_db: join(root, "sys.sqlite"),
  repos: [{ logical_repo: "svc-a" }, { logical_repo: "svc-b" }],
  frontier_dir: frontierDir,
  skip_baseline_check: true,
  config_target_repo: { B_URL: "svc-b" },
  pairs: [{ from: "svc-a", to: "svc-b" }],
});

if (stitched.edge_count < 1) {
  console.error("FAIL: expected ≥1 edge", stitched);
  process.exit(1);
}
if (stitched.edges[0].match_kind !== "config_binding") {
  console.error("FAIL: expected config_binding", stitched.edges[0]);
  process.exit(1);
}

const journey = bindJourney(
  {
    id: "consulta-debitos",
    system_namespace: "demo-system",
    members: ["svc-a", "svc-b"],
    steps: [
      {
        id: "consult",
        trigger: "http-sync",
        from: "svc-a",
        to: "svc-b",
        contract_prefix: "GET /api/debits",
      },
      {
        id: "pay",
        trigger: "http-sync",
        from: "svc-a",
        to: "svc-b",
        contract_key: "POST /api/pay",
      },
    ],
  },
  stitched.edges,
);

if (journey.steps_bound !== 1 || journey.steps_gap !== 1) {
  console.error("FAIL: journey bind expected 1 bound + 1 gap", journey);
  process.exit(1);
}

const pack = buildContextPack({
  system_namespace: "demo-system",
  question: "debitos",
  journey,
  edges: stitched.edges,
});

const repoRoot = join(root, "fake-repo");
mkdirSync(repoRoot);
const hum = writeHumanProjection({
  repo_root: repoRoot,
  layer: "l1",
  meta: { system_namespace: "demo-system" },
  body_markdown: bodyFromL1Pack(pack),
});

const listed = listProjections(repoRoot);
if (!listed.projections?.some((p) => p.layer === "l1")) {
  console.error("FAIL: list-projections", listed);
  process.exit(1);
}

const md = readFileSync(hum.path, "utf8");
if (!md.includes("svc-a") || !md.includes("explorer_layer: l1")) {
  console.error("FAIL: human md content", md.slice(0, 200));
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      edge_count: stitched.edge_count,
      match_kind: stitched.edges[0].match_kind,
      journey_status: journey.status,
      pack_hops: pack.hop_count,
      code_pointers: pack.code_pointers.length,
      human: hum.path,
    },
    null,
    2,
  ),
);

rmSync(root, { recursive: true, force: true });
process.exit(0);
