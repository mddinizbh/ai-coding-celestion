#!/usr/bin/env node
/**
 * Ownership-safe global OpenCode install for explorer-l1 (+ legacy aliases).
 *
 * install  — symlink ~/.agents/skills/explorer-l1 → this tree;
 *            aliases: l1, graph-system (graph-system → ./graph-system subdir);
 *            commands: explorer-l1.md + l1.md + graph-system.md
 * status / uninstall — owned artifacts only
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

import { L1Error, sanitizeErrorMessage } from "./src/errors.mjs";

export const OWNERSHIP_MARKER = "explorer-l1-install-owned:v1";
export const LEGACY_L1_OWNERSHIP_MARKER = "l1-install-owned:v1";
export const GRAPH_SYSTEM_OWNERSHIP_MARKER = "graph-system-install-owned:v1";

const RESTART_GUIDANCE =
  "Quit and restart OpenCode so skill and command discovery reload. Running sessions keep the previous config.";

export function skillSourceRoot() {
  return dirname(fileURLToPath(import.meta.url));
}

function resolveHome() {
  const home = process.env.HOME || homedir();
  if (typeof home !== "string" || home === "") throw new Error("HOME is not set");
  return resolve(home);
}

function resolveConfigHome() {
  if (process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME !== "") {
    return resolve(process.env.XDG_CONFIG_HOME);
  }
  return join(resolveHome(), ".config");
}

export function installPaths() {
  const home = resolveHome();
  const configHome = resolveConfigHome();
  const agentsSkillsDir = join(home, ".agents", "skills");
  const commandsDir = join(configHome, "opencode", "commands");
  return {
    l1SkillLink: join(agentsSkillsDir, "explorer-l1"),
    aliasL1SkillLink: join(agentsSkillsDir, "l1"),
    graphSystemSkillLink: join(agentsSkillsDir, "graph-system"),
    l1CommandFile: join(commandsDir, "explorer-l1.md"),
    aliasL1CommandFile: join(commandsDir, "l1.md"),
    graphSystemCommandFile: join(commandsDir, "graph-system.md"),
    agentsSkillsDir,
    commandsDir,
    graphSystemSource: join(skillSourceRoot(), "graph-system"),
  };
}

function assertUnderRoot(root, candidate) {
  const rootReal = resolve(root);
  const cand = resolve(candidate);
  const rel = relative(rootReal, cand);
  if (rel === "" || rel.startsWith(".." + sep) || rel === ".." || rel.startsWith("..")) {
    throw new Error(`path escapes allowed root: ${candidate}`);
  }
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function inspectSkill(skillLink, sourceRoot) {
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
    owned = resolve(absoluteTarget) === resolve(sourceRoot);
  }
  return { present: true, owned, target: absoluteTarget, kind: "symlink" };
}

export function inspectCommand(commandFile, marker) {
  if (!pathExists(commandFile)) return { present: false, owned: false };
  const st = lstatSync(commandFile);
  if (!st.isFile() || st.isSymbolicLink()) return { present: true, owned: false };
  let text;
  try {
    text = readFileSync(commandFile, "utf8");
  } catch {
    return { present: true, owned: false };
  }
  return {
    present: true,
    owned:
      text.includes(marker) ||
      text.includes(OWNERSHIP_MARKER) ||
      text.includes(LEGACY_L1_OWNERSHIP_MARKER) ||
      text.includes(GRAPH_SYSTEM_OWNERSHIP_MARKER),
  };
}

function atomicSymlink(target, linkPath) {
  const dir = dirname(linkPath);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmpName = join(
    dir,
    `.l1-link.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`,
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
      // ignore
    }
    throw err;
  }
}

function atomicWriteFile(filePath, contents) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmpName = join(
    dir,
    `.l1-cmd.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tmpName, contents, { encoding: "utf8", mode: 0o644 });
    try {
      chmodSync(tmpName, 0o644);
    } catch {
      // best-effort
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

function loadTemplate(relativePath, marker) {
  const templatePath = join(skillSourceRoot(), relativePath);
  if (!existsSync(templatePath)) {
    throw new Error(`repository command template missing: ${relativePath}`);
  }
  const text = readFileSync(templatePath, "utf8");
  if (!text.includes("$ARGUMENTS")) {
    throw new Error(`${relativePath} must contain $ARGUMENTS`);
  }
  const ok =
    text.includes(marker) ||
    text.includes(OWNERSHIP_MARKER) ||
    text.includes(LEGACY_L1_OWNERSHIP_MARKER) ||
    text.includes(GRAPH_SYSTEM_OWNERSHIP_MARKER);
  if (!ok) {
    throw new Error(`${relativePath} must contain ownership marker`);
  }
  return text;
}

function ensureSkillLink(linkPath, sourceRoot, home) {
  assertUnderRoot(home, linkPath);
  const info = inspectSkill(linkPath, sourceRoot);
  if (info.present && !info.owned) {
    throw new L1Error(`skill path exists and is not owned: ${linkPath}`);
  }
  let action = "unchanged";
  if (!info.present) {
    atomicSymlink(sourceRoot, linkPath);
    action = "created";
  } else if (info.owned) {
    let current;
    try {
      current = realpathSync(linkPath);
    } catch {
      current = null;
    }
    if (current !== realpathSync(sourceRoot)) {
      atomicSymlink(realpathSync(sourceRoot), linkPath);
      action = "updated";
    }
  }
  return action;
}

function ensureCommand(filePath, template, marker, configHome) {
  assertUnderRoot(configHome, filePath);
  const info = inspectCommand(filePath, marker);
  if (info.present && !info.owned) {
    throw new L1Error(`command path exists and is not owned: ${filePath}`);
  }
  let action = "unchanged";
  if (!info.present) {
    atomicWriteFile(filePath, template);
    action = "created";
  } else if (info.owned) {
    const existing = readFileSync(filePath, "utf8");
    if (existing !== template) {
      atomicWriteFile(filePath, template);
      action = "updated";
    }
  }
  return action;
}

export function install() {
  const sourceRoot = realpathSync(skillSourceRoot());
  const paths = installPaths();
  const home = resolveHome();
  const configHome = resolveConfigHome();

  if (!existsSync(join(sourceRoot, "SKILL.md"))) {
    throw new Error("skill source missing SKILL.md");
  }
  if (!existsSync(join(paths.graphSystemSource, "SKILL.md"))) {
    throw new Error("graph-system skill source missing SKILL.md");
  }

  const primaryTemplate = loadTemplate("commands/explorer-l1.md", OWNERSHIP_MARKER);
  const aliasL1Template = loadTemplate(
    "commands/l1.md",
    LEGACY_L1_OWNERSHIP_MARKER,
  );
  const gsTemplate = loadTemplate(
    "commands/graph-system.md",
    GRAPH_SYSTEM_OWNERSHIP_MARKER,
  );

  const l1SkillAction = ensureSkillLink(paths.l1SkillLink, sourceRoot, home);
  const aliasSkillAction = ensureSkillLink(
    paths.aliasL1SkillLink,
    sourceRoot,
    home,
  );
  const gsSkillAction = ensureSkillLink(
    paths.graphSystemSkillLink,
    realpathSync(paths.graphSystemSource),
    home,
  );
  const l1CmdAction = ensureCommand(
    paths.l1CommandFile,
    primaryTemplate,
    OWNERSHIP_MARKER,
    configHome,
  );
  const aliasCmdAction = ensureCommand(
    paths.aliasL1CommandFile,
    aliasL1Template,
    LEGACY_L1_OWNERSHIP_MARKER,
    configHome,
  );
  const gsCmdAction = ensureCommand(
    paths.graphSystemCommandFile,
    gsTemplate,
    GRAPH_SYSTEM_OWNERSHIP_MARKER,
    configHome,
  );

  return {
    ok: true,
    explorer_l1: {
      skill: { path: paths.l1SkillLink, action: l1SkillAction },
      command: { path: paths.l1CommandFile, action: l1CmdAction },
    },
    alias_l1: {
      skill: { path: paths.aliasL1SkillLink, action: aliasSkillAction },
      command: { path: paths.aliasL1CommandFile, action: aliasCmdAction },
    },
    graph_system: {
      skill: { path: paths.graphSystemSkillLink, action: gsSkillAction },
      command: { path: paths.graphSystemCommandFile, action: gsCmdAction },
    },
    restart_guidance: RESTART_GUIDANCE,
  };
}

export function status() {
  const sourceRoot = skillSourceRoot();
  const paths = installPaths();
  return {
    l1: {
      skill: inspectSkill(paths.l1SkillLink, sourceRoot),
      command: inspectCommand(paths.l1CommandFile, OWNERSHIP_MARKER),
    },
    graph_system: {
      skill: inspectSkill(paths.graphSystemSkillLink, paths.graphSystemSource),
      command: inspectCommand(
        paths.graphSystemCommandFile,
        GRAPH_SYSTEM_OWNERSHIP_MARKER,
      ),
    },
    paths,
  };
}

export function uninstall() {
  const sourceRoot = skillSourceRoot();
  const paths = installPaths();
  /** @type {string[]} */
  const removed = [];

  const pairs = [
    [paths.l1SkillLink, () => inspectSkill(paths.l1SkillLink, sourceRoot).owned],
    [
      paths.aliasL1SkillLink,
      () => inspectSkill(paths.aliasL1SkillLink, sourceRoot).owned,
    ],
    [
      paths.graphSystemSkillLink,
      () => inspectSkill(paths.graphSystemSkillLink, paths.graphSystemSource).owned,
    ],
    [
      paths.l1CommandFile,
      () => inspectCommand(paths.l1CommandFile, OWNERSHIP_MARKER).owned,
    ],
    [
      paths.aliasL1CommandFile,
      () => inspectCommand(paths.aliasL1CommandFile, LEGACY_L1_OWNERSHIP_MARKER).owned,
    ],
    [
      paths.graphSystemCommandFile,
      () =>
        inspectCommand(paths.graphSystemCommandFile, GRAPH_SYSTEM_OWNERSHIP_MARKER)
          .owned,
    ],
  ];

  for (const [p, isOwned] of pairs) {
    if (pathExists(p) && isOwned()) {
      rmSync(p, { force: true });
      removed.push(p);
    } else if (pathExists(p) && !isOwned()) {
      throw new L1Error(`refusing to remove unowned path: ${p}`);
    }
  }

  return { ok: true, removed, restart_guidance: RESTART_GUIDANCE };
}

/**
 * @param {string[]} argv
 */
export async function main(argv) {
  try {
    const cmd = argv[0] || "status";
    let result;
    switch (cmd) {
      case "install":
        result = install();
        break;
      case "status":
        result = status();
        break;
      case "uninstall":
        result = uninstall();
        break;
      default:
        throw new Error("usage: install | status | uninstall");
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${sanitizeErrorMessage(err)}\n`);
    return 1;
  }
}

const isDirect =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  main(process.argv.slice(2)).then((c) => {
    process.exitCode = c;
  });
}
