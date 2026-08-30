/**
 * Pinned Git object reader + source snapshots for Descobrir.
 * Reads committed bytes only (never dirty working-tree content).
 * All git invocations: argv array, shell:false, explicit cwd, timeout, bounded output.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { GitSourceError } from "./errors.mjs";

export { GitSourceError };

const HEX_RE = /^[a-f0-9]{7,64}$/;
/** Pathspec magic / shell-like / reserved characters never allowed in relative paths. */
const FORBIDDEN_PATH_CHARS = [
  "\\",
  "%",
  "?",
  "#",
  "@",
  "*",
  "[",
  "]",
  ":",
  "(",
  ")",
  "!",
  "'",
  '"',
  "`",
  ";",
  "|",
  "&",
  "$",
  "<",
  ">",
  "{",
  "}",
  "~",
];
const MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export const GIT_TIMEOUT_CODE = "GIT_TIMEOUT";
export const GIT_EXIT_CODE = "GIT_EXIT";

/**
 * @param {string} message
 * @param {{ cause?: unknown, code?: string, status?: number, stderr?: unknown }} [options]
 */
function fail(message, options = {}) {
  const err = new GitSourceError(message, options.cause !== undefined ? { cause: options.cause } : {});
  if (options.code) /** @type {any} */ (err).code = options.code;
  if (options.status !== undefined) /** @type {any} */ (err).status = options.status;
  if (options.stderr !== undefined) /** @type {any} */ (err).stderr = options.stderr;
  throw err;
}

/** @param {unknown} err */
export function isGitTimeoutError(err) {
  if (!(err instanceof GitSourceError)) return false;
  if (/** @type {any} */ (err).code === GIT_TIMEOUT_CODE) return true;
  return /timed out or was killed/i.test(err.message);
}

/** @param {unknown} value */
function describe(value) {
  if (typeof value === "string") {
    return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  }
  return String(value);
}

/**
 * @param {unknown} revision
 */
export function validateRevision(revision) {
  if (typeof revision !== "string" || !HEX_RE.test(revision)) {
    fail(`invalid revision (expected 7-64 lowercase hex chars): ${describe(revision)}`);
  }
}

/**
 * @param {unknown} relativePath
 */
export function validateRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath === "") {
    fail("path is empty");
  }
  if (relativePath.includes("\0")) {
    fail("path contains NUL");
  }
  if (relativePath[0] === "/") {
    fail("path must be relative (no leading slash)");
  }
  if (relativePath.startsWith(":(") || relativePath.includes(":(")) {
    fail("path contains Git pathspec magic");
  }
  for (const ch of FORBIDDEN_PATH_CHARS) {
    if (relativePath.includes(ch)) {
      fail(`path contains reserved '${ch}'`);
    }
  }
  for (const seg of relativePath.split("/")) {
    if (seg === "") {
      fail("path has empty segment (no '//' or trailing '/')");
    }
    if (seg === "." || seg === "..") {
      fail(`path has forbidden '${seg}' segment`);
    }
    if (/\s/.test(seg)) {
      fail("path contains whitespace");
    }
  }
}

/** @param {unknown} cwd */
function validateCwd(cwd) {
  if (typeof cwd !== "string" || cwd === "" || !isAbsolute(cwd)) {
    fail("cwd must be an absolute path");
  }
}

/**
 * @param {{ gitBin?: string }} [opts]
 */
function minimalEnv(opts = {}) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    ...(opts.gitBin ? {} : {}),
  };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ encoding?: 'utf8' | 'buffer', timeoutMs?: number, gitBin?: string }} [opts]
 */
