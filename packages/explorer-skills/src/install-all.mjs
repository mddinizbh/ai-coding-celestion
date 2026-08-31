import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSkillsRoot } from "./resolve-skills-root.mjs";
import {
  installSimpleSkill,
  uninstallSimpleSkill,
  statusSimpleSkill,
  statusCommand,
  MARKER,
} from "./simple-skill-install.mjs";
import { runDeps } from "./install-deps.mjs";

const RESTART =
  "Quit and restart OpenCode so skill and command discovery reload.";

/**
 * Dynamic import install() from explorer-l0 / explorer-l1 install.mjs
 * @param {string} skillsRoot
 * @param {string} name
 */
async function runSkillInstaller(skillsRoot, name, action) {
  const installPath = join(skillsRoot, name, "install.mjs");
  if (!existsSync(installPath)) {
    throw new Error(`missing ${installPath}`);
  }
  const mod = await import(pathToFileURL(installPath).href);
  if (action === "install") return mod.install();
  if (action === "status") return mod.status();
  if (action === "uninstall") return mod.uninstall();
  throw new Error(`unknown action ${action}`);
}

function l2Command() {
  return `---
description: Explorer L2 — bind journeys to system edges
---

# /explorer-l2

Run the **explorer-l2** skill for: $ARGUMENTS

<!-- ${MARKER} -->

Bind JourneySpec steps to explorer-l1 edges. Report gaps honestly.
CLI: \`node <skill>/cli.mjs bind --spec … --edges …\`
`;
}

function queryCommand() {
  return `---
description: Explorer query — ensure / answer / generate-human
---

# /explorer-query

Run the **explorer-query** skill for: $ARGUMENTS

<!-- ${MARKER} -->

Orchestrate build↑ (ensure) and query↓ (answer / context-pack).
Human docs on-demand: generate-human → .explorer/L{N}.md
Prefer this over broad repo grep.
`;
}

/**
 * Locate canonical command markdown (supports packaged flat copy, per-skill commands/, and monorepo agents/ layout).
 * No machine-specific paths.
 */
function findCommandSource(root, cmdName) {
  const flat = join(root, cmdName);
  if (existsSync(flat)) return flat;
  const skillCmd = join(root, cmdName.replace(".md", ""), "commands", cmdName);
  if (existsSync(skillCmd)) return skillCmd;
  const monoAgent = join(root, "..", "agents", "opencode", "commands", cmdName);
  if (existsSync(monoAgent)) return monoAgent;
  throw new Error(`canonical command markdown not found for ${cmdName}`);
}

/**
 * @param {"install"|"status"|"uninstall"} action
 */
