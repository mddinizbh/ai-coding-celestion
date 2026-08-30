#!/usr/bin/env node
/**
 * L1 CLI — stitch | status | export-system | callers | callees
 */

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveConfigMap, unmappedConfigKeys } from "./src/config-map.mjs";
import { sanitizeErrorMessage } from "./src/errors.mjs";
import { describeAdapters, inspectRepoFrontier } from "./src/frontier-extract.mjs";
import { loadAcceptedBaselines, stitchL1 } from "./src/stitch.mjs";
import {
  edgesForRepo,
  listSystemEdges,
  openSystemStore,
  systemStats,
} from "./src/system-store.mjs";

function parseArgs(argv) {
  /** @type {Record<string, string | boolean | string[]>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith("--")) throw new Error(`unexpected argument: ${t}`);
    const key = t.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function req(flags, name) {
  const v = flags[name];
  if (typeof v !== "string" || v === "") throw new Error(`--${name} is required`);
  return v;
}

function defaultL0Db(ns) {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  return join(data, "descobrir", `${ns}.sqlite`);
}

/**
 * @param {string[]} argv
 */
export async function main(argv) {
  try {
    if (!argv.length) {
      throw new Error(
        "usage: stitch | frontier-report | status | export-system | callers | callees",
      );
    }
    const [cmd, ...rest] = argv;
    const flags = parseArgs(rest);

    switch (cmd) {
      case "stitch": {
        const namespace = req(flags, "namespace");
        const systemNs = req(flags, "system-namespace");
        const l0Db =
          typeof flags["l0-db"] === "string"
            ? flags["l0-db"]
            : defaultL0Db(namespace);
        const systemDb =
          typeof flags["system-db"] === "string" ? flags["system-db"] : l0Db;
        // --repo logical_repo=path  (repeatable via comma: a=/p1,b=/p2)
        const repoSpec = req(flags, "repos");
        const repos = repoSpec.split(",").map((part) => {
          const [logical_repo, repo_path] = part.split("=");
          if (!logical_repo || !repo_path) {
            throw new Error(
              `--repos entries must be logical_repo=/abs/path (got ${part})`,
            );
          }
          return { logical_repo, repo_path };
        });
        let pairs;
        if (typeof flags.pair === "string") {
          // from->to
          const [from, to] = flags.pair.split("->");
          if (!from || !to) throw new Error("--pair must be from->to");
          pairs = [{ from, to }];
        }
        const resolved = resolveConfigMap({
          system_namespace: systemNs,
          system_db: systemDb,
          ...(typeof flags["config-map-file"] === "string"
            ? { file: flags["config-map-file"] }
            : {}),
          ...(typeof flags["config-map"] === "string"
            ? { inline: flags["config-map"] }
            : {}),
        });
        const result = stitchL1({
          l0_db: l0Db,
          system_db: systemDb,
          namespace,
          system_namespace: systemNs,
          repos,
          config_target_repo: resolved.map,
          config_map_resolution: { sources: resolved.sources, key_count: Object.keys(resolved.map).length },
          allow_empty_frontier: flags["allow-empty-frontier"] === true,
          ...(pairs ? { pairs } : {}),
          ...(typeof flags["frontier-dir"] === "string"
            ? { frontier_dir: flags["frontier-dir"] }
            : {}),
          dry_run: flags["dry-run"] === true,
        });
        // trim edges in stdout if huge unless --full
        const out =
          flags.full === true
            ? result
            : {
                ...result,
                edges: (result.edges || []).slice(0, 20),
                edges_truncated:
                  (result.edges || []).length > 20
                    ? (result.edges || []).length - 20
                    : 0,
              };
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
        return typeof result.exit_code === "number" ? result.exit_code : 0;
      }

      // Coverage of the frontier extraction itself: what was scanned, what was
      // skipped, which extractor fired, what came out. Run this BEFORE trusting
      // an empty stitch.
      case "frontier-report": {
        const namespace = req(flags, "namespace");
        const l0Db =
          typeof flags["l0-db"] === "string"
            ? flags["l0-db"]
            : defaultL0Db(namespace);
        const repoSpec = req(flags, "repos");
        const repos = repoSpec.split(",").map((part) => {
          const [logical_repo, repo_path] = part.split("=");
          if (!logical_repo || !repo_path) {
            throw new Error(
              `--repos entries must be logical_repo=/abs/path (got ${part})`,
            );
          }
          return { logical_repo, repo_path };
        });

        // --revision short-circuits the baseline lookup on purpose: the most
        // useful moment to run this report is BEFORE a repo has an accepted
        // baseline, to find out whether it can be covered at all.
        const pinned = typeof flags.revision === "string" ? flags.revision : null;
        const revByRepo = pinned
          ? Object.fromEntries(repos.map((r) => [r.logical_repo, pinned]))
          : Object.fromEntries(
              loadAcceptedBaselines(
                l0Db,
                namespace,
                repos.map((r) => r.logical_repo),
              ).map((b) => [b.logical_repo, b.source_revision]),
            );

        const frontiers = {};
        const reports = repos.map((r) => {
          const revision = revByRepo[r.logical_repo];
          if (!revision) {
            throw new Error(
              `no accepted baseline for ${r.logical_repo}; accept an L0 baseline or pass --revision`,
            );
          }
          const rep = inspectRepoFrontier({
            repoPath: r.repo_path,
            revision,
            namespace,
            logical_repo: r.logical_repo,
          });
          frontiers[r.logical_repo] = rep.facts;
          const { facts, ...withoutFacts } = rep;
          return withoutFacts;
        });

        const systemNs =
          typeof flags["system-namespace"] === "string" ? flags["system-namespace"] : null;
        let configBlock = null;
        if (systemNs) {
          const resolved = resolveConfigMap({
            system_namespace: systemNs,
            system_db: l0Db,
            ...(typeof flags["config-map-file"] === "string"
              ? { file: flags["config-map-file"] }
              : {}),
            ...(typeof flags["config-map"] === "string" ? { inline: flags["config-map"] } : {}),
          });
          configBlock = {
            sources: resolved.sources,
            key_count: Object.keys(resolved.map).length,
            unmapped_config_keys: unmappedConfigKeys(frontiers, resolved.map),
          };
        }

        const blind = reports.filter((r) => r.trust === "no-coverage").map((r) => r.logical_repo);
        process.stdout.write(
          `${JSON.stringify(
            {
              namespace,
              ...(systemNs ? { system_namespace: systemNs } : {}),
              repos: reports,
              no_coverage: blind,
              ...(configBlock ? { config_map: configBlock } : {}),
              extractors: describeAdapters(),
              verdict:
                blind.length > 0
                  ? "partial — a repo produced zero facts; an empty stitch would be a lie"
                  : "ok — every repo produced frontier facts",
            },
            null,
            2,
          )}\n`,
        );
        return blind.length > 0 ? 2 : 0;
      }

      case "status": {
        const systemNs = req(flags, "system-namespace");
        const db =
          typeof flags.db === "string"
            ? flags.db
            : defaultL0Db(req(flags, "namespace"));
        const store = openSystemStore(db);
        try {
          process.stdout.write(
            `${JSON.stringify(systemStats(store, systemNs), null, 2)}\n`,
          );
        } finally {
          store.close();
        }
        return 0;
      }
      case "export-system": {
        const systemNs = req(flags, "system-namespace");
        const db =
          typeof flags.db === "string"
            ? flags.db
            : defaultL0Db(req(flags, "namespace"));
        const output = req(flags, "output");
        const store = openSystemStore(db);
        try {
          const edges = listSystemEdges(store, { system_namespace: systemNs });
          const payload = {
            system_namespace: systemNs,
            exported_at: new Date().toISOString(),
            edge_count: edges.length,
            edges,
          };
          writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, {
            mode: 0o600,
          });
          process.stdout.write(
            `${JSON.stringify({ status: "ok", edge_count: edges.length, output })}\n`,
          );
        } finally {
          store.close();
        }
        return 0;
      }
      case "callers": {
        // who calls into --repo (inbound edges to repo)
        const systemNs = req(flags, "system-namespace");
        const repo = req(flags, "repo");
        const db =
          typeof flags.db === "string"
            ? flags.db
            : defaultL0Db(req(flags, "namespace"));
        const store = openSystemStore(db);
        try {
          const edges = edgesForRepo(store, systemNs, repo, "to");
          process.stdout.write(
            `${JSON.stringify({ repo, side: "callers", count: edges.length, edges }, null, 2)}\n`,
          );
        } finally {
          store.close();
        }
        return 0;
      }
      case "callees": {
        const systemNs = req(flags, "system-namespace");
        const repo = req(flags, "repo");
        const db =
          typeof flags.db === "string"
            ? flags.db
            : defaultL0Db(req(flags, "namespace"));
        const store = openSystemStore(db);
        try {
          const edges = edgesForRepo(store, systemNs, repo, "from");
          process.stdout.write(
            `${JSON.stringify({ repo, side: "callees", count: edges.length, edges }, null, 2)}\n`,
          );
        } finally {
          store.close();
        }
        return 0;
      }
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  } catch (err) {
    process.stderr.write(`${sanitizeErrorMessage(err)}\n`);
    return 1;
  }
}

const isDirect =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  main(process.argv.slice(2)).then((c) => {
    process.exitCode = c;
  });
}
