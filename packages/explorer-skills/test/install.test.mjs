import assert from "node:assert/strict";
import { describe, test, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync, lstatSync, mkdirSync, realpathSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { runAll } from "../src/install-all.mjs";
import { MARKER } from "../src/simple-skill-install.mjs";

describe("opencode-explorer install/status/uninstall for explorer-ops/audit + commands", () => {
  let tmpHome;
  let origHome;
  let origXdg;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(os.tmpdir(), "ox-uai31-"));
    origHome = process.env.HOME;
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = tmpHome;
    process.env.XDG_CONFIG_HOME = join(tmpHome, ".config");
  });

  afterEach(() => {
    process.env.HOME = origHome;
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("install adds explorer-ops, explorer-audit skills and 4 owned commands; status reports; uninstall removes only owned", async () => {
    // First run install - should succeed after impl
    const installRes = await runAll("install");
    assert.ok(installRes.ok, "install should succeed");
    assert.ok(installRes.explorer_ops, "should have explorer_ops result");
    assert.ok(installRes.explorer_audit, "should have explorer_audit result");
    assert.ok(installRes.explorer_indexer, "should report indexer command");
    assert.ok(installRes.explorer_auditor, "should report auditor command");
    // check marker in command files
    const cmdDir = join(process.env.XDG_CONFIG_HOME || join(tmpHome, ".config"), "opencode", "commands");
    const opsCmd = join(cmdDir, "explorer-ops.md");
    assert.ok(existsSync(opsCmd), "explorer-ops.md command should exist");
    const content = readFileSync(opsCmd, "utf8");
    assert.ok(content.includes(MARKER), "command must contain ownership marker");

    // status
    const statusRes = await runAll("status");
    assert.ok(statusRes.ok);
    // expect status to reflect owned pieces (minimally ok=true for now)

    // uninstall
    const unRes = await runAll("uninstall");
    assert.ok(unRes.ok);
    assert.ok(!existsSync(opsCmd), "uninstall should remove owned command");
  });

  test("status after install/uninstall reports truthful presence and ownership (probes symlinks + marker)", async () => {
    const cmdDir = join(process.env.XDG_CONFIG_HOME || join(tmpHome, ".config"), "opencode", "commands");
    const skillDir = join(tmpHome, ".agents", "skills");
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(cmdDir, { recursive: true });

    let status = await runAll("status");
    assert.ok(status.ok);
    // before install: should not claim owned
    assert.ok(!status.explorer_ops?.present, "pre-install status should not report present");

    await runAll("install");

    status = await runAll("status");
    assert.ok(status.explorer_ops?.present, "post-install status must probe and report present for ops skill");
    assert.ok(status.explorer_ops?.command_present, "post-install must report command_present");
    assert.ok(status.explorer_indexer?.command_present, "indexer command must be probed");
    assert.ok(status.explorer_auditor?.command_present, "auditor command must be probed");
    assert.ok(status.explorer_audit?.present, "audit skill present");

    await runAll("uninstall");

    status = await runAll("status");
    assert.ok(!status.explorer_ops?.present, "post-uninstall must report absent");
    assert.ok(!status.explorer_indexer?.command_present, "post-uninstall command absent");
  });

  test("install creates exactly the 4 marker-owned command files; status reflects all", async () => {
    await runAll("install");
    const cmdDir = join(process.env.XDG_CONFIG_HOME || join(tmpHome, ".config"), "opencode", "commands");
    const cmds = ["explorer-ops.md", "explorer-audit.md", "explorer-indexer.md", "explorer-auditor.md"];
    for (const c of cmds) {
      const p = join(cmdDir, c);
      assert.ok(existsSync(p), `${c} must exist`);
      assert.ok(readFileSync(p, "utf8").includes(MARKER), `${c} must have marker`);
    }
    const st = await runAll("status");
    assert.ok(st.explorer_ops?.command_present && st.explorer_audit?.command_present && st.explorer_indexer?.command_present && st.explorer_auditor?.command_present);
  });

  test("install never overwrites foreign command (no marker, even with $ARGUMENTS)", async () => {
    const cmdDir = join(process.env.XDG_CONFIG_HOME || join(tmpHome, ".config"), "opencode", "commands");
    mkdirSync(cmdDir, { recursive: true });
    const foreign = join(cmdDir, "explorer-ops.md");
    const foreignContent = "---\ndescription: foreign\n---\n\n# /explorer-ops\n\n$ARGUMENTS\n\nforeign body without marker";
    writeFileSync(foreign, foreignContent, "utf8");

    await runAll("install");

    const after = readFileSync(foreign, "utf8");
    assert.ok(after.includes("foreign body without marker"), "foreign command must be preserved (not overwritten)");
    assert.ok(!after.includes(MARKER), "foreign must not gain our marker");
  });

  test("install never replaces foreign skill symlink (not resolving to our source)", async () => {
    const skillLinkDir = join(tmpHome, ".agents", "skills");
    mkdirSync(skillLinkDir, { recursive: true });
    const foreignTarget = mkdtempSync(join(os.tmpdir(), "foreign-skill-"));
    // create a fake SKILL.md in foreign target so it looks valid
    writeFileSync(join(foreignTarget, "SKILL.md"), "# fake", "utf8");
    const linkPath = join(skillLinkDir, "explorer-ops");
    symlinkSync(foreignTarget, linkPath, process.platform === "win32" ? "junction" : null);

    await runAll("install");

    const real = realpathSync(linkPath);
    assert.ok(real.includes("foreign-skill"), "foreign symlink must be preserved, not replaced by installer");
    rmSync(foreignTarget, { recursive: true, force: true });
  });

  test("uninstall removes ONLY marker-owned commands and ONLY symlinks pointing to our source; preserves foreign", async () => {
    const cmdDir = join(process.env.XDG_CONFIG_HOME || join(tmpHome, ".config"), "opencode", "commands");
    mkdirSync(cmdDir, { recursive: true });
    const foreignCmd = join(cmdDir, "explorer-ops.md");
    writeFileSync(foreignCmd, "---\n---\n$ARGUMENTS\nforeign no marker", "utf8");

    const skillLinkDir = join(tmpHome, ".agents", "skills");
    mkdirSync(skillLinkDir, { recursive: true });
    const foreignTarget = mkdtempSync(join(os.tmpdir(), "foreign2-"));
    writeFileSync(join(foreignTarget, "SKILL.md"), "# f2", "utf8");
    symlinkSync(foreignTarget, join(skillLinkDir, "explorer-audit"));

    await runAll("install"); // creates our owned ones + marker cmds

    // now uninstall
    await runAll("uninstall");

    assert.ok(existsSync(foreignCmd), "foreign cmd preserved");
    const auditLink = join(skillLinkDir, "explorer-audit");
    assert.ok(existsSync(auditLink), "foreign symlink preserved");
    assert.ok(realpathSync(auditLink).includes("foreign2"), "still points to foreign");

    rmSync(foreignTarget, { recursive: true, force: true });
  });

  test("uninstall does not remove foreign explorer-l2 or explorer-query symlinks (expectedSource required)", async () => {
    const skillLinkDir = join(tmpHome, ".agents", "skills");
    mkdirSync(skillLinkDir, { recursive: true });
    const foreignL2 = mkdtempSync(join(os.tmpdir(), "foreign-l2-"));
    writeFileSync(join(foreignL2, "SKILL.md"), "# l2", "utf8");
    const l2Link = join(skillLinkDir, "explorer-l2");
    symlinkSync(foreignL2, l2Link);

    const foreignQ = mkdtempSync(join(os.tmpdir(), "foreign-q-"));
    writeFileSync(join(foreignQ, "SKILL.md"), "# q", "utf8");
    const qLink = join(skillLinkDir, "explorer-query");
    symlinkSync(foreignQ, qLink);

    await runAll("uninstall");

    assert.ok(existsSync(l2Link) && realpathSync(l2Link).includes("foreign-l2"), "foreign l2 symlink must survive");
    assert.ok(existsSync(qLink) && realpathSync(qLink).includes("foreign-q"), "foreign query symlink must survive");

    rmSync(foreignL2, { recursive: true, force: true });
    rmSync(foreignQ, { recursive: true, force: true });
  });

  test("foreign broken symlink (lexical target not our source) survives install and uninstall", async () => {
    const skillLinkDir = join(tmpHome, ".agents", "skills");
    mkdirSync(skillLinkDir, { recursive: true });
    const brokenForeign = join(skillLinkDir, "explorer-ops");
    // create broken symlink pointing to non-existent foreign path
    symlinkSync("/tmp/nonexistent-foreign-broken-uai31", brokenForeign);

    await runAll("install");
    assert.strictEqual(readlinkSync(brokenForeign), "/tmp/nonexistent-foreign-broken-uai31", "lexical target must be preserved after install");

    await runAll("uninstall");
    assert.strictEqual(readlinkSync(brokenForeign), "/tmp/nonexistent-foreign-broken-uai31", "lexical target must be preserved after uninstall");

    rmSync(brokenForeign, { force: true });
  });

  test("partial ownership status reports combined owned:false while preserving component fields", async () => {
    // owned command + foreign skill
    const cmdDir = join(process.env.XDG_CONFIG_HOME || join(tmpHome, ".config"), "opencode", "commands");
    mkdirSync(cmdDir, { recursive: true });
    const ownedCmd = join(cmdDir, "explorer-ops.md");
    writeFileSync(ownedCmd, `---\n---\n$ARGUMENTS\n<!-- ${MARKER} -->`, "utf8");

    const skillLinkDir = join(tmpHome, ".agents", "skills");
    mkdirSync(skillLinkDir, { recursive: true });
    const foreignSkill = mkdtempSync(join(os.tmpdir(), "foreign-partial-"));
    writeFileSync(join(foreignSkill, "SKILL.md"), "# f", "utf8");
    symlinkSync(foreignSkill, join(skillLinkDir, "explorer-ops"));

    const st = await runAll("status");
    const ops = st.explorer_ops;
    assert.ok(ops.command_present && ops.owned === false, "combined owned must be false on mixed");
    assert.ok(ops.present === true || ops.skill_present === true, "skill component present preserved");
    assert.ok(ops.command_present === true, "command component preserved");

    rmSync(foreignSkill, { recursive: true, force: true });
    rmSync(ownedCmd, { force: true });
  });
});
