/**
 * Thin wrapper: foreign-project E2E must pass in hermetic fake mode.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const E2E = join(HERE, "..", "e2e", "run.mjs");

function runE2E(args) {
  return spawnSync(process.execPath, [E2E, ...args], {
    encoding: "utf8",
    shell: false,
    timeout: 120_000,
  });
}

describe("foreign-project E2E", () => {
  test("--graphify fake full lifecycle prints all true flags", () => {
    const r = runE2E(["--graphify", "fake", "--scenario", "full"]);
    assert.equal(r.status, 0, `stderr=${r.stderr}\nstdout=${r.stdout}`);
    const line = r.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .pop();
    const report = JSON.parse(line);
    for (const k of [
      "installed",
      "prepared",
      "persisted",
      "accepted",
      "projected",
      "source_unchanged",
      "cleaned",
    ]) {
      assert.equal(report[k], true, `${k} must be true: ${line}`);
    }
  });

  test("kill-after-prepare + cleanup leaves no candidate and cleans runs", () => {
    const r = runE2E([
      "--graphify",
      "fake",
      "--scenario",
      "kill-after-prepare",
    ]);
    assert.equal(r.status, 0, `stderr=${r.stderr}\nstdout=${r.stdout}`);
    const line = r.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .pop();
    const report = JSON.parse(line);
    assert.equal(report.installed, true);
    assert.equal(report.prepared, true);
    assert.equal(report.cleaned, true);
    assert.equal(report.persisted, false);
    assert.equal(report.candidate_count, 0);
  });
});