export function runGit(cwd, args, opts = {}) {
  validateCwd(cwd);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const encoding = opts.encoding === "buffer" ? undefined : (opts.encoding ?? "utf8");
  const gitBin = typeof opts.gitBin === "string" && opts.gitBin !== "" ? opts.gitBin : "git";
  try {
    return execFileSync(gitBin, args, {
      cwd,
      env: minimalEnv(opts),
      shell: false,
      encoding,
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException & { status?: number, killed?: boolean, signal?: string, stderr?: unknown }} */ (
      err
    );
    if (e.killed || e.signal === "SIGTERM" || e.signal === "SIGKILL") {
      fail(`git timed out or was killed (timeoutMs=${timeoutMs})`, { code: GIT_TIMEOUT_CODE });
    }
    if (e.code === "ENOENT") {
      fail("git binary not found on PATH");
    }
    if (Number.isInteger(e.status) && e.status !== 0) {
      fail(`git ${args[0] ?? ""} failed (exit ${e.status})`, {
        code: GIT_EXIT_CODE,
        status: e.status,
        stderr: e.stderr,
      });
    }
    throw err;
  }
}

/** @param {unknown} err */
function isGitExitFailure(err) {
  return err instanceof GitSourceError && /** @type {any} */ (err).code === GIT_EXIT_CODE;
}

/**
 * Parse `git status --porcelain=v1` (path names only).
 * @param {string} output
 */
export function parsePorcelainStatus(output) {
  if (typeof output !== "string") {
    fail("parsePorcelainStatus input must be a string");
  }
  /** @type {{ xy: string, path: string, orig_path: string | null }[]} */
  const entries = [];
  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    let path = rest;
    /** @type {string | null} */
    let origPath = null;
    if (xy[0] === "R" || xy[0] === "C") {
      const arrow = rest.indexOf(" -> ");
      if (arrow !== -1) {
        origPath = rest.slice(0, arrow);
        path = rest.slice(arrow + 4);
      }
    }
    entries.push({ xy, path, orig_path: origPath });
  }
  return entries;
}

/**
 * @param {string} cwd
 * @param {{ timeoutMs?: number, gitBin?: string }} [opts]
 */
export function captureSourceStatusV2(cwd, opts = {}) {
  return String(runGit(cwd, ["status", "--porcelain=v2"], opts));
}

/**
 * @param {string} cwd
 * @param {{ timeoutMs?: number, gitBin?: string }} [opts]
 */
export function captureWorktreeList(cwd, opts = {}) {
  return String(runGit(cwd, ["worktree", "list", "--porcelain"], opts));
}

/**
 * Canonical absolute path for comparisons (resolves macOS /var → /private/var).
 * Works even when the leaf path does not exist yet (realpath of parent + basename).
 * @param {string} p
 */
export function canonicalizePath(p) {
  const abs = resolve(p).replace(/\/+$/, "");
  try {
    return realpathSync(abs).replace(/\/+$/, "");
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs)).replace(/\/+$/, "");
    } catch {
      return abs;
    }
  }
}

/**
 * True when porcelain worktree list mentions an absolute worktree path.
 * @param {string} listPorcelain
 * @param {string} worktreePath
 */
export function worktreeListMentionsPath(listPorcelain, worktreePath) {
  if (typeof listPorcelain !== "string" || typeof worktreePath !== "string") return false;
  const target = canonicalizePath(worktreePath);
  for (const line of listPorcelain.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const raw = line.slice("worktree ".length).trim();
    if (raw === "") continue;
    if (canonicalizePath(raw) === target) return true;
  }
  return false;
}

/**
 * @param {string} cwd
 * @param {string} revision
 * @param {{ timeoutMs?: number, gitBin?: string }} [opts]
 */
function assertCommitPresent(cwd, revision, opts = {}) {
  try {
    runGit(cwd, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], {
      ...opts,
      encoding: "utf8",
    });
  } catch (err) {
    if (isGitTimeoutError(err)) throw err;
    if (isGitExitFailure(err) || err instanceof GitSourceError) {
      fail(`revision object not present: ${revision}`, { cause: err });
    }
    throw err;
  }
}

/**
 * @param {string} cwd
 * @param {string} revision
 * @param {string} path
 * @param {{ timeoutMs?: number, gitBin?: string }} [opts]
 */
