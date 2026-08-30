/**
 * Atomic 0600 write/load for run-descriptor.json. Scrubs absolute paths from errors.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  RUN_PATHS,
  RunDescriptorError,
  validateRunDescriptor,
} from "./run-descriptor-shape.mjs";
import { stablePretty } from "./stable-json.mjs";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/** @param {string} raw */
export function scrubMessage(raw) {
  return String(raw)
    .replace(/\/Users\/[^\s:'"]+/g, "<path>")
    .replace(/\/home\/[^\s:'"]+/g, "<path>")
    .replace(/\/private\/[^\s:'"]+/g, "<path>")
    .replace(/\/var\/[^\s:'"]+/g, "<path>")
    .replace(/\/tmp\/[^\s:'"]+/g, "<path>")
    .replace(/[A-Za-z]:\\[^\s:'"]+/g, "<path>");
}

/** @param {string} reason @returns {never} */
function failIo(reason) {
  throw new RunDescriptorError(scrubMessage(reason));
}

/** @param {unknown} runRoot */
function requireRunRoot(runRoot) {
  if (typeof runRoot !== "string" || runRoot === "") failIo("run_root must be a non-empty string");
  if (!isAbsolute(runRoot) || runRoot.includes("\0")) failIo("run_root must be an absolute path");
  return resolve(runRoot);
}

/** @param {string} filePath @param {string} contents */
function atomicWritePrivate(filePath, contents) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try { chmodSync(dir, DIR_MODE); } catch { /* best-effort */ }
  const tmp = join(
    dir,
    `.run-descriptor.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tmp, contents, { encoding: "utf8", mode: FILE_MODE });
    try { chmodSync(tmp, FILE_MODE); } catch { /* best-effort */ }
    renameSync(tmp, filePath);
    try { chmodSync(filePath, FILE_MODE); } catch { /* best-effort */ }
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    const msg = err instanceof Error ? err.message : String(err);
    failIo(`failed to write run descriptor: ${msg}`);
  }
}

/**
 * @param {string} runRoot absolute caller-resolved run root (never persisted)
 * @param {unknown} descriptor
 */
export function writeRunDescriptor(runRoot, descriptor) {
  const root = requireRunRoot(runRoot);
  let valid;
  try {
    valid = validateRunDescriptor(descriptor);
  } catch (err) {
    if (err instanceof RunDescriptorError) throw err;
    failIo(err instanceof Error ? err.message : String(err));
  }
  atomicWritePrivate(join(root, RUN_PATHS.descriptor), stablePretty(valid));
  return valid;
}

/** @param {string} runRoot */
export function loadRunDescriptor(runRoot) {
  const root = requireRunRoot(runRoot);
  const abs = join(root, RUN_PATHS.descriptor);
  let raw;
  try {
    if (!existsSync(abs)) failIo("run descriptor file is missing");
    let st;
    try {
      st = lstatSync(abs);
    } catch (err) {
      failIo(`failed to stat run descriptor: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (st.isSymbolicLink()) failIo("run descriptor must not be a symlink");
    if (!st.isFile()) failIo("run descriptor must be a regular file");
    raw = readFileSync(abs, "utf8");
  } catch (err) {
    if (err instanceof RunDescriptorError) throw err;
    failIo(`failed to read run descriptor: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    failIo(`run descriptor JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return validateRunDescriptor(parsed);
  } catch (err) {
    if (err instanceof RunDescriptorError) {
      throw new RunDescriptorError(scrubMessage(err.message), { cause: err });
    }
    failIo(`run descriptor invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}

