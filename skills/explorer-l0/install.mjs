#!/usr/bin/env node
/**
 * Ownership-safe global OpenCode install for explorer-l0 (ex-Descobrir).
 *
 * install  — symlink ~/.agents/skills/explorer-l0 → this skill root;
 *            also alias ~/.agents/skills/descobrir → same root;
 *            write owned commands explorer-l0.md + descobrir.md (alias)
 * status   — report presence/ownership of those artifacts
 * uninstall— remove only owned artifacts
 *
 * Never copies a skill snapshot. Never overwrites foreign paths.
 * Paths resolve from this file and from HOME / XDG_CONFIG_HOME only.
 * XDG data dir remains ~/.local/share/descobrir (legacy path, data compat).
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
import { fileURLToPath, pathToFileURL } from "node:url";

import { InstallConflictError, sanitizeErrorMessage } from "./src/errors.mjs";

export { InstallConflictError };

/** Marker embedded in the owned command template. */
export const OWNERSHIP_MARKER = "explorer-l0-install-owned:v1";
/** Legacy marker still accepted as owned for migration. */
export const LEGACY_OWNERSHIP_MARKER = "descobrir-install-owned:v1";

const RESTART_GUIDANCE =
  "Quit and restart OpenCode so skill and command discovery reload. Running sessions keep the previous config.";

/**
 * Absolute path of the skill package that owns this installer (live source).
 * @returns {string}
 */
