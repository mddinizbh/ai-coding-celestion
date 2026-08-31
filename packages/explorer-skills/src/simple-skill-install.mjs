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
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return false;
    throw e; // surface unexpected
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
    } catch (cleanupErr) {
      if (cleanupErr.code !== "ENOENT") throw cleanupErr;
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
    } catch (chmodErr) {
      if (chmodErr.code !== "ENOENT") throw chmodErr;
    }
    renameSync(tmp, filePath);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch (cleanupErr) {
      if (cleanupErr.code !== "ENOENT") throw cleanupErr;
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
  if (!skillSourceAbs && opts.commandName && opts.commandBody) {
    // command-only path — marker ONLY; never overwrite foreign (even if has $ARGUMENTS)
    const cmdFile = join(configHome(), "opencode", "commands", opts.commandName);
    assertUnder(configHome(), cmdFile);
    if (pathExists(cmdFile)) {
      const text = readFileSync(cmdFile, "utf8");
      if (!text.includes(MARKER)) {
        // never overwrite foreign cmd (even with $ARGUMENTS); skip but succeed install
        return { command_skipped: cmdFile };
      }
    }
    const body = opts.commandBody.includes(MARKER)
      ? opts.commandBody
      : `${opts.commandBody}\n\n<!-- ${MARKER} -->\n`;
    if (!body.includes("$ARGUMENTS")) {
      throw new Error("command body must include $ARGUMENTS");
    }
    atomicWrite(cmdFile, body);
    return { command: cmdFile };
  }
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
    let lexTarget = null;
    try {
      cur = realpathSync(skillLink);
    } catch {
      try {
        const lex = readlinkSync(skillLink);
        lexTarget = resolve(lex);
        cur = lexTarget === resolve(source) ? source : null;
      } catch {
        cur = null;
      }
    }
    if (cur !== source) {
      if (cur === null && lexTarget === resolve(source)) {
        // broken but lexical target exactly matches expected source → replace
        atomicSymlink(source, skillLink);
      } else if (cur === null) {
        // foreign broken (lexical does not match) → preserve, explicit skip
        const result = { skill_skipped: skillLink, source };
        if (opts.commandName && opts.commandBody) {
          const cmdFile = join(configHome(), "opencode", "commands", opts.commandName);
          if (!pathExists(cmdFile) || readFileSync(cmdFile, "utf8").includes(MARKER)) {
            const body = opts.commandBody.includes(MARKER) ? opts.commandBody : `${opts.commandBody}\n\n<!-- ${MARKER} -->\n`;
            atomicWrite(cmdFile, body);
            result.command = cmdFile;
          } else {
            result.command_skipped = cmdFile;
          }
        }
        return result;
      } else {
        // foreign non-broken → skip
        const result = { skill_skipped: skillLink, source };
        if (opts.commandName && opts.commandBody) {
          const cmdFile = join(configHome(), "opencode", "commands", opts.commandName);
          if (!pathExists(cmdFile) || readFileSync(cmdFile, "utf8").includes(MARKER)) {
            const body = opts.commandBody.includes(MARKER) ? opts.commandBody : `${opts.commandBody}\n\n<!-- ${MARKER} -->\n`;
            atomicWrite(cmdFile, body);
            result.command = cmdFile;
          } else {
            result.command_skipped = cmdFile;
          }
        }
        return result;
      }
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
      if (!text.includes(MARKER)) {
        // never overwrite foreign; skip cmd but keep skill symlink success
        result.command_skipped = cmdFile;
      } else {
        const body = opts.commandBody.includes(MARKER)
          ? opts.commandBody
          : `${opts.commandBody}\n\n<!-- ${MARKER} -->\n`;
        if (!body.includes("$ARGUMENTS")) {
          throw new Error("command body must include $ARGUMENTS");
        }
        atomicWrite(cmdFile, body);
        result.command = cmdFile;
      }
    } else {
      const body = opts.commandBody.includes(MARKER)
        ? opts.commandBody
        : `${opts.commandBody}\n\n<!-- ${MARKER} -->\n`;
      if (!body.includes("$ARGUMENTS")) {
        throw new Error("command body must include $ARGUMENTS");
      }
      atomicWrite(cmdFile, body);
      result.command = cmdFile;
    }
  }

  return result;
}

/**
 * @param {string} skillName
 * @param {string} [commandName]
 */
export function uninstallSimpleSkill(skillName, commandName, expectedSource) {
  if (skillName && expectedSource === undefined) {
    throw new Error(`expectedSource required for skill uninstall: ${skillName}`);
  }
  const removed = [];
  if (skillName) {
    const skillLink = join(home(), ".agents", "skills", skillName);
    if (pathExists(skillLink) && lstatSync(skillLink).isSymbolicLink()) {
      let cur = null;
      let norm = null;
      try {
        cur = realpathSync(skillLink);
      } catch {
        try {
          const lex = readlinkSync(skillLink);
          norm = resolve(lex);
          const expNorm = expectedSource ? resolve(expectedSource) : null;
          if (expNorm && norm === expNorm) {
            cur = expectedSource;
          }
        } catch {
          cur = null;
          norm = null;
        }
      }
      const expNorm = expectedSource ? resolve(expectedSource) : null;
      if (cur === expectedSource || (cur === null && expNorm && norm === expNorm)) {
        rmSync(skillLink, { force: true });
        removed.push(skillLink);
      }
    }
  }
  if (commandName) {
    const cmdFile = join(configHome(), "opencode", "commands", commandName);
    if (pathExists(cmdFile)) {
      const text = readFileSync(cmdFile, "utf8");
      if (text.includes(MARKER)) {
        rmSync(cmdFile, { force: true });
        removed.push(cmdFile);
      }
    }
  }
  return { removed };
}

/** Truthful status probe for skill symlink (exact source match = owned) */
export function statusSimpleSkill(skillName, expectedSource = null) {
  const skillLink = join(home(), ".agents", "skills", skillName);
  if (!pathExists(skillLink) || !lstatSync(skillLink).isSymbolicLink()) {
    return { present: false, owned: false, skill_present: false };
  }
  let cur = null;
  try {
    cur = realpathSync(skillLink);
  } catch {
    try {
      const lex = readlinkSync(skillLink);
      cur = resolve(lex) === resolve(expectedSource || "") ? expectedSource : null;
    } catch {
      cur = null;
    }
  }
  const owned = expectedSource ? cur === expectedSource : false;
  return { present: true, owned, source: cur, link: skillLink, skill_present: true };
}

/** Truthful status for command (marker = owned) */
export function statusCommand(commandName) {
  const cmdFile = join(configHome(), "opencode", "commands", commandName);
  if (!pathExists(cmdFile)) {
    return { present: false, owned: false, command_present: false };
  }
  const text = readFileSync(cmdFile, "utf8");
  const owned = text.includes(MARKER);
  return { present: true, owned, file: cmdFile, command_present: true };
}

export { MARKER };
