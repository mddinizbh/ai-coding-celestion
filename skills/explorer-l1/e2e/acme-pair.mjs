#!/usr/bin/env node
/**
 * Real Acme pair proof: acme-tax → tax-provider-controller on accepted L0 DB.
 * Writes edges to a temp system DB copy of schema on the real L0 (read baselines
 * from real DB; persist to temp unless --apply-real).
 *
 * Exit 0 if ≥1 contract-matched edge on the debits path (or any config_binding
 * between the pair).
 */

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { stitchL1 } from "../src/stitch.mjs";

const DEFAULT_ACME =
  process.env.L1_ACME_TAX_PATH ||
  join(homedir(), "IdeaProjects/Acme/acme-tax");
const DEFAULT_CTL =
  process.env.L1_TAX_PROVIDER_CONTROLLER_PATH ||
  join(homedir(), "IdeaProjects/Acme/tax-provider-controller");
const DEFAULT_L0 =
  process.env.L1_L0_DB ||
  join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
    "descobrir",
    "acme.sqlite",
  );

/**
 * @param {string[]} argv
 */
export async function main(argv) {
  const applyReal = argv.includes("--apply-real");
  const dryRun = argv.includes("--dry-run");
  const dir = mkdtempSync(join(tmpdir(), "l1-e2e-"));
  const systemDb = applyReal ? DEFAULT_L0 : join(dir, "system.sqlite");

  try {
    if (!applyReal && !dryRun) {
      // start from copy of L0 so baselines + schema coexist
      copyFileSync(DEFAULT_L0, systemDb);
    }

    const result = stitchL1({
      l0_db: DEFAULT_L0,
      system_db: dryRun ? DEFAULT_L0 : systemDb,
      namespace: "acme",
      system_namespace: "acme-system",
      repos: [
        { logical_repo: "acme-tax", repo_path: DEFAULT_ACME },
        {
          logical_repo: "tax-provider-controller",
          repo_path: DEFAULT_CTL,
        },
      ],
      pairs: [{ from: "acme-tax", to: "tax-provider-controller" }],
      dry_run: dryRun,
    });

    const edges = result.edges || [];
    const debits = edges.filter((e) =>
      String(e.contract_key || "").includes("/api/debits/"),
    );
    const configHits = edges.filter((e) => e.match_kind === "config_binding");
    const ok = debits.length >= 1 || configHits.length >= 1;

    const evidence = {
      ok,
      status: result.status,
      edge_count: edges.length,
      debits_edges: debits.length,
      config_binding_edges: configHits.length,
      frontier_summary: result.frontier_summary,
      sample_edges: edges.slice(0, 10).map((e) => ({
        edge_id: e.edge_id,
        contract_key: e.contract_key,
        match_kind: e.match_kind,
        score: e.score,
        config_key: e.config_key,
        from: e.from.logical_repo,
        to: e.to.logical_repo,
        evidence: e.evidence,
      })),
      l0_db: DEFAULT_L0,
      system_db: dryRun ? null : systemDb,
      apply_real: applyReal,
    };

    const outPath = join(
      process.cwd(),
      ".omo/evidence/task-l1-acme-pair.json",
    );
    try {
      writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
      evidence.evidence_path = outPath;
    } catch {
      // optional
    }

    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    if (!ok) {
      process.stderr.write(
        "e2e failed: expected ≥1 debits or config_binding edge\n",
      );
      return 1;
    }
    return 0;
  } finally {
    if (!applyReal) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const isDirect =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  main(process.argv.slice(2)).then((c) => {
    process.exitCode = c;
  });
}
