import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { checkFreshness } from "../src/freshness.mjs";

function makeTempRepo(baseTmp, name) {
  const repoPath = join(baseTmp, name);
  mkdirSync(repoPath, { recursive: true });
  execSync("git init -q", { cwd: repoPath, stdio: "ignore" });
  execSync("git commit -q --allow-empty -m init", { cwd: repoPath, stdio: "ignore" });
  const head = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { repoPath, head };
}

function makeBehindRepo(baseTmp, name) {
  const repoPath = join(baseTmp, name);
  mkdirSync(repoPath, { recursive: true });
  execSync("git init -q", { cwd: repoPath, stdio: "ignore" });
  execSync("git commit -q --allow-empty -m base", { cwd: repoPath, stdio: "ignore" });
  const baseline = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execSync("git commit -q --allow-empty -m c1", { cwd: repoPath, stdio: "ignore" });
  execSync("git commit -q --allow-empty -m c2", { cwd: repoPath, stdio: "ignore" });
  const head = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { repoPath, baseline, head, behind: 2 };
}

function makeDetachedRepo(baseTmp, name) {
  const repoPath = join(baseTmp, name);
  mkdirSync(repoPath, { recursive: true });
  execSync("git init -q", { cwd: repoPath, stdio: "ignore" });
  execSync("git commit -q --allow-empty -m base", { cwd: repoPath, stdio: "ignore" });
  const baseline = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execSync("git commit -q --allow-empty -m extra", { cwd: repoPath, stdio: "ignore" });
  execSync(`git checkout -q ${baseline}`, { cwd: repoPath, stdio: "ignore" });
  const head = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return { repoPath, baseline, head, branch: "detached" };
}

describe("freshness — stale baseline visibility (hermetic)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "freshness-hermetic-"));

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("throws explicit error (not silent) when no accepted baseline", () => {
    const { repoPath } = makeTempRepo(tmp, "no-baseline");
    assert.throws(
      () =>
        checkFreshness({
          l0DbPath: join(tmp, "empty.sqlite"),
          namespace: "ns",
          repos: [{ logical_repo: "orphan", repo_path: repoPath }],
        }),
      /no accepted baseline|unable to open database/
    );
  });

  it("reports fresh repo (behind=0, fresh=true, branch name)", () => {
    const { repoPath, head } = makeTempRepo(tmp, "fresh");
    const fakeLoad = () => [{ logical_repo: "svc", source_revision: head }];
    const res = checkFreshness({
      l0DbPath: ":memory:",
      namespace: "ns",
      repos: [{ logical_repo: "svc", repo_path: repoPath }],
      _loadAcceptedBaselines: fakeLoad,
    });
    assert.equal(res.length, 1);
    assert.equal(res[0].fresh, true);
    assert.equal(res[0].behind, 0);
    assert.equal(res[0].branch, "master");
    assert.equal(res[0].baseline_revision, head);
    assert.equal(res[0].head_revision, head);
  });

  it("reports behind repo (+N commits)", () => {
    const { repoPath, baseline, head } = makeBehindRepo(tmp, "behind");
    const fakeLoad = () => [{ logical_repo: "svc", source_revision: baseline }];
    const res = checkFreshness({
      l0DbPath: ":memory:",
      namespace: "ns",
      repos: [{ logical_repo: "svc", repo_path: repoPath }],
      _loadAcceptedBaselines: fakeLoad,
    });
    assert.equal(res[0].fresh, false);
    assert.equal(res[0].behind, 2);
    assert.ok(res[0].head_revision !== baseline);
  });

  it("reports detached HEAD and branch name correctly", () => {
    const { repoPath, baseline, head } = makeDetachedRepo(tmp, "detached");
    const fakeLoad = () => [{ logical_repo: "svc", source_revision: baseline }];
    const res = checkFreshness({
      l0DbPath: ":memory:",
      namespace: "ns",
      repos: [{ logical_repo: "svc", repo_path: repoPath }],
      _loadAcceptedBaselines: fakeLoad,
    });
    assert.equal(res[0].branch, "detached");
    assert.equal(res[0].behind, 0);
    assert.equal(res[0].fresh, true);
  });
});
