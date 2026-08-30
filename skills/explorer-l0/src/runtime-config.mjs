/**
 * Runtime config resolution for Descobrir operational runs.
 * No filesystem writes (layout is separate). Machine paths stay out of package_intent.
 * Omitted source_revision is resolved to exact Git HEAD of project_path via argv-only git.
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

import { DescobrirError } from "./errors.mjs";

export class RuntimeConfigError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

const REVISION_RE = /^[a-f0-9]{7,64}$/;
const PLACEHOLDER_RE = /<[^\n>]*>/;
const THRESHOLD_REQUIRE_FLAGS = [
  "require_schema_valid",
  "require_repeatability_pass",
  "require_mutation_equivalent",
  "require_producer_reconciliation_pass",
];
const THRESHOLD_FIELDS = [
  "minimum_repository_verified_percentage",
  ...THRESHOLD_REQUIRE_FLAGS,
];

/**
 * @param {string} reason
 * @returns {never}
 */
function fail(reason) {
  throw new RuntimeConfigError(reason);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value === "") {
    fail(`${label} must be a non-empty string`);
  }
}

/**
 * Single-token canonical form for namespace / logical_repo.
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
export function validateSingleToken(value, label) {
  requireNonEmptyString(value, label);
  const s = /** @type {string} */ (value);
  if (s.includes("\0")) {
    fail(`${label} contains NUL`);
  }
  if (/[@\/\s\\]/.test(s)) {
    fail(`${label} must be a single token (no '@', '/', '\\', whitespace)`);
  }
  if (s === "." || s === "..") {
    fail(`${label} must not be '.' or '..'`);
  }
  if (s.includes("..")) {
    fail(`${label} must not contain '..'`);
  }
  return s;
}

/**
 * @param {unknown} rev
 * @returns {string}
 */
function validateRevision(rev) {
  requireNonEmptyString(rev, "source_revision");
  const s = /** @type {string} */ (rev);
  if (PLACEHOLDER_RE.test(s)) {
    fail("source_revision must not be an unresolved placeholder");
  }
  if (!REVISION_RE.test(s)) {
    fail("source_revision must be 7-64 lowercase hex chars");
  }
  return s;
}

/**
 * @param {unknown} threshold
 * @returns {typeof threshold extends object ? object : never}
 */
function validateThreshold(threshold) {
  if (typeof threshold !== "object" || threshold === null || Array.isArray(threshold)) {
    fail("threshold must be an object");
  }
  const t = /** @type {Record<string, unknown>} */ (threshold);
  for (const field of THRESHOLD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(t, field)) {
      fail(`threshold missing required field '${field}'`);
    }
  }
  for (const key of Object.keys(t)) {
    if (!THRESHOLD_FIELDS.includes(key)) {
      fail(`threshold has unknown property '${key}'`);
    }
  }
  const min = t.minimum_repository_verified_percentage;
  if (typeof min !== "number" || !Number.isFinite(min) || min < 0 || min > 100) {
    fail("threshold.minimum_repository_verified_percentage must be a finite number in [0, 100]");
  }
  for (const flag of THRESHOLD_REQUIRE_FLAGS) {
    if (typeof t[flag] !== "boolean") {
      fail(`threshold.${flag} must be a boolean`);
    }
  }
  return {
    minimum_repository_verified_percentage: min,
    require_schema_valid: /** @type {boolean} */ (t.require_schema_valid),
    require_repeatability_pass: /** @type {boolean} */ (t.require_repeatability_pass),
    require_mutation_equivalent: /** @type {boolean} */ (t.require_mutation_equivalent),
    require_producer_reconciliation_pass: /** @type {boolean} */ (
      t.require_producer_reconciliation_pass
    ),
  };
}

/**
 * Reject path strings with traversal segments before resolution.
 * @param {string} p
 * @param {string} label
 */
function assertNoTraversalSegments(p, label) {
  if (p.includes("\0")) {
    fail(`${label} contains NUL`);
  }
  const normalized = normalize(p);
  const parts = normalized.split(/[/\\]/);
  for (const part of parts) {
    if (part === "..") {
      fail(`${label} must not contain '..' segments`);
    }
  }
}

