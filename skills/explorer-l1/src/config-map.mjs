/**
 * Per-system config map resolution.
 *
 * The config map answers one question: "this caller's base-URL env key points
 * at WHICH logical repo?". It is what promotes an edge from a bare path guess
 * (score 0.55) to config-bound evidence (score 0.95), so it is project data —
 * not a constant that belongs to whichever client was onboarded first.
 *
 * Resolution order (later wins):
 *   1. built-in legacy defaults (deprecated, kept so existing systems don't
 *      silently lose scoring; they are reported as `legacy_builtin`)
 *   2. `<skill>/config/<system-namespace>.config-map.json`
 *   3. `<dirname(system_db)>/config-maps/<system-namespace>.json`
 *   4. explicit `--config-map-file`
 *   5. inline `--config-map KEY=repo,KEY2=repo2`
 *
 * File shape: `{ "IAM_API_URL": "cloud", "PAYMENT_SERVICE_URL": "cloud" }`
 * (an optional `config_target_repo` wrapper object is also accepted).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { L1Error } from "./errors.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Legacy hard-coded map, kept only for systems onboarded before config files
 * existed. New systems must ship a config file instead.
 * @type {Readonly<Record<string, string>>}
 */
export const LEGACY_BUILTIN_CONFIG_MAP = Object.freeze({
  PROVIDERCONTROLLER_API_URL: "tax-provider-controller",
  TAX_PROVIDER_ALT_URL: "tax-provider-alt",
  TAX_PROVIDER_CONTROLLER_URL: "tax-provider-controller",
  TAX_BASE_URL: "acme-tax",
  TAX_PROVIDER_ALT_BASE_URL: "tax-provider-alt",
});

/** @param {string} path */
function readMapFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new L1Error(`config map is not valid JSON: ${path}`);
  }
  const body = parsed && typeof parsed === "object" && parsed.config_target_repo
    ? parsed.config_target_repo
    : parsed;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new L1Error(`config map must be an object of KEY -> logical_repo: ${path}`);
  }
  for (const [k, v] of Object.entries(body)) {
    if (typeof v !== "string" || v === "") {
      throw new L1Error(`config map key ${k} must map to a logical_repo string: ${path}`);
    }
  }
  return body;
}

/**
 * @param {string} spec  "KEY=repo,KEY2=repo2"
 * @returns {Record<string, string>}
 */
export function parseInlineConfigMap(spec) {
  if (typeof spec !== "string" || spec.trim() === "") return {};
  return Object.fromEntries(
    spec.split(",").map((pair) => {
      const [k, v] = pair.split("=");
      if (!k || !v) {
        throw new L1Error(`--config-map entries must be KEY=logical_repo (got ${pair})`);
      }
      return [k.trim(), v.trim()];
    }),
  );
}

/**
 * @param {{
 *   system_namespace: string,
 *   system_db?: string,
 *   file?: string,
 *   inline?: string | Record<string, string>,
 *   include_legacy_builtin?: boolean,
 * }} opts
 * @returns {{ map: Record<string, string>, sources: {kind: string, path?: string, keys: number}[] }}
 */
export function resolveConfigMap(opts) {
  if (!opts?.system_namespace) {
    throw new L1Error("resolveConfigMap: system_namespace required");
  }
  /** @type {{kind: string, path?: string, keys: number}[]} */
  const sources = [];
  /** @type {Record<string, string>} */
  let map = {};

  if (opts.include_legacy_builtin !== false) {
    map = { ...LEGACY_BUILTIN_CONFIG_MAP };
    sources.push({ kind: "legacy_builtin", keys: Object.keys(LEGACY_BUILTIN_CONFIG_MAP).length });
  }

  const shipped = join(here, "..", "config", `${opts.system_namespace}.config-map.json`);
  if (existsSync(shipped)) {
    const body = readMapFile(shipped);
    map = { ...map, ...body };
    sources.push({ kind: "skill_config", path: shipped, keys: Object.keys(body).length });
  }

  if (opts.system_db) {
    const beside = join(dirname(opts.system_db), "config-maps", `${opts.system_namespace}.json`);
    if (existsSync(beside)) {
      const body = readMapFile(beside);
      map = { ...map, ...body };
      sources.push({ kind: "store_config", path: beside, keys: Object.keys(body).length });
    }
  }

  if (opts.file) {
    if (!existsSync(opts.file)) throw new L1Error(`config map file not found: ${opts.file}`);
    const body = readMapFile(opts.file);
    map = { ...map, ...body };
    sources.push({ kind: "explicit_file", path: opts.file, keys: Object.keys(body).length });
  }

  if (opts.inline) {
    const body =
      typeof opts.inline === "string" ? parseInlineConfigMap(opts.inline) : opts.inline;
    map = { ...map, ...body };
    sources.push({ kind: "inline", keys: Object.keys(body).length });
  }

  return { map, sources };
}

/**
 * Which outbound config keys were seen in the frontier but are NOT mapped to a
 * repo — i.e. the edges that are stuck at path-only scoring and could be
 * promoted to config-bound evidence by adding one line to the config map.
 *
 * @param {Record<string, import("./frontier-extract.mjs").FrontierFact[]>} frontiers
 * @param {Record<string, string>} map
 */
export function unmappedConfigKeys(frontiers, map) {
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  for (const [repo, facts] of Object.entries(frontiers || {})) {
    for (const f of facts || []) {
      const key = f.config_key;
      if (!key || map[key]) continue;
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(repo);
    }
  }
  return [...seen.entries()]
    .map(([config_key, repos]) => ({ config_key, seen_in: [...repos].sort() }))
    .sort((a, b) => (a.config_key < b.config_key ? -1 : 1));
}
