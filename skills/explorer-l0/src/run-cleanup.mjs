/**
 * Run status and cleanup for the Descobrir cache.
 *
 * Lists and removes run roots under the XDG cache `descobrir/runs/` directory.
 * Never touches SQLite candidates: cleanup only removes run scratch space and
 * any leftover worktree subdirectories. Worktree unregister via the existing
 * worktree helpers is best-effort and only attempted when a source repo path is
 * supplied (the descriptor does not persist project_path by design).
 *
 * Output objects never include absolute paths; callers render results.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { DescobrirError } from "./errors.mjs";
import { compareCodeUnits } from "./explorer-payload-shape.mjs";
import { RUN_PATHS } from "./run-descriptor-shape.mjs";
import { confinePath } from "./runtime-layout.mjs";

export class RunCleanupError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "RunCleanupError";
  }
}

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
const WORKTREE_PREFIX = "wt-";

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new RunCleanupError(message);
}

/**
 * @param {string} runsDir
 */
function requireRunsDir(runsDir) {
  if (typeof runsDir !== "string" || runsDir === "") {
    fail("runs_dir must be a non-empty string");
  }
  return resolve(runsDir);
}

/**
 * @param {string} runId
 */
function requireRunId(runId) {
  if (typeof runId !== "string" || runId === "" || !RUN_ID_RE.test(runId)) {
    fail("run_id must be a single safe token");
  }
  return runId;
}

/**
 * Read descriptor if present and not a symlink; return null otherwise.
 * Returns only the parsed JSON when it has a usable chunk_index; never throws.
 * @param {string} runRoot
 * @returns {object | null}
 */
