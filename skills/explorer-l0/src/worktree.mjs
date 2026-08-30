/**
 * Isolated detached Git worktree lifecycle for Descobrir runs.
 * Creates worktrees only under the caller-provided run root; always remove/prune in finally.
 * Never clean/reset/stash the source working tree.
 *
 * Cleanup always verifies the target path is absent from `git worktree list --porcelain`.
 * If git remove/prune hang or fail, a deterministic admin-dir recovery is attempted; a
 * degraded cleanup never reports lifecycle success.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve, dirname } from "node:path";

import { WorktreeError } from "./errors.mjs";
import {
  GitSourceError,
  canonicalizePath,
  captureSourceStatusV2,
  captureWorktreeList,
  isGitTimeoutError,
  repositorySnapshot,
  runGit,
  validateRevision,
  worktreeListMentionsPath,
} from "./git-reader.mjs";

export { WorktreeError };

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @param {string} message
 * @param {{ cause?: unknown }} [options]
 */
function fail(message, options = {}) {
  throw new WorktreeError(message, options);
}

/** @param {unknown} value @param {string} label */
function requireAbsolute(value, label) {
  if (typeof value !== "string" || value === "" || !isAbsolute(value)) {
    fail(`${label} must be an absolute path`);
  }
}

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    fail("worktree operation aborted", { cause: signal.reason });
  }
}

/**
 * @param {string} repoPath
 * @param {{ timeoutMs?: number, gitBin?: string }} opts
 */
function gitCommonDir(repoPath, opts) {
  const raw = String(runGit(repoPath, ["rev-parse", "--git-common-dir"], opts)).trim();
  return isAbsolute(raw) ? raw : resolve(repoPath, raw);
}

/**
 * Deterministic recovery: drop worktree admin entries that point at worktreePath.
 * Does not use `worktree remove` / `worktree prune`.
 * @param {string} repoPath
 * @param {string} worktreePath
 * @param {{ timeoutMs?: number, gitBin?: string }} opts
 */
function forceUnregisterWorktree(repoPath, worktreePath, opts) {
  const target = canonicalizePath(worktreePath);
  try {
    rmSync(worktreePath, { recursive: true, force: true });
  } catch {
    // continue — admin cleanup still required
  }

  const common = gitCommonDir(repoPath, opts);
  const adminRoot = join(common, "worktrees");
  if (!existsSync(adminRoot)) return;

  for (const name of readdirSync(adminRoot)) {
    const entryDir = join(adminRoot, name);
    const gitdirFile = join(entryDir, "gitdir");
    if (!existsSync(gitdirFile)) continue;
    let gitdirRaw;
    try {
      gitdirRaw = readFileSync(gitdirFile, "utf8").trim();
    } catch {
      continue;
    }
    // gitdir points at <worktree>/.git (file or dir)
    const wtGitRaw = isAbsolute(gitdirRaw) ? gitdirRaw : resolve(entryDir, gitdirRaw);
    const wtPath = canonicalizePath(dirname(wtGitRaw));
    const wtGit = canonicalizePath(wtGitRaw);
    if (wtPath === target || wtGit === target) {
      rmSync(entryDir, { recursive: true, force: true });
    }
  }
}

/**
 * Ensure worktree path is unregistered and absent from disk.
 * @param {string} repoPath
 * @param {string} worktreePath
 * @param {{ timeoutMs?: number, gitBin?: string, rejectDegraded?: boolean }} opts
 * @returns {{ degraded: boolean }}
 */
