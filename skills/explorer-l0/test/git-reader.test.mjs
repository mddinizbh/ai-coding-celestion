/**
 * Public seam: pinned Git reader (readAtRevision / repositorySnapshot).
 * Evidence must come from committed objects — never dirty working-tree bytes.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";

import {
  GitSourceError,
  bindReadAtRevision,
  readAtRevision,
  repositorySnapshot,
  validateRelativePath,
  validateRevision,
} from "../src/git-reader.mjs";
import { installFakeGit } from "./fake-git.mjs";

const temps = [];

function fixtureGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", shell: false }).trim();
}

function makeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "descobrir-git-reader-"));
  temps.push(cwd);
  fixtureGit(cwd, ["init", "-q", "-b", "main"]);
  writeFileSync(join(cwd, "keep.txt"), "keep-v1\n");
  writeFileSync(join(cwd, "modify.txt"), "modify-v1\n");
  execFileSync("mkdir", ["-p", join(cwd, "nested")], { shell: false });
  writeFileSync(join(cwd, "nested", "file.txt"), "nested-v1\n");
  fixtureGit(cwd, ["add", "."]);
  fixtureGit(cwd, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-q",
    "-m",
    "initial",
  ]);
  const head = fixtureGit(cwd, ["rev-parse", "HEAD"]);
  writeFileSync(join(cwd, "modify.txt"), "modify-DIRTY\n");
  writeFileSync(join(cwd, "untracked.txt"), "new\n");
  return { cwd, head };
}

let fixture;

before(() => {
  fixture = makeRepo();
});

after(() => {
  while (temps.length > 0) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

afterEach(() => {
  // keep shared fixture; local temps cleaned in after
});

describe("validateRevision", () => {
  test("accepts 7-64 lowercase hex", () => {
    assert.doesNotThrow(() => validateRevision("abcdef0"));
    assert.doesNotThrow(() => validateRevision("0".repeat(40)));
    assert.doesNotThrow(() => validateRevision("a".repeat(64)));
  });

  test("rejects malformed revisions", () => {
    assert.throws(() => validateRevision("abcdef"), GitSourceError);
    assert.throws(() => validateRevision("ABCDEF0"), GitSourceError);
    assert.throws(() => validateRevision("g".repeat(7)), GitSourceError);
    assert.throws(() => validateRevision(""), GitSourceError);
    assert.throws(() => validateRevision(null), GitSourceError);
  });
});

describe("validateRelativePath", () => {
  test("accepts safe relative paths", () => {
    assert.doesNotThrow(() => validateRelativePath("keep.txt"));
    assert.doesNotThrow(() => validateRelativePath("nested/file.txt"));
  });

  test("rejects traversal, absolute, reserved, and empty segments", () => {
    assert.throws(() => validateRelativePath("../x"), GitSourceError);
    assert.throws(() => validateRelativePath("/etc/passwd"), GitSourceError);
    assert.throws(() => validateRelativePath("a/./b"), GitSourceError);
    assert.throws(() => validateRelativePath("a//b"), GitSourceError);
    assert.throws(() => validateRelativePath("a@b"), GitSourceError);
    assert.throws(() => validateRelativePath(""), GitSourceError);
  });

  test("rejects Git pathspec magic and shell-like metacharacters", () => {
    const magic = [
      ":(exclude)secret.go",
      "src/*.go",
      "src/foo[bar].go",
      "src/foo?.go",
      "a:(b",
      "x;y",
      "x|y",
      "x&y",
      "x$USER",
      "x`id`",
      "x$(id)",
      "a'b",
      'a"b',
      "a<b",
      "a>b",
      "a{b}",
      "a!b",
    ];
    for (const p of magic) {
      assert.throws(() => validateRelativePath(p), GitSourceError, p);
    }
  });

  test("still accepts legitimate repository-relative paths", () => {
    assert.doesNotThrow(() => validateRelativePath("domains/iam/controller/service_register.go"));
    assert.doesNotThrow(() => validateRelativePath("src/foo-bar_baz.v2.ts"));
    assert.doesNotThrow(() => validateRelativePath("README.md"));
  });
});

describe("readAtRevision", () => {
  test("returns committed bytes when working tree file differs", () => {
    const buf = readAtRevision({
      cwd: fixture.cwd,
      revision: fixture.head,
      path: "modify.txt",
    });
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.toString("utf8"), "modify-v1\n");
    assert.notEqual(buf.toString("utf8"), "modify-DIRTY\n");
  });

  test("returns nested committed file bytes", () => {
    const buf = readAtRevision({
      cwd: fixture.cwd,
      revision: fixture.head,
      path: "nested/file.txt",
    });
    assert.equal(buf.toString("utf8"), "nested-v1\n");
  });

  test("bindReadAtRevision matches repo-verifier injection shape", () => {
    const reader = bindReadAtRevision(fixture.cwd);
    const buf = reader({ revision: fixture.head, path: "keep.txt" });
    assert.equal(buf.toString("utf8"), "keep-v1\n");
  });

  test("throws GitSourceError for absent path at revision", () => {
    assert.throws(
      () =>
        readAtRevision({
          cwd: fixture.cwd,
          revision: fixture.head,
          path: "nope.txt",
        }),
      GitSourceError,
    );
  });

  test("throws GitSourceError for absent revision object", () => {
    assert.throws(
      () =>
        readAtRevision({
          cwd: fixture.cwd,
          revision: "0".repeat(40),
          path: "keep.txt",
        }),
      GitSourceError,
    );
  });

  test("throws GitSourceError before spawn for invalid revision format", () => {
    assert.throws(
      () =>
        readAtRevision({
          cwd: fixture.cwd,
          revision: "not-hex!",
          path: "keep.txt",
        }),
      GitSourceError,
    );
  });

  test("throws GitSourceError for path traversal", () => {
    assert.throws(
      () =>
        readAtRevision({
          cwd: fixture.cwd,
          revision: fixture.head,
          path: "../keep.txt",
        }),
      GitSourceError,
    );
  });

  test("throws GitSourceError for non-absolute cwd", () => {
    assert.throws(
      () =>
        readAtRevision({
          cwd: "relative",
          revision: fixture.head,
          path: "keep.txt",
        }),
      GitSourceError,
    );
  });

  test("rejects symlink blob at revision (no follow)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "descobrir-git-symlink-"));
    temps.push(cwd);
    fixtureGit(cwd, ["init", "-q", "-b", "main"]);
    writeFileSync(join(cwd, "target.txt"), "target\n");
    symlinkSync("target.txt", join(cwd, "link.txt"));
    fixtureGit(cwd, ["add", "."]);
    fixtureGit(cwd, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "-q",
      "-m",
      "symlink",
    ]);
    const head = fixtureGit(cwd, ["rev-parse", "HEAD"]);
    assert.throws(
      () => readAtRevision({ cwd, revision: head, path: "link.txt" }),
      (err) => err instanceof GitSourceError && /symlink/i.test(err.message),
    );
  });

  test("preserves timeout diagnostic — does not rewrite as revision not present", () => {
    const fake = installFakeGit({ hangOn: ["rev-parse"] });
    temps.push(fake.dir);
    assert.throws(
      () =>
        readAtRevision({
          cwd: fixture.cwd,
          revision: fixture.head,
          path: "keep.txt",
          timeoutMs: 200,
          gitBin: fake.gitBin,
        }),
      (err) =>
        err instanceof GitSourceError &&
        /timed out|killed/i.test(err.message) &&
        !/not present/i.test(err.message),
    );
  });
});

describe("repositorySnapshot timeout classification", () => {
  test("does not treat hung rev-parse as missing anchor", () => {
    const fake = installFakeGit({ hangOn: ["rev-parse"] });
    temps.push(fake.dir);
    assert.throws(
      () =>
        repositorySnapshot({
          cwd: fixture.cwd,
          anchorRevision: fixture.head,
          timeoutMs: 200,
          gitBin: fake.gitBin,
        }),
      (err) =>
        err instanceof GitSourceError &&
        /timed out|killed/i.test(err.message),
    );
  });
});

describe("repositorySnapshot", () => {
  test("captures anchor, tracked count, dirty names without contents", () => {
    const snap = repositorySnapshot({
      cwd: fixture.cwd,
      anchorRevision: fixture.head,
    });
    assert.equal(snap.anchor_object_present, true);
    assert.ok(snap.tracked_file_count >= 3);
    assert.ok(snap.dirty_path_count >= 2);
    assert.ok(Array.isArray(snap.dirty_names));
    assert.ok(snap.dirty_names.includes("modify.txt"));
    assert.match(snap.summary_hash, /^[a-f0-9]{64}$/);
    for (const name of snap.dirty_names) {
      assert.ok(!name.startsWith("/"));
      assert.notEqual(name, "modify-DIRTY\n");
    }
  });

  test("summary_hash is deterministic", () => {
    const a = repositorySnapshot({ cwd: fixture.cwd, anchorRevision: fixture.head });
    const b = repositorySnapshot({ cwd: fixture.cwd, anchorRevision: fixture.head });
    assert.equal(a.summary_hash, b.summary_hash);
  });

  test("anchor_object_present is false for missing object", () => {
    const snap = repositorySnapshot({
      cwd: fixture.cwd,
      anchorRevision: "0".repeat(40),
    });
    assert.equal(snap.anchor_object_present, false);
  });
});
