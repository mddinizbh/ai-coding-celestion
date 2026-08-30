/**
 * Hermetic tests for run status and cleanup.
 * No SQLite is touched; only the XDG cache runs dir is exercised.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  RunCleanupError,
  cleanupRun,
  cleanupStaleRuns,
  listRuns,
} from "../src/run-cleanup.mjs";

const temps = [];

/**
 * @param {string} dir
 * @param {object} descriptor
 */
function writeDescriptor(dir, descriptor) {
  writeFileSync(
    join(dir, "run-descriptor.json"),
    `${JSON.stringify(descriptor)}\n`,
    "utf8",
  );
}

/**
 * @param {string} dir
 */
function makeRunsDir() {
  const root = mkdtempSync(join(tmpdir(), "descobrir-runs-"));
  temps.push(root);
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true });
  return runsDir;
}

/**
 * @param {string} runsDir
 * @param {string} runId
 */
function makeRun(runsDir, runId) {
  const runRoot = join(runsDir, runId);
  mkdirSync(runRoot, { recursive: true });
  return runRoot;
}

beforeEach(() => {});
afterEach(() => {
  while (temps.length > 0) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

describe("listRuns", () => {
  test("returns empty when runs dir absent", () => {
    const runsDir = join(mkdtempSync(join(tmpdir(), "no-")), "absent");
    const out = listRuns(runsDir);
    assert.equal(out.runs_dir_present, false);
    assert.deepEqual(out.runs, []);
  });

  test("lists prepared and incomplete runs without absolute paths", () => {
    const runsDir = makeRunsDir();
    // prepared run with descriptor + 2/2 payloads
    const prepared = makeRun(runsDir, "run-prepared");
    writeDescriptor(prepared, {
      version: 1,
      status: "prepared",
      run_id: "run-prepared",
      chunk_index: {
        version: 1,
        chunks: [
          { chunk_key: "c1", fact_keys: ["f1"], content_sha256: "a".repeat(64), byte_length: 1, fact_count: 1 },
          { chunk_key: "c2", fact_keys: ["f2"], content_sha256: "b".repeat(64), byte_length: 1, fact_count: 1 },
        ],
      },
    });
    mkdirSync(join(prepared, "explorer", "payloads"), { recursive: true });
    writeFileSync(join(prepared, "explorer", "payloads", "c1.json"), "{}", "utf8");
    writeFileSync(join(prepared, "explorer", "payloads", "c2.json"), "{}", "utf8");

    // incomplete run with no descriptor
    makeRun(runsDir, "run-incomplete");

    // partial run with descriptor but only 1 of 2 payloads
    const partial = makeRun(runsDir, "run-partial");
    writeDescriptor(partial, {
      version: 1,
      status: "prepared",
      run_id: "run-partial",
      chunk_index: {
        version: 1,
        chunks: [
          { chunk_key: "c1", fact_keys: ["f1"], content_sha256: "a".repeat(64), byte_length: 1, fact_count: 1 },
          { chunk_key: "c2", fact_keys: ["f2"], content_sha256: "b".repeat(64), byte_length: 1, fact_count: 1 },
        ],
      },
    });
    mkdirSync(join(partial, "explorer", "payloads"), { recursive: true });
    writeFileSync(join(partial, "explorer", "payloads", "c1.json"), "{}", "utf8");

    const out = listRuns(runsDir);
    assert.equal(out.runs_dir_present, true);
    assert.equal(out.runs.length, 3);
    const byId = Object.fromEntries(out.runs.map((r) => [r.run_id, r]));
    assert.equal(byId["run-prepared"].state, "prepared");
    assert.equal(byId["run-prepared"].expected_payloads, 2);
    assert.equal(byId["run-prepared"].present_payloads, 2);
    assert.equal(byId["run-incomplete"].state, "incomplete");
    assert.equal(byId["run-incomplete"].expected_payloads, null);
    assert.equal(byId["run-partial"].state, "incomplete");
    assert.equal(byId["run-partial"].present_payloads, 1);

    // No absolute paths leak in any output object.
    const serialized = JSON.stringify(out);
    assert.ok(!serialized.includes("/private/"));
    assert.ok(!serialized.includes("/tmp/"));
  });

  test("ignores non-run entries and names that are not safe run_ids", () => {
    const runsDir = makeRunsDir();
    writeFileSync(join(runsDir, "stray-file.txt"), "x", "utf8");
    // Names that fail RUN_ID_RE: leading dot, embedded whitespace.
    writeFileSync(join(runsDir, ".hidden"), "x", "utf8");
    mkdirSync(join(runsDir, "has space"), { recursive: true });
    const out = listRuns(runsDir);
    assert.equal(out.runs.length, 0);
  });

  test("run_id with unsafe characters rejected at cleanupRun", () => {
    const runsDir = makeRunsDir();
    assert.throws(
      () => cleanupRun(runsDir, "../escape"),
      RunCleanupError,
    );
    assert.throws(
      () => cleanupRun(runsDir, ""),
      RunCleanupError,
    );
  });
});

describe("cleanupRun", () => {
  test("removes incomplete run root", () => {
    const runsDir = makeRunsDir();
    makeRun(runsDir, "run-1");
    const res = cleanupRun(runsDir, "run-1");
    assert.equal(res.removed, true);
    assert.equal(res.run_id, "run-1");
    assert.equal(res.state, "incomplete");
    assert.equal(res.worktrees_removed, 0);
  });

  test("refuses prepared run without force", () => {
    const runsDir = makeRunsDir();
    const runRoot = makeRun(runsDir, "run-keep");
    writeDescriptor(runRoot, {
      version: 1,
      status: "prepared",
      run_id: "run-keep",
      chunk_index: {
        version: 1,
        chunks: [
          { chunk_key: "c1", fact_keys: ["f1"], content_sha256: "a".repeat(64), byte_length: 1, fact_count: 1 },
        ],
      },
    });
    mkdirSync(join(runRoot, "explorer", "payloads"), { recursive: true });
    writeFileSync(join(runRoot, "explorer", "payloads", "c1.json"), "{}", "utf8");

    const res = cleanupRun(runsDir, "run-keep");
    assert.equal(res.removed, false);
    assert.equal(res.state, "prepared");
    assert.match(res.reason ?? "", /pass --force to remove/);
    // run dir still present
    assert.ok(statSync(runRoot));
  });

  test("force removes prepared run", () => {
    const runsDir = makeRunsDir();
    const runRoot = makeRun(runsDir, "run-keep");
    writeDescriptor(runRoot, {
      version: 1,
      status: "prepared",
      run_id: "run-keep",
      chunk_index: {
        version: 1,
        chunks: [
          { chunk_key: "c1", fact_keys: ["f1"], content_sha256: "a".repeat(64), byte_length: 1, fact_count: 1 },
        ],
      },
    });
    mkdirSync(join(runRoot, "explorer", "payloads"), { recursive: true });
    writeFileSync(join(runRoot, "explorer", "payloads", "c1.json"), "{}", "utf8");

    const res = cleanupRun(runsDir, "run-keep", { force: true });
    assert.equal(res.removed, true);
  });

  test("absent run returns unknown state and removed false", () => {
    const runsDir = makeRunsDir();
    const res = cleanupRun(runsDir, "never-existed");
    assert.equal(res.removed, false);
    assert.equal(res.state, "unknown");
  });

  test("removes leftover worktree subdir via rm fallback when no source-repo", () => {
    const runsDir = makeRunsDir();
    const runRoot = makeRun(runsDir, "run-wt");
    mkdirSync(join(runRoot, "wt-deadbeef-run-wt"), { recursive: true });
    const res = cleanupRun(runsDir, "run-wt");
    assert.equal(res.removed, true);
    assert.equal(res.worktrees_removed, 1);
  });

  test("uses ensureWorktreeAbsent when source-repo provided", () => {
    const runsDir = makeRunsDir();
    const runRoot = makeRun(runsDir, "run-wt2");
    mkdirSync(join(runRoot, "wt-deadbeef-run-wt2"), { recursive: true });
    /** @type {{ calls: Array<{ repo: string, path: string }> }} */
    const calls = { calls: [] };
    const fakeEnsure = (repo, path) => {
      calls.calls.push({ repo, path });
      // simulate git removing the dir
      rmSync(path, { recursive: true, force: true });
      return { degraded: false };
    };
    const res = cleanupRun(runsDir, "run-wt2", {
      sourceRepo: "/some/repo",
      ensureWorktreeAbsent: fakeEnsure,
    });
    assert.equal(res.removed, true);
    assert.equal(res.worktrees_removed, 1);
    assert.equal(calls.calls.length, 1);
    assert.equal(calls.calls[0].repo, "/some/repo");
  });
});

describe("cleanupStaleRuns", () => {
  test("removes only incomplete runs, skips prepared", () => {
    const runsDir = makeRunsDir();
    // incomplete
    makeRun(runsDir, "stale-1");
    makeRun(runsDir, "stale-2");
    // prepared
    const keep = makeRun(runsDir, "keep-1");
    writeDescriptor(keep, {
      version: 1,
      status: "prepared",
      run_id: "keep-1",
      chunk_index: {
        version: 1,
        chunks: [
          { chunk_key: "c1", fact_keys: ["f1"], content_sha256: "a".repeat(64), byte_length: 1, fact_count: 1 },
        ],
      },
    });
    mkdirSync(join(keep, "explorer", "payloads"), { recursive: true });
    writeFileSync(join(keep, "explorer", "payloads", "c1.json"), "{}", "utf8");

    const res = cleanupStaleRuns(runsDir);
    assert.equal(res.removed.length, 2);
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].run_id, "keep-1");
    const remaining = readdirSync(runsDir).sort();
    assert.deepEqual(remaining, ["keep-1"]);
  });

  test("with force also removes prepared", () => {
    const runsDir = makeRunsDir();
    const keep = makeRun(runsDir, "keep-1");
    writeDescriptor(keep, {
      version: 1,
      status: "prepared",
      run_id: "keep-1",
      chunk_index: {
        version: 1,
        chunks: [
          { chunk_key: "c1", fact_keys: ["f1"], content_sha256: "a".repeat(64), byte_length: 1, fact_count: 1 },
        ],
      },
    });
    mkdirSync(join(keep, "explorer", "payloads"), { recursive: true });
    writeFileSync(join(keep, "explorer", "payloads", "c1.json"), "{}", "utf8");
    makeRun(runsDir, "stale-1");

    const res = cleanupStaleRuns(runsDir, { force: true });
    assert.equal(res.removed.length, 2);
    assert.equal(res.skipped.length, 0);
    assert.deepEqual(readdirSync(runsDir), []);
  });
});
