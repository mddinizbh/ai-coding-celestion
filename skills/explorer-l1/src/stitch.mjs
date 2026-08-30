/**
 * Orchestrate L1 stitch: load accepted L0 metadata → extract frontier from git → match → persist.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tableExists } from "../../explorer-l0/src/schema-versions.mjs";
import { unmappedConfigKeys } from "./config-map.mjs";
import { L1Error } from "./errors.mjs";
import { extractFrontierFromGit } from "./frontier-extract.mjs";
import { matchFrontiers } from "./matcher.mjs";
import {
  openSystemStore,
  persistSystemEdges,
  systemStats,
} from "./system-store.mjs";

/**
 * Load *.frontier.json produced by explorer-l0 export-frontier.
 * @param {string} frontierDir
 * @returns {Record<string, import("./frontier-extract.mjs").FrontierFact[]>}
 */
export function loadFrontiersFromDir(frontierDir) {
  /** @type {Record<string, import("./frontier-extract.mjs").FrontierFact[]>} */
  const out = {};
  if (!existsSync(frontierDir)) {
    throw new L1Error(`frontier dir missing: ${frontierDir}`);
  }
  for (const name of readdirSync(frontierDir)) {
    if (!name.endsWith(".frontier.json")) continue;
    const body = JSON.parse(readFileSync(join(frontierDir, name), "utf8"));
    const repo = body.logical_repo || name.replace(/\.frontier\.json$/, "");
    out[repo] = Array.isArray(body.facts) ? body.facts : [];
  }
  return out;
}

/**
 * @param {string} l0DbPath
 * @param {string} namespace
 * @param {string[]} logicalRepos
 */