export async function runAll(action) {
  const root = resolveSkillsRoot();
  /** @type {Record<string, unknown>} */
  const out = {
    skills_root: root,
    restart_guidance: RESTART,
  };

  if (action === "install") {
    out.explorer_l0 = await runSkillInstaller(root, "explorer-l0", "install");
    out.explorer_l1 = await runSkillInstaller(root, "explorer-l1", "install");
    out.explorer_l2 = installSimpleSkill(
      "explorer-l2",
      join(root, "explorer-l2"),
      { commandName: "explorer-l2.md", commandBody: l2Command() },
    );
    out.explorer_query = installSimpleSkill(
      "explorer-query",
      join(root, "explorer-query"),
      { commandName: "explorer-query.md", commandBody: queryCommand() },
    );
    // explorer-ops and explorer-audit skills + their commands from canonical
    const opsBody = readFileSync(findCommandSource(root, "explorer-ops.md"), "utf8");
    out.explorer_ops = installSimpleSkill(
      "explorer-ops",
      join(root, "explorer-ops"),
      { commandName: "explorer-ops.md", commandBody: opsBody },
    );
    const auditBody = readFileSync(findCommandSource(root, "explorer-audit.md"), "utf8");
    out.explorer_audit = installSimpleSkill(
      "explorer-audit",
      join(root, "explorer-audit"),
      { commandName: "explorer-audit.md", commandBody: auditBody },
    );
    // agent commands for indexer/auditor (command-only via same atomic+marker)
    const idxBody = readFileSync(findCommandSource(root, "explorer-indexer.md"), "utf8");
    out.explorer_indexer = installSimpleSkill(null, null, {
      commandName: "explorer-indexer.md",
      commandBody: idxBody,
    });
    const audBody = readFileSync(findCommandSource(root, "explorer-auditor.md"), "utf8");
    out.explorer_auditor = installSimpleSkill(null, null, {
      commandName: "explorer-auditor.md",
      commandBody: audBody,
    });
    // Own complementary skills — symlink only, no command file (best effort).
    out.own_extra = {};
    for (const name of [
      "architecture-canvas",
      "architecture-diagrams",
      "db-setup",
    ]) {
      const dir = join(root, name);
      if (existsSync(join(dir, "SKILL.md"))) {
        try {
          out.own_extra[name] = installSimpleSkill(name, dir);
        } catch (e) {
          out.own_extra[name] = { error: e.message };
        }
      } else {
        out.own_extra[name] = { skipped: "not present in skills root" };
      }
    }
    // Third-party dependency skills (skills.deps.json) — copy, best effort.
    out.deps = await runDeps("install");
    out.ok = true;
    return out;
  }

  if (action === "status") {
    out.explorer_l0 = await runSkillInstaller(root, "explorer-l0", "status");
    out.explorer_l1 = await runSkillInstaller(root, "explorer-l1", "status");
    // truthful probes (marker for cmds; exact source match for symlinks)
    const opsSrc = join(root, "explorer-ops");
    const opsSkill = statusSimpleSkill("explorer-ops", opsSrc);
    const opsCmd = statusCommand("explorer-ops.md");
    out.explorer_ops = {
      present: opsSkill.present || opsCmd.present,
      owned: !!(opsSkill.owned && opsCmd.owned),
      skill_present: opsSkill.present,
      skill_owned: opsSkill.owned,
      command_present: opsCmd.present,
      command_owned: opsCmd.owned,
      skill_source: opsSrc,
    };
    const auditSrc = join(root, "explorer-audit");
    const auditSkill = statusSimpleSkill("explorer-audit", auditSrc);
    const auditCmd = statusCommand("explorer-audit.md");
    out.explorer_audit = {
      present: auditSkill.present || auditCmd.present,
      owned: !!(auditSkill.owned && auditCmd.owned),
      skill_present: auditSkill.present,
      skill_owned: auditSkill.owned,
      command_present: auditCmd.present,
      command_owned: auditCmd.owned,
      skill_source: auditSrc,
    };
    out.explorer_indexer = statusCommand("explorer-indexer.md");
    out.explorer_auditor = statusCommand("explorer-auditor.md");
    out.deps = await runDeps("status");
    out.ok = true;
    return out;
  }

  if (action === "uninstall") {
    out.explorer_l0 = await runSkillInstaller(root, "explorer-l0", "uninstall");
    out.explorer_l1 = await runSkillInstaller(root, "explorer-l1", "uninstall");
    const l2Src = join(root, "explorer-l2");
    const qSrc = join(root, "explorer-query");
    out.explorer_l2 = uninstallSimpleSkill("explorer-l2", "explorer-l2.md", l2Src);
    out.explorer_query = uninstallSimpleSkill("explorer-query", "explorer-query.md", qSrc);
    const opsSrc = join(root, "explorer-ops");
    const auditSrc = join(root, "explorer-audit");
    out.explorer_ops = uninstallSimpleSkill("explorer-ops", "explorer-ops.md", opsSrc);
    out.explorer_audit = uninstallSimpleSkill("explorer-audit", "explorer-audit.md", auditSrc);
    out.explorer_indexer = uninstallSimpleSkill(null, "explorer-indexer.md");
    out.explorer_auditor = uninstallSimpleSkill(null, "explorer-auditor.md");
    out.deps = await runDeps("uninstall");
    out.ok = true;
    return out;
  }

  throw new Error(`unknown action: ${action}`);
}

/**
 * Graphify setup via explorer-l0 CLI
 */
export async function setupGraphify() {
  const root = resolveSkillsRoot();
  const cli = join(root, "explorer-l0", "cli.mjs");
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [cli, "setup"], {
    encoding: "utf8",
    shell: false,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status === 0 ? 0 : r.status || 1;
}

export async function setupStatus() {
  const root = resolveSkillsRoot();
  const cli = join(root, "explorer-l0", "cli.mjs");
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [cli, "setup-status"], {
    encoding: "utf8",
    shell: false,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status === 0 ? 0 : r.status || 1;
}
