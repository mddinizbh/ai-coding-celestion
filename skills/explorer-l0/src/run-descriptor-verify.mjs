/**
 * Prepared-artifact re-verification and explorer payload inventory.
 * Prepared artifacts must be confined regular files (symlinks rejected).
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { compareCodeUnits } from "./explorer-payload-shape.mjs";
import { hashContent } from "./manifest-builder.mjs";
import { confinePath } from "./runtime-layout.mjs";
import { scrubMessage } from "./run-descriptor-io.mjs";
import {
  RUN_PATHS,
  RunDescriptorError,
  explorerPayloadPath,
  requireSafeRelativePath,
  sealedClone,
  validateRunDescriptor,
} from "./run-descriptor-shape.mjs";

/** @param {string} reason @returns {never} */
function failV(reason) {
  throw new RunDescriptorError(scrubMessage(reason));
}

/** @param {unknown} runRoot */
function requireRunRoot(runRoot) {
  if (typeof runRoot !== "string" || runRoot === "" || !isAbsolute(runRoot) || runRoot.includes("\0")) {
    failV("run_root must be an absolute path");
  }
  return resolve(runRoot);
}

/**
 * Resolve relative path under run root; reject escape. Caller checks regular file.
 * @param {string} rootReal
 * @param {string} rel
 * @param {string} label
 */
function confinedRel(rootReal, rel, label) {
  requireSafeRelativePath(rel, label);
  try {
    return confinePath(rel, rootReal, label);
  } catch (err) {
    failV(`${label} escapes run root or is unsafe: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * @param {string} abs
 * @param {string} rootReal
 * @param {string} rel
 */
function assertRegularFile(abs, rootReal, rel) {
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    failV(`failed to stat prepared artifact '${rel}': ${err instanceof Error ? err.message : String(err)}`);
  }
  if (st.isSymbolicLink()) failV(`prepared artifact '${rel}' must not be a symlink`);
  if (!st.isFile()) failV(`prepared artifact '${rel}' must be a regular file`);
  // belt: realpath still inside root
  let real;
  try {
    real = realpathSync(abs);
  } catch (err) {
    failV(`failed to resolve prepared artifact '${rel}': ${err instanceof Error ? err.message : String(err)}`);
  }
  const r = relative(rootReal, real);
  if (r.startsWith("..") || isAbsolute(r)) failV(`prepared artifact '${rel}' escapes run root`);
}

/**
 * @param {string} runRoot
 * @param {unknown} descriptor
 */
export function verifyPreparedArtifacts(runRoot, descriptor) {
  const root = requireRunRoot(runRoot);
  const valid = validateRunDescriptor(descriptor);
  if (!existsSync(root)) failV("run root does not exist");
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch (err) {
    failV(`failed to resolve run root: ${err instanceof Error ? err.message : String(err)}`);
  }
  const hashes = /** @type {Record<string, string>} */ (valid.content_hashes);
  for (const [rel, expected] of Object.entries(hashes)) {
    requireSafeRelativePath(rel, `artifact '${rel}'`);
    const absCandidate = join(root, rel);
    if (!existsSync(absCandidate)) failV(`prepared artifact missing: ${rel}`);
    // Reject symlinks before realpath/confine (simpler trust boundary).
    let st;
    try {
      st = lstatSync(absCandidate);
    } catch (err) {
      failV(`failed to stat prepared artifact '${rel}': ${err instanceof Error ? err.message : String(err)}`);
    }
    if (st.isSymbolicLink()) failV(`prepared artifact '${rel}' must not be a symlink`);
    if (!st.isFile()) failV(`prepared artifact '${rel}' must be a regular file`);
    const abs = confinedRel(rootReal, rel, `artifact '${rel}'`);
    assertRegularFile(abs, rootReal, rel);
    let bytes;
    try {
      bytes = readFileSync(abs);
    } catch (err) {
      failV(`failed to read prepared artifact '${rel}': ${err instanceof Error ? err.message : String(err)}`);
    }
    if (hashContent(bytes) !== expected) failV(`content hash mismatch for '${rel}'`);
  }
  return valid;
}

/**
 * Exact expected payload inventory for Todo 9 completeness checks.
 * @param {string} runRoot
 * @param {unknown} descriptor
 * @returns {{ expected: string[], found: string[], missing: string[] }}
 */
export function listExplorerPayloadFiles(runRoot, descriptor) {
  const root = requireRunRoot(runRoot);
  const valid = validateRunDescriptor(descriptor);
  const expected = valid.chunk_index.chunks
    .map((c) => explorerPayloadPath(/** @type {string} */ (c.chunk_key)))
    .sort(compareCodeUnits);
  const expectedSet = new Set(expected);

  let rootReal;
  try {
    rootReal = existsSync(root) ? realpathSync(root) : resolve(root);
  } catch (err) {
    failV(`failed to resolve run root: ${err instanceof Error ? err.message : String(err)}`);
  }

  /** @type {string[]} */
  const found = [];
  const dirRel = RUN_PATHS.explorerPayloads;
  const dirAbs = join(root, dirRel);
  if (existsSync(dirAbs)) {
    try {
      confinePath(dirRel, rootReal, "explorer payloads dir");
    } catch (err) {
      failV(`explorer payloads dir unsafe: ${err instanceof Error ? err.message : String(err)}`);
    }
    let names;
    try {
      names = readdirSync(dirAbs);
    } catch (err) {
      failV(`failed to list explorer payloads: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const rel = `${dirRel}/${name}`;
      const abs = join(root, rel);
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        // noise symlink or escape — reject if it claims an expected name; ignore unknown noise only if not symlink escape attempt on expected
        if (expectedSet.has(rel)) failV(`payload '${rel}' must not be a symlink`);
        // unexpected symlink: ensure it does not escape (trust boundary)
        try {
          const target = realpathSync(abs);
          const r = relative(rootReal, target);
          if (r.startsWith("..") || isAbsolute(r)) failV(`payload noise symlink '${rel}' escapes run root`);
        } catch {
          failV(`payload noise symlink '${rel}' is dangling or unreadable`);
        }
        continue;
      }
      if (!expectedSet.has(rel)) continue;
      if (!st.isFile()) failV(`payload '${rel}' must be a regular file`);
      found.push(rel);
    }
  }
  found.sort(compareCodeUnits);
  const missing = expected.filter((p) => !found.includes(p));
  return sealedClone({ expected, found, missing });
}
