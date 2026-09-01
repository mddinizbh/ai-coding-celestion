#!/usr/bin/env node
/**
 * explorer-audit — sample L1 edges, scan omissions, show pinned evidence.
 * Does not stitch, accept, or mutate the graph.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { listSystemEdges, openSystemStore } from "../explorer-l1/src/system-store.mjs";
import { inspectRepoFrontier } from "../explorer-l1/src/frontier-extract.mjs";
import { detectObservations } from "./src/detect-observations.mjs";
import { sampleEdges } from "./src/sample.mjs";
import { scanOmissions } from "./src/omissions.mjs";
import { showPinned } from "./src/show.mjs";

function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
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

function defaultDb(ns) {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  return join(data, "descobrir", `${ns}.sqlite`);
}

function parseRepos(spec) {
  return spec.split(",").map((part) => {
    const eq = part.indexOf("=");
    if (eq <= 0) throw new Error(`--repos entries must be logical_repo=/abs/path (got ${part})`);
    return { logical_repo: part.slice(0, eq), repo_path: part.slice(eq + 1) };
  });
}

/**
 * @param {string[]} argv
 */
export function main(argv) {
  try {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new Error("usage: sample | omissions | show");
    }
    const [cmd, ...rest] = argv;
    const flags = parseArgs(rest);

    switch (cmd) {
      case "sample": {
        const namespace = req(flags, "namespace");
        const systemNs =
          typeof flags["system-namespace"] === "string" && flags["system-namespace"] !== ""
            ? flags["system-namespace"]
            : namespace;
        const db = typeof flags.db === "string" && flags.db !== "" ? flags.db : defaultDb(namespace);
        const perClass = typeof flags["per-class"] === "string" ? Number(flags["per-class"]) : 5;
        const store = openSystemStore(db);
        try {
          const edges = listSystemEdges(store, { system_namespace: systemNs });
          if (edges.length === 0) {
            process.stdout.write(
              `${JSON.stringify({ status: "blocked", code: "no_l1_edges", namespace, system_namespace: systemNs })}\n`,
            );
            return 2;
          }
          const sampled = sampleEdges(edges, { perClass: Number.isFinite(perClass) ? perClass : 5 });
          process.stdout.write(
            `${JSON.stringify({ status: "ok", namespace, system_namespace: systemNs, ...sampled }, null, 2)}\n`,
          );
          return 0;
        } finally {
          store.close();
        }
      }
      case "omissions": {
        const namespace = req(flags, "namespace");
        const repoSpec = req(flags, "repos");
        const revisionFlag = typeof flags.revision === "string" ? flags.revision : "";
        const repos = parseRepos(repoSpec).map((r) => {
          if (!revisionFlag) throw new Error("--revision is required");
          return { ...r, revision: revisionFlag };
        });
        const result = scanOmissions({ namespace, repos });
        process.stdout.write(
          `${JSON.stringify({ status: "ok", namespace, ...result }, null, 2)}\n`,
        );
        return 0;
      }
      case "observations": {
        const namespace = req(flags, "namespace");
        const runId = req(flags, "run-id");
        const revision = req(flags, "revision");
        const repos = parseRepos(req(flags, "repos"));
        const observations = [];
        for (const repo of repos) {
          const frontierReport = inspectRepoFrontier({
            repoPath: repo.repo_path,
            revision,
            namespace,
            logical_repo: repo.logical_repo,
          });
          observations.push(...detectObservations({
            namespace,
            run_id: runId,
            repo_path: repo.repo_path,
            revision,
            logical_repo: repo.logical_repo,
            frontier_report: frontierReport,
          }));
        }
        process.stdout.write(
          `${JSON.stringify({ status: "ok", namespace, run_id: runId, observations }, null, 2)}\n`,
        );
        return 0;
      }
      case "show": {
        const out = showPinned({
          repo_path: req(flags, "repo-path"),
          revision: req(flags, "revision"),
          file: req(flags, "file"),
          line: Number(req(flags, "line")),
          context: typeof flags.context === "string" ? Number(flags.context) : 8,
        });
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
        return 0;
      }
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  process.exitCode = main(process.argv.slice(2));
}
