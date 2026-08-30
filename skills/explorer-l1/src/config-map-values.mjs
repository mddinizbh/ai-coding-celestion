/**
 * Derived config-map from deploy-time config VALUES (application*.yml, bootstrap*, .env, *.env, application*.json).
 *
 * Scans the *working tree* (current files on disk, not git show) of each provided repo.
 * Extracts assignments where key matches URL|URI|HOST|ENDPOINT|BASE (case-insens) and value is a full http(s) URL.
 * Hostname is parsed; matched against the set of logical_repos by:
 *   - exact part match in dotted (.) hostname segments, or
 *   - after stripping exactly one environment segment (dev|stage|staging|prod|hml|qa).
 * Matches that hit 0 repos → silently dropped (localhost, IPs, unknown hosts are bad data, never wrong entries).
 * Matches that hit >1 repo → ambiguous, recorded in _gaps, never proposed.
 * Output is deterministic: same input file set → byte-identical JSON (keys sorted, gaps sorted).
 *
 * Derivation label: "deploy-file" (evidence from local profile = valid, env-agnostic mapping).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const ENV_SEGMENTS = new Set(["dev", "stage", "staging", "prod", "hml", "qa"]);
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "build",
  "dist",
  "out",
  ".gradle",
  "bin",
  "obj",
  ".idea",
  ".vscode",
]);

/**
 * @param {string} name
 */
function isConfigFileName(name) {
  return /^(application|bootstrap).*\.(yml|yaml|json)$/.test(name) ||
    name === ".env" ||
    /\.env$/.test(name);
}

/**
 * Line-oriented parser (no YAML/JSON libs). Catches common forms in Spring/Quarkus/.env/JSON.
 * @param {string} line
 * @returns {{key: string, value: string} | null}
 */
