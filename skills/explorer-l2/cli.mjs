#!/usr/bin/env node
/**
 * L2 CLI — bottom-up pipeline + query
 *
 *   propose-from-l1 | enrich-from-l0 | synthesize | bind
 *   list | show | journeys-for-edge | status
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sanitizeErrorMessage } from "../explorer-l1/src/errors.mjs";
import {
  listSystemEdges,
  openSystemStore,
} from "../explorer-l1/src/system-store.mjs";
import { exportPackage, openStore } from "../explorer-l0/src/store.mjs";
import { bindJourney, loadJourneySpec } from "./src/journey-bind.mjs";
import { enrichFromL0, loadAcceptedPackagesWith } from "./src/enrich-from-l0.mjs";
import { proposeFromL1 } from "./src/propose-from-l1.mjs";
import { synthesizeJourney } from "./src/synthesize.mjs";
import {
  journeysForEdge,
  journeyStats,
  listJourneys,
  openJourneyStore,
  persistJourneyBind,
  showJourney,
} from "./src/journey-store.mjs";

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

function defaultDb(ns) {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  return join(data, "descobrir", `${ns}.sqlite`);
}

function resolveDb(flags) {
  if (typeof flags.db === "string") return flags.db;
  return defaultDb(
    typeof flags.namespace === "string" ? flags.namespace : "acme",
  );
}

/**
 * @param {Record<string, string | boolean>} flags
 * @param {string} systemNamespace
 */
function loadEdges(flags, systemNamespace) {
  if (typeof flags.edges === "string" && flags.edges) {
    const edgesDoc = JSON.parse(readFileSync(flags.edges, "utf8"));
    return Array.isArray(edgesDoc) ? edgesDoc : edgesDoc.edges || [];
  }
  const store = openSystemStore(resolveDb(flags));
  try {
    /** @type {{ system_namespace: string, from_repo?: string, to_repo?: string }} */
    const q = { system_namespace: systemNamespace };
    if (typeof flags.from === "string") q.from_repo = flags.from;
    if (typeof flags.to === "string") q.to_repo = flags.to;
    return listSystemEdges(store, q);
  } finally {
    store.close();
  }
}