function assertRegularBlobAtRevision(cwd, revision, path, opts = {}) {
  let listing;
  try {
    listing = String(
      runGit(cwd, ["ls-tree", "-r", "--full-tree", revision, "--", path], {
        ...opts,
        encoding: "utf8",
      }),
    ).trim();
  } catch (err) {
    if (isGitTimeoutError(err)) throw err;
    if (isGitExitFailure(err) || err instanceof GitSourceError) {
      fail(`path not present at revision: ${path}`, { cause: err });
    }
    throw err;
  }
  if (listing === "") {
    fail(`path not present at revision: ${path}`);
  }
  const lines = listing.split("\n").filter((l) => l.endsWith(`\t${path}`) || l.endsWith(` ${path}`));
  const line = lines[0] ?? listing.split("\n")[0];
  const mode = line.slice(0, 6);
  if (mode === "120000") {
    fail(`path is a symlink at revision (refusing to follow): ${path}`);
  }
  if (mode === "040000") {
    fail(`path is a tree at revision (file required): ${path}`);
  }
  if (mode !== "100644" && mode !== "100755") {
    fail(`path has unsupported git mode ${mode} at revision: ${path}`);
  }
}

/**
 * @param {{ cwd: string, revision: string, path: string, timeoutMs?: number, gitBin?: string }} args
 * @returns {Buffer}
 */
export function readAtRevision({ cwd, revision, path, timeoutMs, gitBin }) {
  validateCwd(cwd);
  validateRevision(revision);
  validateRelativePath(path);
  const opts = { timeoutMs, gitBin };
  assertCommitPresent(cwd, revision, opts);
  assertRegularBlobAtRevision(cwd, revision, path, opts);
  try {
    const bytes = runGit(cwd, ["show", `${revision}:${path}`], {
      ...opts,
      encoding: "buffer",
    });
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  } catch (err) {
    if (isGitTimeoutError(err)) throw err;
    if (err instanceof GitSourceError) {
      fail(`git show failed for ${revision}:${path}`, { cause: err });
    }
    throw err;
  }
}

/**
 * @param {string} cwd
 * @param {{ timeoutMs?: number, gitBin?: string }} [opts]
 * @returns {(args: { revision: string, path: string }) => Buffer}
 */
export function bindReadAtRevision(cwd, opts = {}) {
  validateCwd(cwd);
  return ({ revision, path }) =>
    readAtRevision({ cwd, revision, path, timeoutMs: opts.timeoutMs, gitBin: opts.gitBin });
}

/** @param {string} text */
function countNonEmpty(text) {
  let count = 0;
  for (const line of text.split("\n")) {
    if (line !== "") count += 1;
  }
  return count;
}

/**
 * @param {boolean} anchorObjectPresent
 * @param {number} trackedFileCount
 * @param {string[]} dirtyNames
 */
function summaryHash(anchorObjectPresent, trackedFileCount, dirtyNames) {
  const payload = JSON.stringify({
    anchor_object_present: anchorObjectPresent,
    tracked_file_count: trackedFileCount,
    dirty_names: dirtyNames,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * @param {{ cwd: string, anchorRevision: string, timeoutMs?: number, gitBin?: string }} args
 */
export function repositorySnapshot({ cwd, anchorRevision, timeoutMs, gitBin }) {
  validateCwd(cwd);
  validateRevision(anchorRevision);
  const opts = { timeoutMs, gitBin };
  let anchorObjectPresent = true;
  try {
    assertCommitPresent(cwd, anchorRevision, opts);
  } catch (err) {
    if (isGitTimeoutError(err)) throw err;
    if (err instanceof GitSourceError) {
      anchorObjectPresent = false;
    } else {
      throw err;
    }
  }
  const tracked = String(runGit(cwd, ["ls-files"], { ...opts, encoding: "utf8" }));
  const trackedFileCount = countNonEmpty(tracked);
  const status = String(runGit(cwd, ["status", "--porcelain=v1"], { ...opts, encoding: "utf8" }));
  const entries = parsePorcelainStatus(status);
  // Normalize Git's trailing slash on untracked directories so mutation_pre validates.
  const dirtyNames = entries.map((e) => e.path.replace(/\/+$/, "")).filter((p) => p !== "").sort();
  return {
    anchor_object_present: anchorObjectPresent,
    tracked_file_count: trackedFileCount,
    dirty_path_count: entries.length,
    dirty_names: dirtyNames,
    summary_hash: summaryHash(anchorObjectPresent, trackedFileCount, dirtyNames),
  };
}
