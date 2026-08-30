/**
 * Materialize Descobrir runtime directories with restrictive permissions.
 * Separated from pure resolveRuntimeConfig so tests stay deterministic.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { DescobrirError } from "./errors.mjs";
import { RuntimeConfigError } from "./runtime-config.mjs";

export class RuntimeLayoutError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "RuntimeLayoutError";
  }
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * @param {string} reason
 * @returns {never}
 */
function fail(reason) {
  throw new RuntimeLayoutError(reason);
}

/**
 * realpath the longest existing prefix; append non-existing tail segments.
 * Follows symlinks on existing components so confinement can detect escape.
 *
 * @param {string} absPath
 * @returns {string}
 */
function realpathExistingPrefix(absPath) {
  const abs = resolve(absPath);
  if (existsSync(abs)) {
    return realpathSync(abs);
  }

  const root = abs.startsWith(sep) ? sep : "";
  if (root === sep && !existsSync(sep)) {
    return abs;
  }

  let cursor = root === sep ? realpathSync(sep) : "";
  const relFromRoot = root === sep ? abs.slice(1) : abs;
  const parts = relFromRoot.split(sep).filter((p) => p !== "");
  let missing = false;

  for (const part of parts) {
    const next = cursor === "" ? part : join(cursor, part);
    if (!missing && existsSync(next)) {
      const st = lstatSync(next);
      cursor = st.isSymbolicLink() || st.isDirectory() || st.isFile()
        ? realpathSync(next)
        : next;
    } else {
      missing = true;
      cursor = join(cursor, part);
    }
  }
  return cursor;
}

/**
 * Symlink-aware confinement: resolved path must stay inside root.
 * Uses path.relative (not string prefix) to avoid /foo vs /foobar.
 *
 * @param {string} candidate
 * @param {string} root
 * @param {string} label
 * @returns {string} absolute resolved path (realpath when exists)
 */
export function confinePath(candidate, root, label) {
  if (typeof candidate !== "string" || candidate === "") {
    fail(`${label} must be a non-empty string`);
  }
  if (typeof root !== "string" || root === "") {
    fail(`${label} confinement root must be a non-empty string`);
  }
  if (candidate.includes("\0") || root.includes("\0")) {
    fail(`${label} contains NUL`);
  }

  const absCandidate = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const absRoot = resolve(root);

  const resolved = realpathExistingPrefix(absCandidate);
  const resolvedRoot = existsSync(absRoot) ? realpathSync(absRoot) : absRoot;

  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    fail(`${label} escapes allowed root`);
  }
  return resolved;
}

/**
 * @param {string} dir
 */
function mkdirPrivate(dir) {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`failed to set directory mode 0700: ${msg}`);
  }
}

/**
 * @param {string} filePath
 */
function ensurePrivateFile(filePath) {
  const parent = dirname(filePath);
  mkdirPrivate(parent);
  if (!existsSync(filePath)) {
    const fd = openSync(filePath, "wx", FILE_MODE);
    closeSync(fd);
  }
  try {
    chmodSync(filePath, FILE_MODE);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`failed to set file mode 0600: ${msg}`);
  }
}

/**
 * Create runtime directories for a resolved config.
 *
 * @param {{
 *   db_path: string,
 *   data_dir: string,
 *   cache_dir: string,
 *   runs_dir: string,
 *   run_root: string,
 *   run_id: string,
 *   obsidian_root?: string,
 * }} config
 * @param {{ ensureDbFile?: boolean }} [options]
 */
export function createRuntimeLayout(config, options = {}) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    fail("config must be an object");
  }
  for (const key of ["db_path", "data_dir", "cache_dir", "runs_dir", "run_root", "run_id"]) {
    if (typeof /** @type {Record<string, unknown>} */ (config)[key] !== "string"
      || /** @type {Record<string, string>} */ (config)[key] === "") {
      fail(`config.${key} must be a non-empty string`);
    }
  }

  const dataDir = resolve(config.data_dir);
  const cacheDir = resolve(config.cache_dir);
  const runsDir = resolve(config.runs_dir);
  const runRoot = resolve(config.run_root);
  const dbPath = resolve(config.db_path);

  mkdirPrivate(dataDir);
  mkdirPrivate(cacheDir);
  mkdirPrivate(runsDir);

  let confinedRun;
  try {
    confinedRun = confinePath(runRoot, runsDir, "run_root");
  } catch (err) {
    if (err instanceof RuntimeLayoutError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    fail(`run_root confinement failed: ${msg}`);
  }

  mkdirPrivate(confinedRun);

  const runReal = realpathSync(confinedRun);
  const runsReal = realpathSync(runsDir);
  const relRun = relative(runsReal, runReal);
  if (relRun.startsWith("..") || isAbsolute(relRun)) {
    fail("run_root escapes allowed root after creation");
  }

  const dbParent = dirname(dbPath);
  mkdirPrivate(dbParent);

  if (options.ensureDbFile === true) {
    ensurePrivateFile(dbPath);
  }

  if (typeof config.obsidian_root === "string" && config.obsidian_root !== "") {
    if (!isAbsolute(config.obsidian_root)) {
      throw new RuntimeConfigError("obsidian_root must be an absolute path");
    }
  }

  return {
    db_path: dbPath,
    data_dir: realpathSync(dataDir),
    cache_dir: realpathSync(cacheDir),
    runs_dir: runsReal,
    run_id: config.run_id,
    run_root: runReal,
    ...(typeof config.obsidian_root === "string" && config.obsidian_root !== ""
      ? { obsidian_root: resolve(config.obsidian_root) }
      : {}),
  };
}