function readDescriptorIfPresent(runRoot) {
  const descPath = join(runRoot, RUN_PATHS.descriptor);
  if (!existsSync(descPath)) return null;
  let st;
  try {
    st = lstatSync(descPath);
  } catch {
    return null;
  }
  if (!st.isFile() || st.isSymbolicLink()) return null;
  try {
    const parsed = JSON.parse(readFileSync(descPath, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.chunk_index?.chunks)
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Best-effort: list worktree subdirectories under a run root.
 * @param {string} runRoot
 * @returns {string[]} absolute paths
 */
function listWorktreeSubdirs(runRoot) {
  if (!existsSync(runRoot)) return [];
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = readdirSync(runRoot);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (!name.startsWith(WORKTREE_PREFIX)) continue;
    const abs = join(runRoot, name);
    try {
      if (lstatSync(abs).isDirectory()) out.push(abs);
    } catch {
      // ignore unreadable entry
    }
  }
  return out;
}

/**
 * Force-remove a worktree subdirectory; if sourceRepo provided, attempt
 * ensureWorktreeAbsent first (which uses `git worktree remove/prune` and
 * admin-dir recovery) and fall back to rmSync.
 *
 * @param {string} worktreePath absolute
 * @param {string | undefined} sourceRepo absolute repo path or undefined
 * @param {{ ensureWorktreeAbsent?: (repo: string, path: string, opts?: object) => { degraded: boolean } }} [injected]
 * @returns {{ removed: boolean, via: "git" | "rm" | "none" }}
 */
function removeWorktreeLeftover(worktreePath, sourceRepo, injected) {
  if (!existsSync(worktreePath)) {
    return { removed: false, via: "none" };
  }
  if (sourceRepo && injected?.ensureWorktreeAbsent) {
    try {
      injected.ensureWorktreeAbsent(sourceRepo, worktreePath, {
        rejectDegraded: false,
      });
      if (!existsSync(worktreePath)) {
        return { removed: true, via: "git" };
      }
    } catch {
      // fall through to rm
    }
  }
  try {
    rmSync(worktreePath, { recursive: true, force: true });
    return { removed: !existsSync(worktreePath), via: "rm" };
  } catch {
    return { removed: !existsSync(worktreePath), via: "rm" };
  }
}

/**
 * @param {string} runRoot
 * @param {object | null} descriptor
 * @returns {{ expected: number, present: number }}
 */
function countPayloads(runRoot, descriptor) {
  const chunks = descriptor?.chunk_index?.chunks ?? [];
  const expected = chunks.length;
  const dir = join(runRoot, RUN_PATHS.explorerPayloads);
  if (!existsSync(dir)) return { expected, present: 0 };
  let present = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        if (lstatSync(join(dir, name)).isFile()) present += 1;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return { expected, present };
}

/**
 * @param {string} runRoot
 * @returns {number} age in ms from directory mtime to now
 */
function ageMs(runRoot) {
  try {
    const mtime = statSync(runRoot).mtimeMs;
    return Math.max(0, Date.now() - mtime);
  } catch {
    return 0;
  }
}

/**
 * Classify a run state from descriptor presence and payload completeness.
 * @param {object | null} descriptor
 * @param {{ expected: number, present: number }} payloads
 * @returns {"prepared" | "incomplete" | "unknown"}
 */
function classifyState(descriptor, payloads) {
  if (descriptor === null) return "incomplete";
  if (payloads.expected === 0) return "prepared";
  if (payloads.present >= payloads.expected) return "prepared";
  return "incomplete";
}

/**
 * List run roots under runsDir with sanitized (path-free) summaries.
 *
 * @param {string} runsDir absolute path to descobrir/runs/
 * @returns {{
 *   runs_dir_present: boolean,
 *   runs: Array<{
 *     run_id: string,
 *     state: "prepared" | "incomplete" | "unknown",
 *     expected_payloads: number | null,
 *     present_payloads: number | null,
 *     age_ms: number,
 *   }>,
 * }}
 */
export function listRuns(runsDir) {
  const root = requireRunsDir(runsDir);
  if (!existsSync(root)) {
    return { runs_dir_present: false, runs: [] };
  }
  let entries;
  try {
    entries = readdirSync(root);
  } catch (err) {
    fail(`failed to read runs dir: ${err instanceof Error ? err.message : String(err)}`);
  }
  /** @type {ReturnType<typeof listRuns>["runs"]} */
  const runs = [];
  for (const name of entries) {
    if (!RUN_ID_RE.test(name)) continue;
    const runRoot = join(root, name);
    try {
      confinePath(runRoot, root, `run_root '${name}'`);
    } catch {
      continue;
    }
    let st;
    try {
      st = lstatSync(runRoot);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    const descriptor = readDescriptorIfPresent(runRoot);
    const payloads = countPayloads(runRoot, descriptor);
    runs.push({
      run_id: name,
      state: classifyState(descriptor, payloads),
      expected_payloads: descriptor ? payloads.expected : null,
      present_payloads: descriptor ? payloads.present : null,
      age_ms: ageMs(runRoot),
    });
  }
  runs.sort((a, b) => compareCodeUnits(a.run_id, b.run_id));
  return { runs_dir_present: true, runs };
}

/**
 * Remove a specific run root by id; refuses a prepared run unless `force`.
 *
 * @param {string} runsDir
 * @param {string} runId
 * @param {{
 *   force?: boolean,
 *   sourceRepo?: string,
 *   ensureWorktreeAbsent?: (repo: string, path: string, opts?: object) => { degraded: boolean },
 * }} [options]
 * @returns {{
 *   removed: boolean,
 *   run_id: string,
 *   state: "prepared" | "incomplete" | "unknown",
 *   reason?: string,
 *   worktrees_removed: number,
 * }}
 */
export function cleanupRun(runsDir, runId, options = {}) {
  const root = requireRunsDir(runsDir);
  const id = requireRunId(runId);
  const runRoot = join(root, id);
  if (!existsSync(runRoot)) {
    return {
      removed: false,
      run_id: id,
      state: "unknown",
      reason: "run_root absent",
      worktrees_removed: 0,
    };
  }
  try {
    confinePath(runRoot, root, "run_root");
  } catch (err) {
    fail(`run_root confinement failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const descriptor = readDescriptorIfPresent(runRoot);
  const payloads = countPayloads(runRoot, descriptor);
  const state = classifyState(descriptor, payloads);

  if (state === "prepared" && options.force !== true) {
    return {
      removed: false,
      run_id: id,
      state,
      reason: "run is prepared; pass --force to remove",
      worktrees_removed: 0,
    };
  }

  // Worktree subdirs first so the run root can be removed cleanly afterwards.
  const worktrees = listWorktreeSubdirs(runRoot);
  let worktreesRemoved = 0;
  for (const wt of worktrees) {
    const res = removeWorktreeLeftover(wt, options.sourceRepo, options);
    if (res.removed) worktreesRemoved += 1;
  }

  try {
    rmSync(runRoot, { recursive: true, force: true });
  } catch (err) {
    fail(`failed to remove run root '${id}': ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    removed: !existsSync(runRoot),
    run_id: id,
    state,
    worktrees_removed: worktreesRemoved,
  };
}

/**
 * Remove all incomplete runs; optionally also prepared ones with `force`.
 *
 * @param {string} runsDir
 * @param {{
 *   force?: boolean,
 *   sourceRepo?: string,
 *   ensureWorktreeAbsent?: (repo: string, path: string, opts?: object) => { degraded: boolean },
 * }} [options]
 * @returns {{
 *   removed: Array<{ run_id: string, state: string, worktrees_removed: number }>,
 *   skipped: Array<{ run_id: string, state: string, reason: string }>,
 * }}
 */
export function cleanupStaleRuns(runsDir, options = {}) {
  const listing = listRuns(runsDir);
  /** @type {Array<{ run_id: string, state: string, worktrees_removed: number }>} */
  const removed = [];
  /** @type {Array<{ run_id: string, state: string, reason: string }>} */
  const skipped = [];
  for (const run of listing.runs) {
    if (run.state === "incomplete") {
      const res = cleanupRun(runsDir, run.run_id, options);
      if (res.removed) {
        removed.push({
          run_id: res.run_id,
          state: res.state,
          worktrees_removed: res.worktrees_removed,
        });
      } else {
        skipped.push({
          run_id: res.run_id,
          state: res.state,
          reason: res.reason ?? "not removed",
        });
      }
    } else if (run.state === "prepared" && options.force === true) {
      const res = cleanupRun(runsDir, run.run_id, { ...options, force: true });
      if (res.removed) {
        removed.push({
          run_id: res.run_id,
          state: res.state,
          worktrees_removed: res.worktrees_removed,
        });
      } else {
        skipped.push({
          run_id: res.run_id,
          state: res.state,
          reason: res.reason ?? "not removed",
        });
      }
    } else if (run.state === "prepared") {
      skipped.push({
        run_id: run.run_id,
        state: run.state,
        reason: "run is prepared; pass --force to remove",
      });
    }
  }
  return { removed, skipped };
}
