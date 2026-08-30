/**
 * Dependency skills (third-party), Maven-style.
 *
 * skills.deps.json (repo root) declares external skill sources.
 * installDeps() clones each source (--depth 1) into a cache dir, copies the
 * listed skill folders into ~/.agents/skills/<name>, and drops a marker file
 * so uninstall only removes what we own.
 *
 * Best-effort by design: offline, missing repo or missing skill folder →
 * warn + skip; own skills install is never blocked by deps.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DEP_MARKER = "opencode-explorer-dep-owned:v1";
const CACHE_ROOT = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "opencode-explorer",
  "deps",
);

function packageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function manifestPath() {
  return resolve(packageRoot(), "..", "..", "skills.deps.json");
}

export function readManifest() {
  const p = manifestPath();
  if (!existsSync(p)) {
    return { version: 0, sources: [] };
  }
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  if (!Array.isArray(parsed.sources)) {
    throw new Error(`skills.deps.json: 'sources' must be an array`);
  }
  return parsed;
}

function agentSkillsRoot() {
  return join(process.env.HOME || homedir(), ".agents", "skills");
}

function shallowClone(name, repo, ref) {
  const dest = join(CACHE_ROOT, name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  const r = spawnSync(
    "git",
    ["clone", "--quiet", "--depth", "1", "--branch", ref, repo, dest],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(
      `git clone failed for ${name}: ${(r.stderr || r.stdout || "").trim()}`,
    );
  }
  return dest;
}

function copySkill(fromDir, skillName) {
  const dest = join(agentSkillsRoot(), skillName);
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(fromDir, dest, { recursive: true });
  writeFileSync(
    join(dest, `.${DEP_MARKER}`),
    JSON.stringify({ skill: skillName, installed_by: "opencode-explorer" }),
    "utf8",
  );
  return dest;
}

/**
 * @param {"install"|"status"|"uninstall"} action
 */
export async function runDeps(action) {
  const manifest = readManifest();
  /** @type {Record<string, unknown>} */
  const out = { manifest: manifestPath(), sources: [], ok: true };

  if (action === "status") {
    for (const src of manifest.sources) {
      const skills = (src.skills || []).map((s) => ({
        skill: s,
        installed: existsSync(join(agentSkillsRoot(), s)),
      }));
      out.sources.push({ name: src.name, repo: src.repo, skills });
    }
    return out;
  }

  if (action === "uninstall") {
    for (const src of manifest.sources) {
      const removed = [];
      for (const s of src.skills || []) {
        const dir = join(agentSkillsRoot(), s);
        if (existsSync(join(dir, `.${DEP_MARKER}`))) {
          rmSync(dir, { recursive: true, force: true });
          removed.push(dir);
        }
      }
      out.sources.push({ name: src.name, removed });
    }
    return out;
  }

  // install — best effort per source, never fatal for the whole run
  for (const src of manifest.sources) {
    /** @type {Record<string, unknown>} */
    const entry = { name: src.name, repo: src.repo, installed: [], skipped: [] };
    try {
      const cloneDir = shallowClone(src.name, src.repo, src.ref || "main");
      const candidates = [join(cloneDir, "skills"), cloneDir];
      for (const skillName of src.skills || []) {
        const found = candidates
          .map((c) => join(c, skillName))
          .find((p) => existsSync(join(p, "SKILL.md")));
        if (!found) {
          entry.skipped.push({ skill: skillName, reason: "not found in source" });
          continue;
        }
        entry.installed.push(copySkill(found, skillName));
      }
    } catch (e) {
      entry.error = e.message;
      out.ok = false;
    }
    out.sources.push(entry);
  }
  return out;
}

export { DEP_MARKER };
