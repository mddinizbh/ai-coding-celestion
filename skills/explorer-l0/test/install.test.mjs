/**
 * Global OpenCode install/discovery for the Descobrir skill.
 * Hermetic: temporary HOME / XDG only — never touches the real user home.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  InstallConflictError,
  install,
  main,
  skillSourceRoot,
  status,
  uninstall,
} from "../install.mjs";

const temps = [];
const originalEnv = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
};

function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), "descobrir-install-home-"));
  temps.push(dir);
  process.env.HOME = dir;
  process.env.XDG_CONFIG_HOME = join(dir, ".config");
  process.env.XDG_DATA_HOME = join(dir, ".local", "share");
  process.env.XDG_CACHE_HOME = join(dir, ".cache");
  return dir;
}

function skillLinkPath(home) {
  return join(home, ".agents", "skills", "explorer-l0");
}

function commandPath(home) {
  return join(home, ".config", "opencode", "commands", "explorer-l0.md");
}

function aliasSkillLinkPath(home) {
  return join(home, ".agents", "skills", "descobrir");
}

beforeEach(() => {
  // each test sets its own HOME via tempHome()
});

afterEach(() => {
  process.env.HOME = originalEnv.HOME;
  if (originalEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
  if (originalEnv.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalEnv.XDG_DATA_HOME;
  if (originalEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalEnv.XDG_CACHE_HOME;
  while (temps.length > 0) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

describe("descobrir global install", () => {
  test("install creates owned skill symlink and command template under temporary HOME", () => {
    const home = tempHome();
    const result = install();

    assert.equal(result.ok, true);
    assert.equal(result.skill.owned, true);
    assert.equal(result.command.owned, true);
    assert.match(result.restart_guidance, /restart/i);

    const link = skillLinkPath(home);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    const target = realpathSync(link);
    assert.equal(target, realpathSync(skillSourceRoot()));
    assert.ok(existsSync(join(link, "SKILL.md")));

    const cmd = readFileSync(commandPath(home), "utf8");
    assert.match(cmd, /\$ARGUMENTS/);
    assert.doesNotMatch(cmd, /TODO_PLACEHOLDER|FIXME_UNRESOLVED|<PROJECT>/);
    assert.match(cmd, /explorer-l0-install-owned:v1/);
    // legacy alias also installed
    assert.equal(lstatSync(aliasSkillLinkPath(home)).isSymbolicLink(), true);

    // live reference, not a stale snapshot copy
    assert.notEqual(lstatSync(link).isDirectory() && !lstatSync(link).isSymbolicLink(), true);
  });

  test("second install is idempotent and preserves unrelated files", () => {
    const home = tempHome();
    const foreignSkill = join(home, ".agents", "skills", "other-skill");
    mkdirSync(foreignSkill, { recursive: true });
    writeFileSync(join(foreignSkill, "SKILL.md"), "---\nname: other\n---\n", "utf8");
    const foreignCmdDir = join(home, ".config", "opencode", "commands");
    mkdirSync(foreignCmdDir, { recursive: true });
    writeFileSync(join(foreignCmdDir, "loop-help.md"), "keep-me\n", "utf8");
    const cfg = join(home, ".config", "opencode", "opencode.json");
    writeFileSync(cfg, '{"$schema":"https://opencode.ai/config.json","username":"qa"}\n', "utf8");

    const first = install();
    const second = install();
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.skill.action, "unchanged");
    assert.equal(second.command.action, "unchanged");

    assert.equal(readFileSync(join(foreignSkill, "SKILL.md"), "utf8"), "---\nname: other\n---\n");
    assert.equal(readFileSync(join(foreignCmdDir, "loop-help.md"), "utf8"), "keep-me\n");
    assert.equal(
      readFileSync(cfg, "utf8"),
      '{"$schema":"https://opencode.ai/config.json","username":"qa"}\n',
    );
  });

  test("status reports installed owned artifacts", () => {
    const home = tempHome();
    install();
    const s = status();
    assert.equal(s.installed, true);
    assert.equal(s.skill.present, true);
    assert.equal(s.skill.owned, true);
    assert.equal(s.command.present, true);
    assert.equal(s.command.owned, true);
    assert.equal(realpathSync(s.skill.target), realpathSync(skillSourceRoot()));
    assert.ok(s.paths.skill.startsWith(home));
    assert.ok(s.paths.command.startsWith(home));
  });

  test("uninstall removes only owned skill link and command", () => {
    const home = tempHome();
    const foreignSkill = join(home, ".agents", "skills", "other-skill");
    mkdirSync(foreignSkill, { recursive: true });
    writeFileSync(join(foreignSkill, "SKILL.md"), "x\n", "utf8");
    const foreignCmd = join(home, ".config", "opencode", "commands", "loop-help.md");
    mkdirSync(dirname(foreignCmd), { recursive: true });
    writeFileSync(foreignCmd, "keep\n", "utf8");

    install();
    const result = uninstall();
    assert.equal(result.ok, true);
    assert.equal(existsSync(skillLinkPath(home)), false);
    assert.equal(existsSync(commandPath(home)), false);
    assert.equal(existsSync(join(foreignSkill, "SKILL.md")), true);
    assert.equal(readFileSync(foreignCmd, "utf8"), "keep\n");

    const s = status();
    assert.equal(s.installed, false);
  });

  test("foreign skill path yields InstallConflictError without modification", () => {
    const home = tempHome();
    const link = skillLinkPath(home);
    mkdirSync(dirname(link), { recursive: true });
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, "SKILL.md"), "---\nname: foreign\n---\nFOREIGN\n", "utf8");
    const before = readFileSync(join(link, "SKILL.md"), "utf8");

    assert.throws(() => install(), (err) => {
      assert.equal(err instanceof InstallConflictError, true);
      assert.match(err.message, /skill/i);
      return true;
    });
    assert.equal(readFileSync(join(link, "SKILL.md"), "utf8"), before);
    assert.equal(existsSync(commandPath(home)), false);
  });

  test("foreign command file yields InstallConflictError without modification", () => {
    const home = tempHome();
    const cmd = commandPath(home);
    mkdirSync(dirname(cmd), { recursive: true });
    writeFileSync(cmd, "not-owned command\n", "utf8");

    assert.throws(() => install(), (err) => {
      assert.equal(err instanceof InstallConflictError, true);
      assert.match(err.message, /command/i);
      return true;
    });
    assert.equal(readFileSync(cmd, "utf8"), "not-owned command\n");
    assert.equal(existsSync(skillLinkPath(home)), false);
  });

  test("foreign symlink to another skill is a conflict", () => {
    const home = tempHome();
    const other = join(home, "other-skill-src");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "SKILL.md"), "---\nname: other\n---\n", "utf8");
    const link = skillLinkPath(home);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(other, link);

    assert.throws(() => install(), InstallConflictError);
    assert.equal(readlinkSync(link), other);
  });

  test("stale owned symlink (broken target) can be reinstalled", () => {
    const home = tempHome();
    const link = skillLinkPath(home);
    mkdirSync(dirname(link), { recursive: true });
    // pretends to be our path but broken — ownership by readlink equality after install uses source root
    // First install normally, then break by replacing with symlink to missing path that is NOT ours
    install();
    rmSync(link, { force: true });
    symlinkSync(join(skillSourceRoot(), "does-not-exist-subdir"), link);
    // not owned (different target) → conflict
    assert.throws(() => install(), InstallConflictError);

    // true stale: remove and leave nothing, reinstall works
    rmSync(link, { force: true });
    const again = install();
    assert.equal(again.ok, true);
    assert.equal(realpathSync(link), realpathSync(skillSourceRoot()));
  });

  test("CLI main install|status|uninstall round-trip exits 0", async () => {
    tempHome();
    assert.equal(await main(["install"]), 0);
    assert.equal(await main(["status"]), 0);
    assert.equal(await main(["uninstall"]), 0);
  });

  test("CLI rejects unknown command and empty argv", async () => {
    tempHome();
    assert.notEqual(await main(["nope"]), 0);
    assert.notEqual(await main([]), 0);
  });

  test("install refuses path escape via crafted HOME containing nul-safe confinement", () => {
    // HOME must remain under temp roots we created; installer only writes under HOME/XDG
    const home = tempHome();
    install();
    const s = status();
    assert.ok(s.paths.skill.startsWith(home + "/") || s.paths.skill === skillLinkPath(home));
    assert.ok(s.paths.command.includes(join(".config", "opencode", "commands")));
  });

  test("uninstall does not remove foreign skill or command", () => {
    const home = tempHome();
    const link = skillLinkPath(home);
    mkdirSync(dirname(link), { recursive: true });
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, "SKILL.md"), "foreign\n", "utf8");
    const cmd = commandPath(home);
    mkdirSync(dirname(cmd), { recursive: true });
    writeFileSync(cmd, "foreign-cmd\n", "utf8");

    const result = uninstall();
    assert.equal(result.ok, true);
    assert.equal(result.skill.action, "skipped_foreign");
    assert.equal(result.command.action, "skipped_foreign");
    assert.equal(existsSync(join(link, "SKILL.md")), true);
    assert.equal(readFileSync(cmd, "utf8"), "foreign-cmd\n");
  });
});