export function ensureWorktreeAbsent(repoPath, worktreePath, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gitOpts = { timeoutMs, gitBin: opts.gitBin };
  const rejectDegraded = opts.rejectDegraded === true;
  let degraded = false;
  /** @type {unknown} */
  let lastErr = undefined;

  try {
    runGit(repoPath, ["worktree", "remove", "--force", worktreePath], {
      ...gitOpts,
      encoding: "utf8",
    });
  } catch (err) {
    lastErr = err;
    if (isGitTimeoutError(err) || err instanceof GitSourceError) {
      degraded = true;
    }
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  try {
    runGit(repoPath, ["worktree", "prune", "--expire", "now"], {
      ...gitOpts,
      encoding: "utf8",
    });
  } catch (err) {
    lastErr = err;
    if (isGitTimeoutError(err) || err instanceof GitSourceError) {
      degraded = true;
    }
  }

  try {
    rmSync(worktreePath, { recursive: true, force: true });
  } catch {
    // ignore
  }

  let list = captureWorktreeList(repoPath, gitOpts);
  if (worktreeListMentionsPath(list, worktreePath) || existsSync(worktreePath)) {
    degraded = true;
    try {
      forceUnregisterWorktree(repoPath, worktreePath, gitOpts);
    } catch (err) {
      fail(`worktree force-unregister failed for ${worktreePath}`, { cause: err });
    }
    list = captureWorktreeList(repoPath, gitOpts);
  }

  if (worktreeListMentionsPath(list, worktreePath)) {
    fail(`worktree still registered after cleanup: ${worktreePath}`, { cause: lastErr });
  }
  if (existsSync(worktreePath)) {
    fail(`worktree path still exists after cleanup: ${worktreePath}`, { cause: lastErr });
  }

  if (degraded && rejectDegraded) {
    fail(
      `worktree cleanup required force recovery after git remove/prune failure or timeout: ${worktreePath}`,
      { cause: lastErr },
    );
  }

  return { degraded };
}

/**
 * Create a detached worktree at an exact commit under runRoot, run callback, always clean up.
 *
 * @param {object} args
 * @param {string} args.repoPath
 * @param {string} args.revision
 * @param {string} args.runRoot
 * @param {(ctx: { worktreePath: string, signal?: AbortSignal }) => unknown | Promise<unknown>} args.callback
 * @param {AbortSignal} [args.signal]
 * @param {number} [args.timeoutMs]
 * @param {string} [args.worktreeId]
 * @param {string} [args.gitBin]
 */
export async function withDetachedWorktree({
  repoPath,
  revision,
  runRoot,
  callback,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  worktreeId,
  gitBin,
}) {
  requireAbsolute(repoPath, "repoPath");
  requireAbsolute(runRoot, "runRoot");
  if (typeof callback !== "function") {
    fail("callback must be a function");
  }
  try {
    validateRevision(revision);
  } catch (err) {
    if (err instanceof GitSourceError) {
      fail(err.message, { cause: err });
    }
    throw err;
  }

  throwIfAborted(signal);

  const opts = { timeoutMs, gitBin };
  const resolvedRepo = resolve(repoPath);
  const resolvedRun = resolve(runRoot);
  mkdirSync(resolvedRun, { recursive: true, mode: 0o700 });

  const id =
    typeof worktreeId === "string" && worktreeId !== ""
      ? worktreeId
      : `wt-${revision.slice(0, 12)}-${process.pid}-${Date.now().toString(36)}`;
  if (id.includes("..") || id.includes("/") || id.includes("\\")) {
    fail("worktreeId must be a single path segment");
  }
  const worktreePath = join(resolvedRun, id);
  if (!worktreePath.startsWith(resolvedRun + "/") && worktreePath !== resolvedRun) {
    fail("worktree path escaped runRoot");
  }

  const sourceStatusPre = captureSourceStatusV2(resolvedRepo, opts);
  const worktreeListPre = captureWorktreeList(resolvedRepo, opts);
  const preSnap = repositorySnapshot({
    cwd: resolvedRepo,
    anchorRevision: revision,
    timeoutMs,
    gitBin,
  });

  // Clear any stale registration/path at the target before create (allow force recovery).
  ensureWorktreeAbsent(resolvedRepo, worktreePath, { ...opts, rejectDegraded: false });

  let created = false;
  /** @type {unknown} */
  let callbackError = undefined;
  /** @type {unknown} */
  let result = undefined;

  try {
    throwIfAborted(signal);
    try {
      runGit(resolvedRepo, ["worktree", "add", "--detach", worktreePath, revision], {
        ...opts,
        encoding: "utf8",
      });
      created = true;
    } catch (err) {
      ensureWorktreeAbsent(resolvedRepo, worktreePath, { ...opts, rejectDegraded: false });
      if (err instanceof GitSourceError) {
        fail(`failed to create detached worktree at revision: ${err.message}`, { cause: err });
      }
      throw err;
    }

    throwIfAborted(signal);

    try {
      result = await Promise.resolve(callback({ worktreePath, signal }));
    } catch (err) {
      callbackError = err;
    }

    // Cleanup always; post-callback cleanup rejects degraded recovery (never silent success).
    try {
      ensureWorktreeAbsent(resolvedRepo, worktreePath, { ...opts, rejectDegraded: true });
      created = false;
    } catch (cleanupErr) {
      created = false;
      if (callbackError !== undefined) {
        const msg =
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        fail(`worktree cleanup failed after callback error: ${msg}`, {
          cause: callbackError,
        });
      }
      throw cleanupErr;
    }

    if (callbackError !== undefined) {
      if (callbackError instanceof Error && callbackError.name === "AbortError") {
        fail("worktree callback aborted", { cause: callbackError });
      }
      throw callbackError;
    }

    throwIfAborted(signal);

    const sourceStatusPost = captureSourceStatusV2(resolvedRepo, opts);
    const worktreeListPost = captureWorktreeList(resolvedRepo, opts);
    if (worktreeListMentionsPath(worktreeListPost, worktreePath)) {
      fail(`worktree still registered after successful cleanup verify: ${worktreePath}`);
    }
    const postSnap = repositorySnapshot({
      cwd: resolvedRepo,
      anchorRevision: revision,
      timeoutMs,
      gitBin,
    });

    return {
      result,
      worktreePath,
      mutation: {
        pre: preSnap,
        post: postSnap,
        equivalent:
          preSnap.summary_hash === postSnap.summary_hash &&
          sourceStatusPre === sourceStatusPost &&
          worktreeListPre === worktreeListPost,
      },
      sourceStatusPre,
      sourceStatusPost,
      worktreeListPre,
      worktreeListPost,
    };
  } catch (err) {
    if (created) {
      try {
        ensureWorktreeAbsent(resolvedRepo, worktreePath, { ...opts, rejectDegraded: false });
      } catch {
        // preserve original err
      }
    }
    throw err;
  }
}