function maybeWrite(flags, obj) {
  if (typeof flags.out === "string" && flags.out) {
    writeFileSync(flags.out, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  }
}

/**
 * @param {string[]} argv
 */
export async function main(argv) {
  try {
    const [cmd, ...rest] = argv;
    if (!cmd) {
      throw new Error(
        "usage: propose-from-l1 | enrich-from-l0 | synthesize | bind | list | show | journeys-for-edge | status",
      );
    }
    const flags = parseArgs(rest);

    // ── Bottom-up pipeline ──────────────────────────────────────────

    if (cmd === "propose-from-l1") {
      const systemNs = req(flags, "system-namespace");
      const edges = loadEdges(flags, systemNs);
      const result = proposeFromL1(edges, {
        system_namespace: systemNs,
        ...(typeof flags["journey-id"] === "string"
          ? { journey_id: flags["journey-id"] }
          : {}),
        ...(typeof flags.from === "string" ? { from_repo: flags.from } : {}),
        ...(typeof flags.to === "string" ? { to_repo: flags.to } : {}),
        ...(typeof flags["min-score"] === "string"
          ? { min_score: Number(flags["min-score"]) }
          : {}),
      });
      maybeWrite(flags, result.spec);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    if (cmd === "enrich-from-l0") {
      const spec = loadJourneySpec(req(flags, "spec"));
      const namespace =
        typeof flags.namespace === "string" ? flags.namespace : "acme";
      const dbPath = resolveDb(flags);
      const l0 = openStore(dbPath);
      try {
        const packages = loadAcceptedPackagesWith(
          exportPackage,
          l0,
          namespace,
          spec.members || [],
        );
        const result = enrichFromL0(spec, { packages_by_repo: packages });
        maybeWrite(flags, result.spec);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } finally {
        l0.close();
      }
      return 0;
    }

    if (cmd === "synthesize") {
      const systemNs = req(flags, "system-namespace");
      const namespace =
        typeof flags.namespace === "string" ? flags.namespace : "acme";
      const dbPath = resolveDb(flags);
      const edges = loadEdges(flags, systemNs);
      const l0 = openStore(dbPath);
      try {
        const result = synthesizeJourney({
          edges,
          system_namespace: systemNs,
          namespace,
          l0Store: l0,
          exportPackage,
          ...(typeof flags["journey-id"] === "string"
            ? { journey_id: flags["journey-id"] }
            : {}),
          ...(typeof flags.from === "string" ? { from_repo: flags.from } : {}),
          ...(typeof flags.to === "string" ? { to_repo: flags.to } : {}),
          ...(typeof flags["min-score"] === "string"
            ? { min_score: Number(flags["min-score"]) }
            : {}),
          skip_enrich: flags["skip-enrich"] === true,
        });

        if (flags.persist === true) {
          const jstore = openJourneyStore(dbPath);
          try {
            const persisted = persistJourneyBind(jstore, {
              spec: result.spec,
              bind: result.bind,
              set_current: flags["no-current"] !== true,
            });
            result.persisted = persisted;
          } finally {
            jstore.close();
          }
        }

        maybeWrite(flags, result.spec);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } finally {
        l0.close();
      }
      return 0;
    }

    // ── Classic bind / query ────────────────────────────────────────

    if (cmd === "bind") {
      const spec = loadJourneySpec(req(flags, "spec"));
      const systemNs = spec.system_namespace;
      const edges = loadEdges(flags, systemNs);
      const result = bindJourney(spec, edges);

      /** @type {Record<string, unknown>} */
      let out = { ...result };
      if (flags.persist === true) {
        const store = openJourneyStore(resolveDb(flags));
        try {
          const persisted = persistJourneyBind(store, {
            spec,
            bind: result,
            set_current: flags["no-current"] !== true,
          });
          out = { ...result, persisted };
        } finally {
          store.close();
        }
      }
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return 0;
    }

    if (cmd === "list") {
      const systemNs = req(flags, "system-namespace");
      const store = openJourneyStore(resolveDb(flags));
      try {
        const journeys = listJourneys(store, systemNs);
        process.stdout.write(
          `${JSON.stringify({ system_namespace: systemNs, count: journeys.length, journeys }, null, 2)}\n`,
        );
      } finally {
        store.close();
      }
      return 0;
    }

    if (cmd === "show") {
      const systemNs = req(flags, "system-namespace");
      const journeyId = req(flags, "journey-id");
      const store = openJourneyStore(resolveDb(flags));
      try {
        const row = showJourney(store, {
          system_namespace: systemNs,
          journey_id: journeyId,
          ...(typeof flags["bind-id"] === "string"
            ? { bind_id: flags["bind-id"] }
            : {}),
        });
        if (!row) {
          process.stdout.write(
            `${JSON.stringify({ status: "not_found", journey_id: journeyId })}\n`,
          );
          return 1;
        }
        process.stdout.write(`${JSON.stringify(row, null, 2)}\n`);
      } finally {
        store.close();
      }
      return 0;
    }

    if (cmd === "journeys-for-edge") {
      const edgeId = req(flags, "edge-id");
      const store = openJourneyStore(resolveDb(flags));
      try {
        const journeys = journeysForEdge(store, {
          edge_id: edgeId,
          ...(typeof flags["system-namespace"] === "string"
            ? { system_namespace: flags["system-namespace"] }
            : {}),
        });
        process.stdout.write(
          `${JSON.stringify({ edge_id: edgeId, count: journeys.length, journeys }, null, 2)}\n`,
        );
      } finally {
        store.close();
      }
      return 0;
    }

    if (cmd === "status") {
      const systemNs = req(flags, "system-namespace");
      const store = openJourneyStore(resolveDb(flags));
      try {
        process.stdout.write(
          `${JSON.stringify(journeyStats(store, systemNs), null, 2)}\n`,
        );
      } finally {
        store.close();
      }
      return 0;
    }

    throw new Error(`unknown command: ${cmd}`);
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