/**
 * @param {string | undefined} home
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {string}
 */
function resolveHome(home, env) {
  if (typeof home === "string" && home !== "") {
    return home;
  }
  const fromEnv = env.HOME;
  if (typeof fromEnv === "string" && fromEnv !== "") {
    return fromEnv;
  }
  return homedir();
}

/**
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @param {string} home
 * @returns {{ dataHome: string, cacheHome: string }}
 */
function resolveXdgHomes(env, home) {
  const dataHome =
    typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME !== ""
      ? env.XDG_DATA_HOME
      : join(home, ".local", "share");
  const cacheHome =
    typeof env.XDG_CACHE_HOME === "string" && env.XDG_CACHE_HOME !== ""
      ? env.XDG_CACHE_HOME
      : join(home, ".cache");
  if (!isAbsolute(dataHome)) {
    fail("XDG_DATA_HOME must be absolute when set");
  }
  if (!isAbsolute(cacheHome)) {
    fail("XDG_CACHE_HOME must be absolute when set");
  }
  assertNoTraversalSegments(dataHome, "XDG_DATA_HOME");
  assertNoTraversalSegments(cacheHome, "XDG_CACHE_HOME");
  return { dataHome, cacheHome };
}

/**
 * @param {unknown} db
 * @param {string} namespace
 * @param {string} dataHome
 * @returns {string}
 */
function resolveDbPath(db, namespace, dataHome) {
  if (db === undefined || db === null) {
    return join(dataHome, "descobrir", `${namespace}.sqlite`);
  }
  requireNonEmptyString(db, "db");
  const raw = /** @type {string} */ (db);
  assertNoTraversalSegments(raw, "db");
  if (!isAbsolute(raw)) {
    // Relative overrides are rejected when they escape (any '..') or as a class:
    // operational DB override must be absolute to avoid cwd-relative surprises.
    fail("db override must be an absolute path (relative overrides are rejected)");
  }
  return resolve(raw);
}

/**
 * @param {unknown} obsidianRoot
 * @returns {string | undefined}
 */
function resolveObsidianRoot(obsidianRoot) {
  if (obsidianRoot === undefined || obsidianRoot === null) {
    return undefined;
  }
  requireNonEmptyString(obsidianRoot, "obsidian_root");
  const raw = /** @type {string} */ (obsidianRoot);
  assertNoTraversalSegments(raw, "obsidian_root");
  if (!isAbsolute(raw)) {
    fail("obsidian_root must be an absolute path");
  }
  return resolve(raw);
}

/**
 * @param {unknown} projectPath
 * @returns {string}
 */
function resolveProjectPath(projectPath) {
  requireNonEmptyString(projectPath, "project_path");
  const raw = /** @type {string} */ (projectPath);
  if (raw.includes("\0")) {
    fail("project_path contains NUL");
  }
  if (!isAbsolute(raw)) {
    fail("project_path must be an absolute path");
  }
  return resolve(raw);
}

/**
 * @returns {string}
 */
function defaultRunId() {
  const now = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${now}-${rand}`;
}

const GIT_HEAD_TIMEOUT_MS = 15_000;
const GIT_HEAD_MAX_BUFFER = 64 * 1024;

/**
 * Resolve exact current HEAD SHA for project_path.
 * argv-only (`git -C <path> rev-parse HEAD`), shell:false, bounded I/O.
 * Does not read dirty working-tree file bytes — only the commit object name.
 *
 * @param {string} projectPath absolute project path
 * @returns {string} lowercase hex SHA (7-64)
 */
export function resolveGitHead(projectPath) {
  requireNonEmptyString(projectPath, "project_path");
  if (!isAbsolute(projectPath)) {
    fail("project_path must be an absolute path");
  }

  let result;
  try {
    result = spawnSync("git", ["-C", projectPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      shell: false,
      timeout: GIT_HEAD_TIMEOUT_MS,
      maxBuffer: GIT_HEAD_MAX_BUFFER,
      windowsHide: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`failed to resolve source_revision from git: ${msg}`);
  }

  if (result.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
    if (code === "ETIMEDOUT" || result.signal === "SIGTERM") {
      fail("failed to resolve source_revision from git: timed out resolving HEAD");
    }
    fail(`failed to resolve source_revision from git: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    const detail = (stderr || stdout || `exit ${result.status}`).slice(0, 400);
    fail(`failed to resolve source_revision from git: not a git repository or HEAD unavailable (${detail})`);
  }

  const head = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (head === "") {
    fail("failed to resolve source_revision from git: empty HEAD");
  }
  // validateRevision enforces hex shape; keep message git-oriented on failure.
  try {
    return validateRevision(head);
  } catch {
    fail(`failed to resolve source_revision from git: unexpected HEAD value`);
  }
}