function parseConfigLine(line) {
  let content = line.trim();
  if (!content || content.startsWith("#") || content.startsWith("//")) return null;
  // drop inline comments
  content = content.replace(/\s+#.*$/, "").replace(/\s+\/\/.*$/, "");

  // key=value or key: value (with optional quotes around key/value) - tolerant of trailing , } etc
  let m = content.match(/^["']?([A-Z][A-Z0-9_]*?)["']?\s*[:=]\s*["']?(https?:\/\/[^"'\s,]+)["']?/i);
  if (m && /URL|URI|HOST|ENDPOINT|BASE/i.test(m[1])) {
    return { key: m[1].toUpperCase(), value: m[2] };
  }

  // JSON style "KEY": "https://..." (tolerant)
  m = content.match(/["']([A-Z][A-Z0-9_]*?)["']\s*:\s*["'](https?:\/\/[^"']+)["']/i);
  if (m && /URL|URI|HOST|ENDPOINT|BASE/i.test(m[1])) {
    return { key: m[1].toUpperCase(), value: m[2] };
  }

  // export KEY=... style
  m = content.match(/^export\s+["']?([A-Z][A-Z0-9_]*?)["']?\s*=\s*["']?(https?:\/\/[^"'\s]+)["']?/i);
  if (m && /URL|URI|HOST|ENDPOINT|BASE/i.test(m[1])) {
    return { key: m[1].toUpperCase(), value: m[2] };
  }

  return null;
}

/**
 * @param {string} hostname
 * @param {string[]} logicalRepos
 * @returns {string | "AMBIGUOUS" | null}
 */
function resolveLogicalRepo(hostname, logicalRepos) {
  if (!hostname) return null;
  const h = hostname.toLowerCase();
  if (/^localhost$|^127\.0\.0\.1$|^\[?::1\]?$/i.test(h) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    return null;
  }
  const parts = h.split(".");
  /** @type {Set<string>} */
  const matches = new Set();
  const lowerToOrig = new Map(logicalRepos.map((r) => [r.toLowerCase(), r]));

  for (const [lower, orig] of lowerToOrig) {
    if (parts.includes(lower) || h === lower) {
      matches.add(orig);
    }
  }

  // try stripping exactly one env segment from dotted parts
  for (const env of ENV_SEGMENTS) {
    const idx = parts.indexOf(env);
    if (idx !== -1) {
      const stripped = parts.slice(0, idx).concat(parts.slice(idx + 1));
      for (const [lower, orig] of lowerToOrig) {
        if (stripped.includes(lower) || stripped.join(".") === lower) {
          matches.add(orig);
        }
      }
    }
  }

  if (matches.size === 0) return null;
  if (matches.size > 1) return "AMBIGUOUS";
  return [...matches][0];
}

/**
 * Recursively find matching config files under root (skip ignored dirs).
 * @param {string} root
 * @returns {string[]}
 */
function findConfigFiles(root) {
  const results = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".env") continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && isConfigFileName(entry.name)) {
        results.push(full);
      }
    }
  }
  walk(root);
  return results.sort(); // stable order for determinism
}

/**
 * @param {{logical_repo: string, repo_path: string}[]} repos
 * @returns {{candidates: Array<{config_key:string, logical_repo:string, evidence:{file:string,line:number}, derivation:"deploy-file"}>, gaps: any[]}}
 */
export function extractConfigMapCandidates(repos) {
  if (!Array.isArray(repos) || repos.length === 0) {
    return { candidates: [], gaps: [] };
  }
  const allLogical = repos.map((r) => r.logical_repo);
  /** @type {Map<string, any>} */
  const byKey = new Map();
  /** @type {any[]} */
  const gaps = [];

  for (const { logical_repo: _srcRepo, repo_path } of repos) {
    const files = findConfigFiles(repo_path);
    for (const absFile of files) {
      let content;
      try {
        content = readFileSync(absFile, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const parsed = parseConfigLine(lines[i]);
        if (!parsed) continue;
        let hostname;
        try {
          const u = new URL(parsed.value);
          if (!/^https?:$/.test(u.protocol)) continue;
          hostname = u.hostname;
        } catch {
          continue;
        }
        const match = resolveLogicalRepo(hostname, allLogical);
        if (match === "AMBIGUOUS") {
          gaps.push({
            config_key: parsed.key,
            hostname,
            file: absFile,
            line: i + 1,
            reason: "hostname matches multiple logical_repos",
          });
          continue;
        }
        if (!match) continue;

        const evidenceFile = absFile.startsWith(repo_path)
          ? absFile.slice(repo_path.length + 1)
          : basename(absFile);
        const cand = {
          config_key: parsed.key,
          logical_repo: match,
          evidence: { file: evidenceFile, line: i + 1 },
          derivation: "deploy-file",
        };

        if (byKey.has(parsed.key)) {
          const prev = byKey.get(parsed.key);
          if (prev.logical_repo !== match) {
            gaps.push({
              config_key: parsed.key,
              reason: "conflicting target repos for same config_key",
            });
            byKey.delete(parsed.key);
            continue;
          }
        }
        byKey.set(parsed.key, cand);
      }
    }
  }

  const candidates = [...byKey.values()].sort((a, b) =>
    a.config_key < b.config_key ? -1 : a.config_key > b.config_key ? 1 : 0,
  );
  gaps.sort((a, b) => {
    const ka = a.config_key || "";
    const kb = b.config_key || "";
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return { candidates, gaps };
}

/**
 * Build the candidate JSON shape expected by propose-config-map.
 * @param {{candidates: any[], gaps: any[]}} derived
 * @param {string} system_namespace
 */
export function buildConfigMapCandidate(derived, system_namespace) {
  const _comment =
    `Derived config-map candidate for system "${system_namespace}". ` +
    `Each KEY in config_target_repo was extracted from a deploy config file (application*.yml/json, bootstrap*, .env). ` +
    `Review _provenance (evidence file:line) and _gaps (ambiguous hostnames) before copying to config/<system>.config-map.json. ` +
    `Mapping is environment-agnostic (who serves, not the host value).`;

  /** @type {Record<string, string>} */
  const config_target_repo = {};
  /** @type {Record<string, any>} */
  const _provenance = {};
  for (const c of derived.candidates) {
    config_target_repo[c.config_key] = c.logical_repo;
    _provenance[c.config_key] = {
      repo: c.logical_repo,
      evidence: c.evidence,
      derivation: c.derivation,
    };
  }

  return {
    _comment,
    config_target_repo,
    _provenance,
    _gaps: derived.gaps,
  };
}
