import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSkillsRoot } from "./resolve-skills-root.mjs";
import {
  installSimpleSkill,
  uninstallSimpleSkill,
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
    out.deps = await runDeps("status");
    out.ok = true;
    return out;
  }

  if (action === "uninstall") {
    out.explorer_l0 = await runSkillInstaller(root, "explorer-l0", "uninstall");
    out.explorer_l1 = await runSkillInstaller(root, "explorer-l1", "uninstall");
    out.explorer_l2 = uninstallSimpleSkill("explorer-l2", "explorer-l2.md");
    out.explorer_query = uninstallSimpleSkill(
      "explorer-query",
      "explorer-query.md",
    );
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