export function loadAcceptedBaselines(l0DbPath, namespace, logicalRepos) {
  const db = new DatabaseSync(l0DbPath, { readOnly: true });
  try {
    const { acceptedBaselines, candidatePackages } = resolveL0TableNames(db);
    /** @type {object[]} */
    const out = [];
    for (const repo of logicalRepos) {
      const row = db
        .prepare(
          `SELECT a.namespace, a.logical_repo, a.candidate_id, a.approver, a.accepted_at,
                  c.source_revision, c.canonical_graph_hash
           FROM ${acceptedBaselines} a
           JOIN ${candidatePackages} c ON c.candidate_id = a.candidate_id
           WHERE a.namespace = ? AND a.logical_repo = ?`,
        )
        .get(namespace, repo);
      if (!row) {
        throw new L1Error(`no accepted baseline for ${namespace}/${repo}`);
      }
      out.push({ ...row });
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Resolve a complete L0 schema generation without mutating the DB. A mixed or
 * colliding pair is ambiguous and must be migrated before stitching.
 *
 * @param {InstanceType<typeof DatabaseSync>} db
 */
function resolveL0TableNames(db) {
  const layeredCandidates = tableExists(db, "l0_candidate_packages");
  const layeredAccepted = tableExists(db, "l0_accepted_baselines");
  const legacyCandidates = tableExists(db, "candidate_packages");
  const legacyAccepted = tableExists(db, "accepted_baselines");

  if (layeredCandidates && layeredAccepted && !legacyCandidates && !legacyAccepted) {
    return {
      candidatePackages: "l0_candidate_packages",
      acceptedBaselines: "l0_accepted_baselines",
    };
  }
  if (legacyCandidates && legacyAccepted && !layeredCandidates && !layeredAccepted) {
    return {
      candidatePackages: "candidate_packages",
      acceptedBaselines: "accepted_baselines",
    };
  }
  throw new L1Error(
    "L0 table names are missing, mixed, or colliding; run the layer-table migration first",
  );
}

/**
 * @param {{
 *   l0_db?: string,
 *   system_db?: string,
 *   namespace: string,
 *   system_namespace: string,
 *   repos: { logical_repo: string, repo_path?: string }[],
 *   pairs?: { from: string, to: string }[],
 *   config_target_repo?: Record<string, string>,
 *   dry_run?: boolean,
 *   frontier_dir?: string,
 *   frontiers?: Record<string, import("./frontier-extract.mjs").FrontierFact[]>,
 *   skip_baseline_check?: boolean,
 *   min_score?: number,
 * }} input
 */
export function stitchL1(input) {
  if (!input.namespace || !input.system_namespace) {
    throw new L1Error("namespace, system_namespace required");
  }
  if (!Array.isArray(input.repos) || input.repos.length < 2) {
    throw new L1Error("at least two repos are required");
  }

  const fixtureMode = Boolean(
    input.frontiers || input.frontier_dir || input.skip_baseline_check,
  );
  if (!fixtureMode && !input.l0_db) {
    throw new L1Error("l0_db required unless frontiers/frontier_dir provided");
  }

  const systemDb = input.system_db || input.l0_db;
  if (!systemDb && !input.dry_run) {
    throw new L1Error("system_db or l0_db required to persist");
  }

  /** @type {object[]} */
  let baselines = [];
  if (!fixtureMode && input.l0_db) {
    baselines = loadAcceptedBaselines(
      input.l0_db,
      input.namespace,
      input.repos.map((r) => r.logical_repo),
    );
  } else {
    baselines = input.repos.map((r) => ({
      namespace: input.namespace,
      logical_repo: r.logical_repo,
      source_revision: "fixture",
      candidate_id: `fixture:${r.logical_repo}`,
    }));
  }
  const byRepo = Object.fromEntries(baselines.map((b) => [b.logical_repo, b]));

  /** @type {Record<string, import("./frontier-extract.mjs").FrontierFact[]>} */
  let frontiers = {};
  if (input.frontiers) {
    frontiers = { ...input.frontiers };
  } else if (input.frontier_dir) {
    frontiers = loadFrontiersFromDir(input.frontier_dir);
  } else {
    for (const r of input.repos) {
      const b = byRepo[r.logical_repo];
      if (!r.repo_path) {
        throw new L1Error(`repo_path required for git extract: ${r.logical_repo}`);
      }
      frontiers[r.logical_repo] = extractFrontierFromGit({
        repoPath: r.repo_path,
        revision: b.source_revision,
        namespace: input.namespace,
        logical_repo: r.logical_repo,
      });
    }
  }

  const frontier_summary = Object.fromEntries(
    Object.entries(frontiers).map(([k, v]) => [
      k,
      {
        total: v.length,
        inbound: v.filter((x) => x.kind === "http_inbound").length,
        outbound: v.filter((x) => x.kind === "http_outbound").length,
        config: v.filter((x) => x.kind === "config_binding").length,
        topic_publish: v.filter((x) => x.kind === "topic_publish").length,
        topic_consume: v.filter((x) => x.kind === "topic_consume").length,
        cron: v.filter((x) => x.trigger === "cron").length,
      },
    ]),
  );

  // ── Item 1: an empty frontier is a failure, not an answer ────────────────
  // `edge_count: 0` with `status: "stitched"` reads as "these services do not
  // talk". Usually it means "this repo was never parsed" — a renamed config
  // file, a framework without an adapter, a wrong revision. Fail loudly.
  const emptyRepos = Object.entries(frontiers)
    .filter(([, facts]) => !facts || facts.length === 0)
    .map(([repo]) => repo)
    .sort();

  const configResolution = input.config_map_resolution || null;
  const unmapped = unmappedConfigKeys(frontiers, input.config_target_repo || {});

  if (emptyRepos.length > 0 && !input.allow_empty_frontier) {
    return {
      status: "blocked",
      exit_code: 2,
      system_namespace: input.system_namespace,
      blockers: emptyRepos.map((repo) => ({
        code: "frontier_empty",
        logical_repo: repo,
        message: `no frontier facts extracted from ${repo} at its accepted revision`,
        hint:
          "run `frontier-report --repos ...` to see what was scanned; a language without an adapter yields zero silently",
      })),
      frontier_summary,
      empty_repos: emptyRepos,
      unmapped_config_keys: unmapped,
      config_map: configResolution,
      baselines,
      note: "nothing was persisted; pass --allow-empty-frontier to stitch anyway",
    };
  }

  const pairs =
    input.pairs ||
    input.repos.flatMap((a) =>
      input.repos
        .filter((b) => b.logical_repo !== a.logical_repo)
        .map((b) => ({ from: a.logical_repo, to: b.logical_repo })),
    );

  /** @type {import("./matcher.mjs").SystemEdge[]} */
  let edges = [];
  for (const p of pairs) {
    const fromF = frontiers[p.from];
    const toF = frontiers[p.to];
    if (!fromF || !toF) {
      throw new L1Error(`missing frontier for pair ${p.from}→${p.to}`);
    }
    edges.push(
      ...matchFrontiers(fromF, toF, {
        config_target_repo: input.config_target_repo,
        min_score: input.min_score,
      }),
    );
  }

  const byId = new Map();
  for (const e of edges) byId.set(e.edge_id, e);
  edges = [...byId.values()];

  if (input.dry_run) {
    return {
      status: "dry_run",
      system_namespace: input.system_namespace,
      edge_count: edges.length,
      edges,
      frontier_summary,
      empty_repos: emptyRepos,
      unmapped_config_keys: unmapped,
      config_map: configResolution,
      baselines,
    };
  }

  const store = openSystemStore(systemDb);
  try {
    const { inserted, skipped, conflicts } = persistSystemEdges(
      store,
      input.system_namespace,
      edges,
    );
    const runId = `stitch:${createHash("sha256")
      .update(
        [
          input.system_namespace,
          ...baselines.map((b) => b.candidate_id),
          String(edges.length),
        ].join("|"),
      )
      .digest("hex")
      .slice(0, 16)}`;
    store._db
      .prepare(
        `INSERT OR REPLACE INTO l1_system_stitch_runs
         (run_id, system_namespace, repos_json, edge_count, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        runId,
        input.system_namespace,
        JSON.stringify(input.repos.map((r) => r.logical_repo)),
        edges.length,
        new Date().toISOString(),
      );

    const stats = systemStats(store, input.system_namespace);
    return {
      status: "stitched",
      system_namespace: input.system_namespace,
      run_id: runId,
      edge_count: edges.length,
      inserted,
      skipped,
      ...(conflicts && conflicts.length
        ? {
            edge_id_conflicts: conflicts,
            warning:
              "edges dropped because another system namespace already owns the same edge_id (PRIMARY KEY does not include system_namespace)",
          }
        : {}),
      stats,
      edges,
      frontier_summary,
      empty_repos: emptyRepos,
      unmapped_config_keys: unmapped,
      config_map: configResolution,
      baselines,
    };
  } finally {
    store.close();
  }
}
