#!/usr/bin/env node
/**
 * explorer-query — ensure (build↑) + answer/context-pack (query↓) + generate-human
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stitchL1 } from "../explorer-l1/src/stitch.mjs";
import { bindJourney, loadJourneySpec } from "../explorer-l2/src/journey-bind.mjs";
import { buildContextPack } from "./src/context-pack.mjs";
import {
  bodyFromL1Pack,
  listProjections,
  writeHumanProjection,
} from "./src/generate-human.mjs";
import { materializeSlice } from "./src/slice-materializer.mjs";
import { openSliceStore } from "./src/slice-store.mjs";
import {
  exitCodeForError,
  sanitizeSliceErrorMessage,
} from "./src/slice-errors.mjs";
import { exportPackage, openStore } from "../explorer-l0/src/store.mjs";
import { listSystemEdges, openSystemStore } from "../explorer-l1/src/system-store.mjs";
import { listJourneys, openJourneyStore, showJourney } from "../explorer-l2/src/journey-store.mjs";
import { projectContextPack } from "./src/context-pack.mjs";
import { runSliceGcCli } from "./src/slice-gc-cli.mjs";
import { checkFreshness } from "./src/freshness.mjs";

function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith("--")) throw new Error(`unexpected: ${t}`);
    const k = t.slice(2);
    const n = argv[i + 1];
    if (n === undefined || n.startsWith("--")) out[k] = true;
    else {
      out[k] = n;
      i += 1;
    }
  }
  return out;
}

function req(flags, name) {
  const v = flags[name];
  if (typeof v !== "string" || !v) throw new Error(`--${name} required`);
  return v;
}

function openRuntimeStores({ l0Db, systemDb }) {
  const rawL0 = openStore(l0Db);
  const rawL1 = openSystemStore(systemDb);
  const rawL2 = openJourneyStore(systemDb);
  const sliceStore = openSliceStore(systemDb);
  return {
    l0Store: {
      getAcceptedBaseline: (q) => rawL0.getAcceptedBaseline(q),
      getAcceptedPackage: (q) => exportPackage(rawL0, { ...q, accepted: true }),
    },
    l1Store: {
      listSystemEdges: (q) => listSystemEdges(rawL1, q),
    },
    l2Store: {
      listJourneys: (systemNamespace) => listJourneys(rawL2, systemNamespace),
      showJourney: (q) => showJourney(rawL2, q),
    },
    sliceStore,
    close() {
      sliceStore.close();
      rawL2.close?.();
      rawL1.close?.();
      rawL0.close?.();
    },
  };
}

export async function main(argv) {
  try {
    const [cmd, ...rest] = argv;
    if (!cmd) {
        throw new Error(
          "usage: ensure | answer | freshness | generate-human | list-projections | slice | slice-show | slice-gc",
        );

    }
    const flags = parseArgs(rest);

    switch (cmd) {
      case "ensure": {
        // fixture-oriented: --frontier-dir + --system-namespace + --namespace + --repos a,b
        // optional --system-db --domain ignored in v1 minimal
        const namespace = req(flags, "namespace");
        const systemNs = req(flags, "system-namespace");
        const frontierDir = req(flags, "frontier-dir");
        const repoList = req(flags, "repos").split(",").map((s) => s.trim());
        const systemDb =
          typeof flags["system-db"] === "string"
            ? flags["system-db"]
            : join(frontierDir, "system.sqlite");
        const result = stitchL1({
          namespace,
          system_namespace: systemNs,
          system_db: systemDb,
          repos: repoList.map((logical_repo) => ({ logical_repo })),
          frontier_dir: frontierDir,
          skip_baseline_check: true,
          dry_run: flags["dry-run"] === true,
          config_target_repo:
            typeof flags["config-map"] === "string"
              ? Object.fromEntries(
                  flags["config-map"].split(",").map((p) => {
                    const [k, v] = p.split("=");
                    return [k, v];
                  }),
                )
              : undefined,
        });
        if (typeof flags.output === "string") {
          writeFileSync(flags.output, `${JSON.stringify(result, null, 2)}\n`);
        }
        process.stdout.write(
          `${JSON.stringify(
            {
              status: result.status,
              edge_count: result.edge_count,
              system_namespace: systemNs,
              system_db: flags["dry-run"] ? null : systemDb,
            },
            null,
            2,
          )}\n`,
        );
        return 0;
      }
      case "freshness": {
        const l0Db = req(flags, "db");
        const namespace = req(flags, "namespace");
        const reposRaw = req(flags, "repos");
        const repoEntries = reposRaw.split(",").map((s) => {
          const [logical_repo, repo_path] = s.split("=");
          if (!logical_repo || !repo_path) {
            throw new Error(`--repos must be logical_repo=/abs/path, got invalid entry: ${s}`);
          }
          return { logical_repo: logical_repo.trim(), repo_path: repo_path.trim() };
        });
        const freshness = checkFreshness({ l0DbPath: l0Db, namespace, repos: repoEntries });
        if (typeof flags.output === "string") {
          writeFileSync(flags.output, `${JSON.stringify(freshness, null, 2)}\n`);
        }
        process.stdout.write(`${JSON.stringify(freshness, null, 2)}\n`);
        for (const f of freshness) {
          const shortBase = (f.baseline_revision || "").slice(0, 8);
          const shortHead = (f.head_revision || "").slice(0, 8);
          const statusLine = f.fresh
            ? "fresh"
            : `(+${f.behind} commits) — reindex`;
          const line = `baseline ${f.logical_repo}@${shortBase} · ${f.branch} ${shortHead} ${statusLine}`;
          process.stdout.write(`${line}\n`);
        }
        return 0;
      }
      case "answer": {
        if (flags["use-slice-cache"] === true) {
          // opt-in path: materialize/reuse Slice then project Pack (Todo 13+14)
          const systemNs = req(flags, "system-namespace");
          const systemDb = req(flags, "system-db");
          const l0Db = req(flags, "l0-db");
          const policyName = req(flags, "policy");
          const seedsPath = req(flags, "seeds");
          const seeds = JSON.parse(readFileSync(seedsPath, "utf8"));
          const stores = openRuntimeStores({ l0Db, systemDb });
          const request = {
            systemNamespace: systemNs,
            policy: { name: policyName, version: 1 },
            seeds,
            options: {},
            limits: {},
          };
          try {
            const mat = await materializeSlice({ request, l0Store: stores.l0Store, l1Store: stores.l1Store, l2Store: stores.l2Store, store: stores.sliceStore });
            const pack = projectContextPack({
              slice: mat.slice,
              sliceHash: mat.sliceHash,
              derivationKey: mat.derivationKey,
              budget: { max_nodes: 100, max_edges: 200, max_chars: 8000 },
            });
            const envelope = {
              ...pack,
              generated_at: new Date().toISOString(),
            };
            if (typeof flags.output === "string") {
              writeFileSync(flags.output, `${JSON.stringify(envelope, null, 2)}\n`);
            }
            process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
            return 0;
          } finally {
            stores.close();
          }
        }
        // legacy path (flag off) — untouched, never opens/creates Slice tables
        const systemNs = req(flags, "system-namespace");
        const edgesPath = req(flags, "edges");
        const edgesDoc = JSON.parse(readFileSync(edgesPath, "utf8"));
        const edges = Array.isArray(edgesDoc) ? edgesDoc : edgesDoc.edges || [];
        let journey;
        if (typeof flags.journey === "string") {
          const spec = loadJourneySpec(flags.journey);
          journey = bindJourney(spec, edges);
        }
        let projections = [];
        if (flags["with-projections"] === true && typeof flags["repo-root"] === "string") {
          projections = listProjections(flags["repo-root"]).projections || [];
        }
        const pack = buildContextPack({
          system_namespace: systemNs,
          question: typeof flags.question === "string" ? flags.question : "",
          journey,
          edges,
          projections,
        });

        // freshness integration (additive only; zero regression when --l0-db/--repos/--namespace absent)
        let freshnessSection;
        if (
          typeof flags["l0-db"] === "string" &&
          typeof flags.repos === "string" &&
          typeof flags.namespace === "string"
        ) {
          try {
            const l0Db = flags["l0-db"];
            const ns = flags.namespace;
            const repoEntries = flags.repos.split(",").map((s) => {
              const [log, p] = s.split("=");
              if (!log || !p) throw new Error(`invalid --repos entry: ${s}`);
              return { logical_repo: log.trim(), repo_path: p.trim() };
            });
            const fr = checkFreshness({ l0DbPath: l0Db, namespace: ns, repos: repoEntries });
            const stale = fr.some((r) => !r.fresh);
            freshnessSection = {
              repos: fr,
              warning: stale
                ? "One or more accepted baselines are behind HEAD — reindex recommended"
                : null,
            };
          } catch (e) {
            freshnessSection = { error: sanitizeSliceErrorMessage(e) };
          }
        }

        const answerOutput = freshnessSection ? { ...pack, freshness: freshnessSection } : pack;
        if (typeof flags.output === "string") {
          writeFileSync(flags.output, `${JSON.stringify(answerOutput, null, 2)}\n`);
        }
        process.stdout.write(`${JSON.stringify(answerOutput, null, 2)}\n`);
        return 0;
      }
      case "generate-human": {
        const repoRoot = req(flags, "repo-root");
        const layer = req(flags, "layer"); // l0|l1|l2
        if (!["l0", "l1", "l2"].includes(layer)) {
          throw new Error("--layer must be l0|l1|l2");
        }
        const packPath = req(flags, "from-pack");
        const pack = JSON.parse(readFileSync(packPath, "utf8"));
        const body =
          layer === "l1" || layer === "l2"
            ? bodyFromL1Pack(pack)
            : `# Explorer L0\n\n${pack.question || ""}\n`;
        const r = writeHumanProjection({
          repo_root: repoRoot,
          layer: /** @type {"l0"|"l1"|"l2"} */ (layer),
          meta: {
            system_namespace: pack.system_namespace || null,
            journey_id: pack.journey_id || null,
          },
          body_markdown: body,
        });
        process.stdout.write(`${JSON.stringify({ status: "ok", ...r })}\n`);
        return 0;
      }
      case "list-projections": {
        const repoRoot = req(flags, "repo-root");
        process.stdout.write(
          `${JSON.stringify(listProjections(repoRoot), null, 2)}\n`,
        );
        return 0;
      }
      case "slice": {
        const systemNs = req(flags, "system-namespace");
        const systemDb = req(flags, "system-db");
        const l0Db = req(flags, "l0-db");
        const policyName = req(flags, "policy");
        const seedsPath = req(flags, "seeds");
        const seeds = JSON.parse(readFileSync(seedsPath, "utf8"));
        const stores = openRuntimeStores({ l0Db, systemDb });
        const request = {
          systemNamespace: systemNs,
          policy: { name: policyName, version: 1 },
          seeds,
          options: {},
          limits: {},
        };
        try {
          const result = await materializeSlice({ request, l0Store: stores.l0Store, l1Store: stores.l1Store, l2Store: stores.l2Store, store: stores.sliceStore });
          const envelope = {
            command: "slice",
            slice_hash: result.sliceHash,
            status: result.status,
            created: result.created,
            system_namespace: systemNs,
            generated_at: new Date().toISOString(),
          };
          process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
          return 0;
        } finally {
          stores.close();
        }
      }
      case "slice-show": {
        const systemDb = req(flags, "system-db");
        const hash = req(flags, "slice-hash");
        const sliceStore = openSliceStore(systemDb);
        const slice = sliceStore.readByHash({ sliceHash: hash });
        if (!slice) {
          throw new Error(`slice not found: ${hash}`);
        }
        const envelope = {
          command: "slice-show",
          slice_hash: hash,
          slice,
          generated_at: new Date().toISOString(),
        };
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
        sliceStore.close();
        return 0;
      }
      case "slice-gc": {
        // Accept --system-db as alias of --db for CLI consistency.
        const gcArgv = [];
        for (let i = 0; i < rest.length; i += 1) {
          const t = rest[i];
          if (t === "--system-db") {
            gcArgv.push("--db");
            continue;
          }
          gcArgv.push(t);
        }
        if (!gcArgv.includes("--db") && typeof flags["system-db"] === "string") {
          gcArgv.push("--db", flags["system-db"]);
        }
        const result = await runSliceGcCli(gcArgv);
        if (result.stderr) process.stderr.write(`${result.stderr}\n`);
        if (result.report) {
          process.stdout.write(`${JSON.stringify({ command: "slice-gc", ...result.report }, null, 2)}\n`);
        }
        return result.code;
      }
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  } catch (err) {
    const sanitized = sanitizeSliceErrorMessage(err);
    process.stderr.write(`${sanitized}\n`);
    return exitCodeForError(err);
  }
}

const isDirect =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  main(process.argv.slice(2)).then((c) => {
    process.exitCode = c;
  });
}
