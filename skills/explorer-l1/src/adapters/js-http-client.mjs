/**
 * Frontier adapter: server-side JavaScript HTTP clients.
 *
 * Targets the shape used by Node-style / embedded-runtime backends where the
 * base URL of a downstream service comes from an env var and the path is a
 * literal in the call:
 *
 *   function iamUrl() { return process.env.IAM_API_URL || "http://localhost:8080"; }
 *   callBearer("POST", "/api/v1/iam/auth/forgot-password", body)
 *   var url = iamUrl() + "/api/v1/iam/auth/register";
 *
 * Why it matters: the env key is what promotes an edge from a bare path guess
 * (0.55) to config-bound evidence (0.95). A path literal without the key is
 * still emitted, just weaker.
 *
 * Only client libraries are scanned (`**\/lib/**` or files ending in
 * `-client.js` / `client.js`), because those are where downstream calls are
 * centralised; route handlers call the library, not the network.
 */

export const id = "js-http-client";

const HTTP_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * A base-URL key, not any env var. `IAM_API_KEY` sitting next to
 * `IAM_API_URL` must not be mistaken for a service binding — that mistake
 * makes the file look like it talks to two services and silently drops the
 * config binding from every call in it.
 * @param {string} key
 */
function isServiceUrlKey(key) {
  return /(URL|URI|HOST|ENDPOINT)$/.test(key);
}

/** @param {string} file */
export function matches(file) {
  if (!/\.(js|mjs|cjs)$/i.test(file)) return false;
  if (/(^|\/)(node_modules|dist|build|vendor)\//i.test(file)) return false;
  if (/\.(min|test|spec)\.[cm]?js$/i.test(file)) return false;
  return /(^|\/)lib\//i.test(file) || /(^|-)client\.[cm]?js$/i.test(file);
}

export function describes() {
  return {
    id,
    language: "javascript",
    reads: ["**/lib/**.js", "**/*-client.js"],
    emits: ["http_outbound", "config_binding"],
    recognizes: [
      'function xUrl() { return process.env.KEY || "..." }',
      'call("POST", "/api/path", ...)',
      'xUrl() + "/api/path"',
    ],
    blind_to: [
      "paths built entirely from variables",
      "inbound routes (declared elsewhere, e.g. a route manifest)",
      "HTTP calls made directly inside route handlers instead of a client lib",
    ],
  };
}

/**
 * env base-URL bindings: function name → config key, plus bare `var x = process.env.KEY`.
 * @param {string[]} lines
 */
export function collectBaseUrlBindings(lines) {
  /** @type {Record<string, string>} */
  const byFn = {};
  /** @type {Set<string>} */
  const keys = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const fn = lines[i].match(/function\s+([A-Za-z_$][\w$]*)\s*\(\s*\)/);
    if (fn) {
      // the env key may sit on this line or a couple of lines below
      for (let j = i; j < Math.min(i + 4, lines.length); j += 1) {
        const env = lines[j].match(/process\.env\.([A-Z][A-Z0-9_]*)/);
        if (env) {
          if (isServiceUrlKey(env[1])) {
            byFn[fn[1]] = env[1];
            keys.add(env[1]);
          }
          break;
        }
        if (j > i && /^\s*\}/.test(lines[j])) break;
      }
    }
    const bare = lines[i].match(/process\.env\.([A-Z][A-Z0-9_]*)/);
    if (bare && isServiceUrlKey(bare[1])) keys.add(bare[1]);
  }
  return { byFn, keys: [...keys].sort() };
}

/**
 * @param {string} text
 * @param {string} file
 * @param {{ namespace: string, logical_repo: string, source_revision: string }} meta
 * @param {{ contractKey: Function, normalizeHttpPath: Function, normalizeMethod: Function }} helpers
 */
export function extract(text, file, meta, helpers) {
  if (typeof text !== "string" || text === "") return [];
  const { contractKey, normalizeHttpPath, normalizeMethod } = helpers;
  const lines = text.split(/\r?\n/);
  const { byFn, keys } = collectBaseUrlBindings(lines);
  // A client library normally talks to exactly one service; when a single env
  // key is present it is the config binding for every call in the file.
  const soleKey = Object.values(byFn).length
    ? [...new Set(Object.values(byFn))]
    : [];
  const defaultKey = soleKey.length === 1 ? soleKey[0] : null;

  const facts = [];
  const base = {
    namespace: meta.namespace,
    logical_repo: meta.logical_repo,
    source_revision: meta.source_revision,
    trigger: "http-sync",
    interaction: "http",
    file,
  };

  for (const key of keys) {
    const line = lines.findIndex((l) => l.includes(`process.env.${key}`)) + 1;
    facts.push({
      ...base,
      kind: "config_binding",
      config_key: key,
      line: line || 1,
      evidence_snippet: (lines[(line || 1) - 1] || "").trim().slice(0, 200),
    });
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // call("POST", "/api/path", ...)
    for (const m of line.matchAll(/["']([A-Z]{3,7})["']\s*,\s*["'](\/[^"'`]+)["']/g)) {
      const verb = m[1].toUpperCase();
      if (!HTTP_VERBS.has(verb)) continue;
      pushCall(verb, m[2], i, line);
    }

    // xUrl() + "/api/path"
    for (const m of line.matchAll(/([A-Za-z_$][\w$]*)\s*\(\s*\)\s*\+\s*["'](\/[^"'`]+)["']/g)) {
      const key = byFn[m[1]];
      pushCall(inferVerb(lines, i), m[2], i, line, key);
    }
  }

  function pushCall(method, rawPath, index, line, explicitKey) {
    const path = normalizeHttpPath(rawPath);
    if (path.length < 4) return;
    const nm = normalizeMethod(method);
    const configKey = explicitKey || defaultKey;
    facts.push({
      ...base,
      kind: "http_outbound",
      method: nm,
      path,
      contract_key: contractKey(nm, path),
      ...(configKey ? { config_key: configKey } : {}),
      line: index + 1,
      evidence_snippet: line.trim().slice(0, 200),
    });
  }

  return facts;
}

/**
 * Best-effort verb when the call site does not spell it out.
 * Looks on the line itself, a little behind and a little ahead: the two shapes
 * in the wild are `fetch.post(url() + "/x", ...)` (same line) and
 * `var url = base() + "/x";` followed by `fetch.post(url, ...)` a few lines
 * later. Defaults to GET, which is the safe read-only assumption.
 */
function inferVerb(lines, i) {
  const order = [i];
  for (let d = 1; d <= 5; d += 1) {
    if (i + d < lines.length) order.push(i + d);
    if (i - d >= 0) order.push(i - d);
  }
  for (const j of order) {
    const m = lines[j].match(/fetch\.(get|post|put|patch|del|delete)\b/i);
    if (m) return m[1].toLowerCase() === "del" ? "DELETE" : m[1].toUpperCase();
  }
  return "GET";
}

export default { id, matches, extract, describes, collectBaseUrlBindings };
