/**
 * Bind a JourneySpec against system edges (fixture or live).
 * Does not invent edges — reports gaps.
 *
 * ADR 0009 (id_version=2): journey_id is exposed as `l2:journey:<spec.id>`
 * and journey_hash includes ID_VERSION in its material so a version bump
 * invalidates every journey/bind hash downstream.
 */

import { readFileSync } from "node:fs";
import { ID_VERSION, makeL2JourneyId } from "../../explorer-l0/src/layered-id.mjs";
import { sha256Text, stableStringify } from "../../explorer-l0/src/stable-json.mjs";

/**
 * @typedef {{
 *   id: string,
 *   system_namespace: string,
 *   members: string[],
 *   steps: {
 *     id: string,
 *     trigger: "http-sync" | "queue" | "cron" | "webhook" | "internal",
 *     from?: string,
 *     to?: string,
 *     contract_prefix?: string,
 *     contract_key?: string,
 *     description?: string,
 *   }[],
 *   read_plan?: {
 *     id: string,
 *     step_id: string,
 *     file: string,
 *     line?: number,
 *     status: "pending" | "verified",
 *   }[],
 * }} JourneySpec
 */

/**
 * @param {JourneySpec} spec
 * @param {object[]} edges  system edges
 */
export function bindJourney(spec, edges) {
  if (!spec?.id || !spec.system_namespace || !Array.isArray(spec.steps)) {
    throw new Error("invalid JourneySpec");
  }
  const list = Array.isArray(edges) ? edges : [];
  /** @type {object[]} */
  const bound = [];
  /** @type {object[]} */
  const gaps = [];

  for (const step of spec.steps) {
    let matches = list;
    if (step.from) matches = matches.filter((e) => e.from?.logical_repo === step.from);
    if (step.to) matches = matches.filter((e) => e.to?.logical_repo === step.to);
    if (step.contract_key) {
      matches = matches.filter((e) => e.contract_key === step.contract_key);
    } else if (step.contract_prefix) {
      const p = step.contract_prefix;
      matches = matches.filter((e) => String(e.contract_key || "").startsWith(p));
    }

    if (matches.length === 0) {
      gaps.push({
        step_id: step.id,
        reason: "no_matching_edge",
        gap_class: "structural",
        trigger: step.trigger,
        from: step.from,
        to: step.to,
        contract_prefix: step.contract_prefix,
        contract_key: step.contract_key,
      });
      bound.push({
        step_id: step.id,
        trigger: step.trigger,
        status: "gap",
        edge_ids: [],
      });
    } else {
      bound.push({
        step_id: step.id,
        trigger: step.trigger,
        status: "bound",
        edge_ids: matches.map((e) => e.edge_id),
        edges: matches.map((e) => ({
          edge_id: e.edge_id,
          contract_key: e.contract_key,
          match_kind: e.match_kind,
          score: e.score,
          from: e.from?.logical_repo,
          to: e.to?.logical_repo,
          trigger: e.trigger || step.trigger,
          interaction: e.interaction,
          schedule: e.schedule,
          pipeline_id: e.pipeline_id,
        })),
      });
    }
  }

  const readPlan = Array.isArray(spec.read_plan) ? spec.read_plan : [];
  const material = stableStringify({
    id_version: ID_VERSION,
    id: spec.id,
    system_namespace: spec.system_namespace,
    bound,
    gaps,
    read_plan: readPlan.map((item) => ({
      id: item.id,
      step_id: item.step_id,
      file: item.file,
      line: item.line ?? null,
      status: item.status,
    })),
  });
  const journey_hash = sha256Text(material).slice(0, 32);
  const codeReadsPending = readPlan.filter((item) => item.status !== "verified").length;
  const structuralStatus = gaps.length === 0 ? "complete" : "partial";
  const understandingStatus =
    readPlan.length === 0
      ? "unverified"
      : codeReadsPending > 0
        ? "code-read-required"
        : "confirmed";

  return {
    journey_id: makeL2JourneyId(spec.id),
    system_namespace: spec.system_namespace,
    journey_hash,
    members: spec.members || [],
    steps_bound: bound.filter((b) => b.status === "bound").length,
    steps_gap: gaps.length,
    bound,
    gaps,
    status: structuralStatus,
    structural_status: structuralStatus,
    understanding_status: understandingStatus,
    code_reads_total: readPlan.length,
    code_reads_pending: codeReadsPending,
  };
}

/**
 * @param {string} path
 * @returns {JourneySpec}
 */
export function loadJourneySpec(path) {
  const text = readFileSync(path, "utf8");
  // minimal YAML-ish: only support JSON files for v1 hermetic (and .json)
  if (path.endsWith(".json")) {
    return JSON.parse(text);
  }
  // strip simple YAML by requiring JSON for now; if looks like JSON ok
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  throw new Error("v1 journey spec must be JSON (.json)");
}