export function skillSourceRoot() {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * @returns {string}
 */
function resolveHome() {
  const home = process.env.HOME || homedir();
  if (typeof home !== "string" || home === "") {
    throw new Error("HOME is not set");
  }
  return resolve(home);
}

/**
 * @returns {string}
 */
function resolveConfigHome() {
  if (process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME !== "") {
    return resolve(process.env.XDG_CONFIG_HOME);
  }
  return join(resolveHome(), ".config");
}

/**
 * @returns {{ skillLink: string, commandFile: string, agentsSkillsDir: string, commandsDir: string }}
 */
export function installPaths() {
  const home = resolveHome();
  const configHome = resolveConfigHome();
  const agentsSkillsDir = join(home, ".agents", "skills");
  const commandsDir = join(configHome, "opencode", "commands");
  return {
    skillLink: join(agentsSkillsDir, "explorer-l0"),
    aliasSkillLink: join(agentsSkillsDir, "descobrir"),
    commandFile: join(commandsDir, "explorer-l0.md"),
    aliasCommandFile: join(commandsDir, "descobrir.md"),
    agentsSkillsDir,
    commandsDir,
  };
}

/**
 * Ensure candidate stays under root (no symlink escape for write targets' parents).
 * @param {string} root
 * @param {string} candidate
 */
function assertUnderRoot(root, candidate) {
  const rootReal = resolve(root);
  const cand = resolve(candidate);
  const rel = relative(rootReal, cand);
  if (rel === "" || rel.startsWith(".." + sep) || rel === ".." || rel.startsWith("..")) {
    throw new Error(`path escapes allowed root: ${candidate}`);
  }
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} skillLink
 * @param {string} sourceRoot
 * @returns {{ present: boolean, owned: boolean, target: string | null, kind: string }}
 */
export function inspectSkill(skillLink, sourceRoot = skillSourceRoot()) {
  if (!pathExists(skillLink)) {
    return { present: false, owned: false, target: null, kind: "missing" };
  }
  const st = lstatSync(skillLink);
  if (!st.isSymbolicLink()) {
    return {
      present: true,
      owned: false,
      target: null,
      kind: st.isDirectory() ? "directory" : "file",
    };
  }
  let linkTarget;
  try {
    linkTarget = readlinkSync(skillLink);
  } catch {
    return { present: true, owned: false, target: null, kind: "symlink" };
  }
  const absoluteTarget = resolve(dirname(skillLink), linkTarget);
  let owned = false;
  try {
    owned = realpathSync(absoluteTarget) === realpathSync(sourceRoot);
  } catch {
    // broken link: owned only if the stored target path equals source root
    owned = resolve(absoluteTarget) === resolve(sourceRoot);
  }
  return {
    present: true,
    owned,
    target: absoluteTarget,
    kind: "symlink",
  };
}

/**
 * @param {string} commandFile
 * @returns {{ present: boolean, owned: boolean }}
 */
export function inspectCommand(commandFile) {
  if (!pathExists(commandFile)) {
    return { present: false, owned: false };
  }
  const st = lstatSync(commandFile);
  if (!st.isFile() || st.isSymbolicLink()) {
    return { present: true, owned: false };
  }
  let text;
  try {
    text = readFileSync(commandFile, "utf8");
  } catch {
    return { present: true, owned: false };
  }
  return {
    present: true,
    owned:
      text.includes(OWNERSHIP_MARKER) || text.includes(LEGACY_OWNERSHIP_MARKER),
  };
}

/**
 * @param {string} [fileName]
 * @returns {string}
 */
function loadCommandTemplate(fileName = "explorer-l0.md") {
  const templatePath = join(skillSourceRoot(), "commands", fileName);
  if (!existsSync(templatePath)) {
    throw new Error(`repository command template missing: commands/${fileName}`);
  }
  const text = readFileSync(templatePath, "utf8");
  if (!text.includes("$ARGUMENTS")) {
    throw new Error("command template must contain $ARGUMENTS");
  }
  if (
    !text.includes(OWNERSHIP_MARKER) &&
    !text.includes(LEGACY_OWNERSHIP_MARKER)
  ) {
    throw new Error(
      `command template must contain ${OWNERSHIP_MARKER} (or legacy marker)`,
    );
  }
  return text;
}

/**
 * Ensure owned symlink skillLink → sourceRoot.
 * @param {string} skillLink
 * @param {string} sourceRoot
 * @param {string} home
 */
function ensureSkillLink(skillLink, sourceRoot, home) {
  assertUnderRoot(home, skillLink);
  const skillInfo = inspectSkill(skillLink, sourceRoot);
  if (skillInfo.present && !skillInfo.owned) {
    throw new InstallConflictError(
      `skill path exists and is not owned by this installer: ${skillLink}`,
    );
  }
  let action = "unchanged";
  if (!skillInfo.present) {
    atomicSymlink(sourceRoot, skillLink);
    action = "created";
  } else if (skillInfo.owned) {
    let current;
    try {
      current = realpathSync(skillLink);
    } catch {
      current = null;
    }
    if (current !== sourceRoot) {
      atomicSymlink(sourceRoot, skillLink);
      action = "updated";
    }
  }
  return action;
}

/**
 * @param {string} commandFile
 * @param {string} template
 * @param {string} configHome
 */
function ensureCommandFile(commandFile, template, configHome) {
  assertUnderRoot(configHome, commandFile);
  const commandInfo = inspectCommand(commandFile);
  if (commandInfo.present && !commandInfo.owned) {
    throw new InstallConflictError(
      `command path exists and is not owned by this installer: ${commandFile}`,
    );
  }
  let action = "unchanged";
  if (!commandInfo.present) {
    atomicWriteFile(commandFile, template);
    action = "created";
  } else if (commandInfo.owned) {
    const existing = readFileSync(commandFile, "utf8");
    if (existing !== template) {
      atomicWriteFile(commandFile, template);
      action = "updated";
    }
  }
  return action;
}

/**
 * Atomic symlink replace within the same directory.
 * @param {string} target absolute skill source
 * @param {string} linkPath
 */
function atomicSymlink(target, linkPath) {
  const dir = dirname(linkPath);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmpName = join(
    dir,
    `.descobrir-link.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`,
  );
  try {
    symlinkSync(
      target,
      tmpName,
      process.platform === "win32" ? "junction" : null,
    );
    renameSync(tmpName, linkPath);
  } catch (err) {
    try {
      rmSync(tmpName, { force: true });
    } catch {
      // ignore cleanup
    }
    throw err;
  }
}

/**
 * Atomic file write within the same directory.
 * @param {string} filePath
 * @param {string} contents
 */
function atomicWriteFile(filePath, contents) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmpName = join(
    dir,
    `.descobrir-cmd.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tmpName, contents, { encoding: "utf8", mode: 0o644 });
    try {
      chmodSync(tmpName, 0o644);
    } catch {
      // best-effort mode
    }
    renameSync(tmpName, filePath);
  } catch (err) {
    try {
      rmSync(tmpName, { force: true });
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * @returns {{
 *   ok: true,
 *   skill: { path: string, target: string, owned: true, action: string },
 *   command: { path: string, owned: true, action: string },
 *   restart_guidance: string
 * }}
 */
export function install() {
  const sourceRoot = realpathSync(skillSourceRoot());
  const paths = installPaths();
  const home = resolveHome();
  const configHome = resolveConfigHome();

  if (!existsSync(join(sourceRoot, "SKILL.md"))) {
    throw new Error("skill source missing SKILL.md");
  }

  const primaryTemplate = loadCommandTemplate("explorer-l0.md");
  const aliasTemplate = loadCommandTemplate("descobrir.md");

  // Preflight conflicts before mutating anything
  for (const link of [paths.skillLink, paths.aliasSkillLink]) {
    const info = inspectSkill(link, sourceRoot);
    if (info.present && !info.owned) {
      throw new InstallConflictError(
        `skill path exists and is not owned by this installer: ${link}`,
      );
    }
  }
  for (const file of [paths.commandFile, paths.aliasCommandFile]) {
    const info = inspectCommand(file);
    if (info.present && !info.owned) {
      throw new InstallConflictError(
        `command path exists and is not owned by this installer: ${file}`,
      );
    }
  }

  const skillAction = ensureSkillLink(paths.skillLink, sourceRoot, home);
  const aliasSkillAction = ensureSkillLink(
    paths.aliasSkillLink,
    sourceRoot,
    home,
  );
  const commandAction = ensureCommandFile(
    paths.commandFile,
    primaryTemplate,
    configHome,
  );
  const aliasCommandAction = ensureCommandFile(
    paths.aliasCommandFile,
    aliasTemplate,
    configHome,
  );

  const skillAfter = inspectSkill(paths.skillLink, sourceRoot);
  const commandAfter = inspectCommand(paths.commandFile);
  if (!skillAfter.owned || !commandAfter.owned) {
    throw new Error("install post-condition failed: artifacts not owned");
  }

  return {
    ok: true,
    skill: {
      path: paths.skillLink,
      target: sourceRoot,
      alias_path: paths.aliasSkillLink,
      alias_action: aliasSkillAction,
      alias_command_path: paths.aliasCommandFile,
      alias_command_action: aliasCommandAction,
      owned: true,
      action: skillAction,
    },
    command: {
      path: paths.commandFile,
      owned: true,
      action: commandAction,
    },
    restart_guidance: RESTART_GUIDANCE,
  };
}

/**
 * @returns {{
 *   installed: boolean,
 *   skill: { present: boolean, owned: boolean, target: string | null, kind?: string },
 *   command: { present: boolean, owned: boolean },
 *   paths: { skill: string, command: string, source: string },
 *   restart_guidance: string
 * }}
 */
export function status() {
  const sourceRoot = skillSourceRoot();
  const paths = installPaths();
  const skill = inspectSkill(paths.skillLink, sourceRoot);
  const command = inspectCommand(paths.commandFile);
  return {
    installed: skill.owned && command.owned,
    skill: {
      present: skill.present,
      owned: skill.owned,
      target: skill.target,
      kind: skill.kind,
    },
    command: {
      present: command.present,
      owned: command.owned,
    },
    paths: {
      skill: paths.skillLink,
      command: paths.commandFile,
      source: sourceRoot,
    },
    restart_guidance: RESTART_GUIDANCE,
  };
}

/**
 * @returns {{
 *   ok: true,
 *   skill: { path: string, action: string },
 *   command: { path: string, action: string },
 *   restart_guidance: string
 * }}
 */
export function uninstall() {
  const sourceRoot = skillSourceRoot();
  const paths = installPaths();
  const home = resolveHome();
  const configHome = resolveConfigHome();

  assertUnderRoot(home, paths.skillLink);
  assertUnderRoot(home, paths.aliasSkillLink);
  assertUnderRoot(configHome, paths.commandFile);
  assertUnderRoot(configHome, paths.aliasCommandFile);

  /** @param {string} link */
  function removeOwnedSkill(link) {
    const info = inspectSkill(link, sourceRoot);
    if (info.present && info.owned) {
      rmSync(link, { force: true });
      return "removed";
    }
    if (info.present && !info.owned) return "skipped_foreign";
    return "absent";
  }
  /** @param {string} file */
  function removeOwnedCommand(file) {
    const info = inspectCommand(file);
    if (info.present && info.owned) {
      rmSync(file, { force: true });
      return "removed";
    }
    if (info.present && !info.owned) return "skipped_foreign";
    return "absent";
  }

  return {
    ok: true,
    skill: { path: paths.skillLink, action: removeOwnedSkill(paths.skillLink) },
    command: {
      path: paths.commandFile,
      action: removeOwnedCommand(paths.commandFile),
    },
    alias_skill: {
      path: paths.aliasSkillLink,
      action: removeOwnedSkill(paths.aliasSkillLink),
    },
    alias_command: {
      path: paths.aliasCommandFile,
      action: removeOwnedCommand(paths.aliasCommandFile),
    },
    restart_guidance: RESTART_GUIDANCE,
  };
}

/**
 * @param {string[]} argv process.argv.slice(2)
 * @returns {Promise<number>}
 */
export async function main(argv) {
  try {
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new Error("usage: install | status | uninstall");
    }
    if (argv.length !== 1) {
      throw new Error("usage: install | status | uninstall");
    }
    const [command] = argv;
    switch (command) {
      case "install": {
        const result = install();
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.stdout.write(`${result.restart_guidance}\n`);
        return 0;
      }
      case "status": {
        const result = status();
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      case "uninstall": {
        const result = uninstall();
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.stdout.write(`${result.restart_guidance}\n`);
        return 0;
      }
      default:
        throw new Error(`unknown command: ${command}`);
    }
  } catch (err) {
    process.stderr.write(`${sanitizeErrorMessage(err)}\n`);
    return 1;
  }
}

const isDirect =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirect) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