/**
 * Resolve operational runtime config without creating directories or files.
 * When source_revision is omitted, resolves Git HEAD of project_path automatically.
 *
 * @param {{
 *   namespace: string,
 *   logical_repo: string,
 *   project_path: string,
 *   source_revision?: string,
 *   threshold?: object,
 *   db?: string,
 *   obsidian_root?: string,
 *   run_id?: string,
 * }} input
 * @param {{
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   home?: string,
 *   createRunId?: () => string,
 *   resolveHead?: (projectPath: string) => string,
 * }} [options]
 */
export function resolveRuntimeConfig(input, options = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("input must be an object");
  }

  const env = options.env ?? process.env;
  const home = resolveHome(options.home, env);
  const { dataHome, cacheHome } = resolveXdgHomes(env, home);

  const namespace = validateSingleToken(input.namespace, "namespace");
  const logicalRepo = validateSingleToken(input.logical_repo, "logical_repo");
  const projectPath = resolveProjectPath(input.project_path);

  let sourceRevision;
  if (Object.prototype.hasOwnProperty.call(input, "source_revision") && input.source_revision !== undefined) {
    sourceRevision = validateRevision(input.source_revision);
  } else {
    const resolveHead =
      typeof options.resolveHead === "function" ? options.resolveHead : resolveGitHead;
    try {
      const head = resolveHead(projectPath);
      sourceRevision = validateRevision(head);
    } catch (err) {
      if (err instanceof RuntimeConfigError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      fail(`failed to resolve source_revision from git: ${msg}`);
    }
  }

  const dbPath = resolveDbPath(input.db, namespace, dataHome);
  const obsidianRoot = resolveObsidianRoot(input.obsidian_root);

  let threshold;
  if (Object.prototype.hasOwnProperty.call(input, "threshold") && input.threshold !== undefined) {
    threshold = validateThreshold(input.threshold);
  }

  let runId;
  if (typeof input.run_id === "string" && input.run_id !== "") {
    runId = validateSingleToken(input.run_id, "run_id");
  } else if (typeof options.createRunId === "function") {
    runId = validateSingleToken(options.createRunId(), "run_id");
  } else {
    runId = validateSingleToken(defaultRunId(), "run_id");
  }

  const dataDir = join(dataHome, "descobrir");
  const cacheDir = join(cacheHome, "descobrir");
  const runsDir = join(cacheDir, "runs");
  const runRoot = join(runsDir, runId);

  // Ensure generated run path stays under cache (string-level; layout rechecks with realpath).
  if (!runRoot.startsWith(runsDir + sep) && runRoot !== runsDir) {
    fail("run_root escaped cache runs directory");
  }

  /** @type {Record<string, unknown>} */
  const packageIntent = {
    namespace,
    logical_repo: logicalRepo,
    source_revision: sourceRevision,
  };
  if (threshold !== undefined) {
    packageIntent.threshold = threshold;
  }

  return {
    namespace,
    logical_repo: logicalRepo,
    source_revision: sourceRevision,
    project_path: projectPath,
    db_path: dbPath,
    data_dir: dataDir,
    cache_dir: cacheDir,
    runs_dir: runsDir,
    run_id: runId,
    run_root: runRoot,
    ...(obsidianRoot !== undefined ? { obsidian_root: obsidianRoot } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    package_intent: packageIntent,
  };
}
