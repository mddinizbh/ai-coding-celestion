/**
 * Symlink a skill dir into ~/.agents/skills/<name> + optional command file.
 * Used for explorer-l2 and explorer-query (no full install.mjs yet).
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const MARKER = "opencode-explorer-install-owned:v1";

function home() {
  return resolve(process.env.HOME || homedir());
}

function configHome() {
  if (process.env.XDG_CONFIG_HOME) return resolve(process.env.XDG_CONFIG_HOME);
  return join(home(), ".config");
}

function assertUnder(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel.startsWith("..") || rel === "..") {
    throw new Error(`path escapes root: ${candidate}`);
  }
}

function pathExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function atomicSymlink(target, linkPath) {
  const dir = dirname(linkPath);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = join(dir, `.ox-link.${process.pid}.${Date.now()}`);
  try {
    symlinkSync(
      target,
      tmp,
      process.platform === "win32" ? "junction" : null,
    );
    renameSync(tmp, linkPath);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function atomicWrite(filePath, contents) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = join(dir, `.ox-cmd.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o644 });
    try {
      chmodSync(tmp, 0o644);
    } catch {
      /* ignore */
    }
    renameSync(tmp, filePath);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * @param {string} skillName
 * @param {string} skillSourceAbs
 * @param {{ commandName?: string, commandBody?: string }} [opts]
 */
export function installSimpleSkill(skillName, skillSourceAbs, opts = {}) {
  const source = realpathSync(skillSourceAbs);
  if (!existsSync(join(source, "SKILL.md"))) {
    throw new Error(`missing SKILL.md in ${source}`);
  }

  const skillLink = join(home(), ".agents", "skills", skillName);
  assertUnder(home(), skillLink);

  if (pathExists(skillLink)) {
    const st = lstatSync(skillLink);
    if (!st.isSymbolicLink()) {
      throw new Error(`skill path exists and is not a symlink: ${skillLink}`);
    }
    let cur;
    try {
      cur = realpathSync(skillLink);
    } catch {
      cur = null;
    }
    if (cur !== source) {
      // owned only if points at our tree or broken — replace if same name convention
      const target = readlinkSync(skillLink);
      atomicSymlink(source, skillLink);
    }
  } else {
    atomicSymlink(source, skillLink);
  }

  /** @type {object} */
  const result = { skill: skillLink, source };

  if (opts.commandName && opts.commandBody) {
    const cmdFile = join(configHome(), "opencode", "commands", opts.commandName);
    assertUnder(configHome(), cmdFile);
    if (pathExists(cmdFile)) {
      const text = readFileSync(cmdFile, "utf8");
      if (!text.includes(MARKER) && !text.includes("explorer-l")) {
        // allow overwrite only if our marker or explorer-related
        if (!text.includes("$ARGUMENTS")) {
          throw new Error(`foreign command file: ${cmdFile}`);
        }
      }
    }
    const body = opts.commandBody.includes(MARKER)
      ? opts.commandBody
      : `${opts.commandBody}\n\n<!-- ${MARKER} -->\n`;
    if (!body.includes("$ARGUMENTS")) {
      throw new Error("command body must include $ARGUMENTS");
    }
    atomicWrite(cmdFile, body);
    result.command = cmdFile;
  }

  return result;
}

/**
 * @param {string} skillName
 * @param {string} [commandName]
 */
export function uninstallSimpleSkill(skillName, commandName) {
  const skillLink = join(home(), ".agents", "skills", skillName);
  const removed = [];
  if (pathExists(skillLink) && lstatSync(skillLink).isSymbolicLink()) {
    rmSync(skillLink, { force: true });
    removed.push(skillLink);
  }
  if (commandName) {
    const cmdFile = join(configHome(), "opencode", "commands", commandName);
    if (pathExists(cmdFile)) {
      const text = readFileSync(cmdFile, "utf8");
      if (text.includes(MARKER) || text.includes("explorer-l")) {
        rmSync(cmdFile, { force: true });
        removed.push(cmdFile);
      }
    }
  }
  return { removed };
}

export { MARKER };
