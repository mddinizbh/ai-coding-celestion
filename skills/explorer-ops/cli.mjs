#!/usr/bin/env node
/**
 * explorer-ops — journal of pipeline runs and challenges.
 * usage: log | list | challenges
 */
import { pathToFileURL } from "node:url";

import { defaultOpsDbPath, openOpsStore, OpsStoreError } from "./src/store.mjs";

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

function dbPath(flags) {
  if (typeof flags.db === "string" && flags.db !== "") return flags.db;
  return defaultOpsDbPath();
}

/**
 * @param {string[]} argv
 */
export function main(argv) {
  try {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new Error("usage: log | list | challenges");
    }
    const [cmd, ...rest] = argv;
    const flags = parseArgs(rest);
    const store = openOpsStore(dbPath(flags));
    try {
      switch (cmd) {
        case "log": {
          const phase = req(flags, "phase");
          const status = req(flags, "status");
          /** @type {{ code: string, detail: string, how_we_attacked?: string }[]} */
          const challenges = [];
          if (typeof flags.challenge === "string" && flags.challenge !== "") {
            challenges.push({
              code: flags.challenge,
              detail: typeof flags["challenge-detail"] === "string" ? flags["challenge-detail"] : "",
              how_we_attacked:
                typeof flags["how-we-attacked"] === "string" ? flags["how-we-attacked"] : undefined,
            });
          }
          let detail = {};
          if (typeof flags.detail === "string" && flags.detail !== "") {
            detail = JSON.parse(flags.detail);
          }
          const rec = {
            phase,
            status,
            ...(typeof flags["run-id"] === "string" ? { run_id: flags["run-id"] } : {}),
            ...(typeof flags.namespace === "string" ? { namespace: flags.namespace } : {}),
            ...(typeof flags.repos === "string"
              ? { logical_repos: flags.repos.split(",").map((s) => s.trim()).filter(Boolean) }
              : {}),
            detail,
            challenges,
          };
          const out = store.log(rec);
          process.stdout.write(`${JSON.stringify({ status: "ok", ...out })}\n`);
          return 0;
        }
        case "list": {
          const limit = typeof flags.limit === "string" ? Number(flags.limit) : 20;
          const rows = store.listRuns({
            ...(typeof flags.namespace === "string" ? { namespace: flags.namespace } : {}),
            limit: Number.isFinite(limit) ? limit : 20,
          });
          process.stdout.write(`${JSON.stringify({ runs: rows }, null, 2)}\n`);
          return 0;
        }
        case "challenges": {
          const limit = typeof flags.limit === "string" ? Number(flags.limit) : 50;
          const rows = store.listChallenges({
            ...(typeof flags.code === "string" ? { code: flags.code } : {}),
            limit: Number.isFinite(limit) ? limit : 50,
          });
          process.stdout.write(`${JSON.stringify({ challenges: rows }, null, 2)}\n`);
          return 0;
        }
        case "record-outcome": {
          const input = JSON.parse(req(flags, "input-json"));
          const out = store.recordOutcome(input);
          process.stdout.write(`${JSON.stringify(out)}\n`);
          return 0;
        }
        case "load-context": {
          const scope = JSON.parse(req(flags, "scope-json"));
          const limit = typeof flags.limit === "string" ? Number(flags.limit) : undefined;
          const out = store.loadContext({
            scope,
            objective: req(flags, "objective"),
            ...(limit === undefined ? {} : { limit }),
          });
          process.stdout.write(`${JSON.stringify(out)}\n`);
          return 0;
        }
        case "resolve-gap": {
          const humanClosure = typeof flags["human-closure-json"] === "string"
            ? JSON.parse(flags["human-closure-json"])
            : undefined;
          const out = store.resolveGap({
            gap_key: req(flags, "gap-key"),
            resolution: req(flags, "resolution"),
            ...(typeof flags["accepted-evidence-ref"] === "string"
              ? { accepted_evidence_ref: flags["accepted-evidence-ref"] }
              : {}),
            ...(typeof flags["replacement-gap-key"] === "string"
              ? { replacement_gap_key: flags["replacement-gap-key"] }
              : {}),
            ...(humanClosure === undefined ? {} : { human_closure: humanClosure }),
          });
          process.stdout.write(`${JSON.stringify(out)}\n`);
          return 0;
        }
        default:
          throw new Error(`unknown command: ${cmd}`);
      }
    } finally {
      store.close();
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof OpsStoreError ? 2 : 1;
  }
}

const isDirect =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  process.exitCode = main(process.argv.slice(2));
}
