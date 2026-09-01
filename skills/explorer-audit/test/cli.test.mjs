import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", shell: false }).trim();
}

function makeRepo(files) {
  const cwd = mkdtempSync(join(tmpdir(), "audit-cli-"));
  git(cwd, ["init", "-q", "-b", "main"]);
  for (const [relativeFile, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, relativeFile)), { recursive: true });
    writeFileSync(join(cwd, relativeFile), body);
  }
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-q", "-m", "fixture"]);
  return { cwd, head: git(cwd, ["rev-parse", "HEAD"]) };
}

test("observations reads the pinned repository and omits repo_path from output", () => {
  const repo = makeRepo({
    "src/Client.kt":
      'class Client {\n  fun fetch() = RestTemplate().getForObject("/invoices/{id}", Invoice::class.java)\n}\n',
  });
  const result = spawnSync(
    "node",
    [
      "skills/explorer-audit/cli.mjs",
      "observations",
      "--namespace",
      "ns",
      "--run-id",
      "run-1",
      "--repos",
      `checkout=${repo.cwd}`,
      "--revision",
      repo.head,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.observations.length > 0);
  assert.equal(JSON.stringify(payload).includes(repo.cwd), false);
  rmSync(repo.cwd, { recursive: true, force: true });
});

test("observations requires run-id", () => {
  const result = spawnSync(
    "node",
    ["skills/explorer-audit/cli.mjs", "observations", "--namespace", "ns", "--repos", "checkout=/tmp", "--revision", "rev"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--run-id is required/);
});
