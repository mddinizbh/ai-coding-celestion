/**
 * Public seam: withDetachedWorktree — isolated detached worktree lifecycle.
 * Source tree must never be cleaned/reset/stashed; worktree always removed in finally.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { WorktreeError, withDetachedWorktree } from "../src/worktree.mjs";
import {
  captureSourceStatusV2,
  captureWorktreeList,
  worktreeListMentionsPath,
} from "../src/git-reader.mjs";
import { installFakeGit } from "./fake-git.mjs";

const temps = [];

afterEach(() => {
  while (temps.length > 0) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

function fixtureGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", shell: false }).trim();
}

function makeSourceRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "descobrir-wt-src-"));
  temps.push(cwd);
  fixtureGit(cwd, ["init", "-q", "-b", "main"]);
  writeFileSync(join(cwd, "app.txt"), "committed\n");
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
  writeFileSync(join(cwd, "app.txt"), "dirty-working-tree\n");
  writeFileSync(join(cwd, "extra.txt"), "untracked\n");
  return { cwd, head };
}

function makeRunRoot() {
  const dir = mkdtempSync(join(tmpdir(), "descobrir-wt-run-"));
  temps.push(dir);
  return dir;
}

describe("withDetachedWorktree", () => {
  test("success path: detached at exact commit, callback sees committed bytes, source unchanged", async () => {
    const src = makeSourceRepo();
    const runRoot = makeRunRoot();
    const statusBefore = captureSourceStatusV2(src.cwd);
    const wtBefore = captureWorktreeList(src.cwd);

    const outcome = await withDetachedWorktree({
      repoPath: src.cwd,
      revision: src.head,
      runRoot,
      callback: async ({ worktreePath }) => {
        assert.ok(worktreePath.startsWith(runRoot));
        assert.ok(existsSync(worktreePath));
        const head = fixtureGit(worktreePath, ["rev-parse", "HEAD"]);
        assert.equal(head, src.head);
        const body = execFileSync("cat", [join(worktreePath, "app.txt")], {
          encoding: "utf8",
          shell: false,
        });
        assert.equal(body, "committed\n");
        return { ok: true };
      },
    });

    assert.deepEqual(outcome.result, { ok: true });
    assert.equal(outcome.mutation.equivalent, true);
    assert.match(outcome.mutation.pre.summary_hash, /^[a-f0-9]{64}$/);
    assert.equal(outcome.mutation.pre.summary_hash, outcome.mutation.post.summary_hash);
    assert.equal(captureSourceStatusV2(src.cwd), statusBefore);
    assert.equal(captureWorktreeList(src.cwd), wtBefore);
    assert.equal(existsSync(outcome.worktreePath), false);
  });

  test("callback error: still removes worktree and leaves source status/worktree list identical", async () => {
    const src = makeSourceRepo();
    const runRoot = makeRunRoot();
    const statusBefore = captureSourceStatusV2(src.cwd);
    const wtBefore = captureWorktreeList(src.cwd);

    await assert.rejects(
      () =>
        withDetachedWorktree({
          repoPath: src.cwd,
          revision: src.head,
          runRoot,
          callback: async ({ worktreePath }) => {
            writeFileSync(join(worktreePath, "mut.txt"), "x\n");
            throw new Error("injected-process-failure");
          },
        }),
      (err) => err instanceof Error && err.message === "injected-process-failure",
    );

    assert.equal(captureSourceStatusV2(src.cwd), statusBefore);
    assert.equal(captureWorktreeList(src.cwd), wtBefore);
    // no leftover worktree dirs under run root
    const list = captureWorktreeList(src.cwd);
    assert.equal(list.includes(runRoot), false);
  });

  test("invalid revision: typed WorktreeError and no leaked worktree", async () => {
    const src = makeSourceRepo();
    const runRoot = makeRunRoot();
    const statusBefore = captureSourceStatusV2(src.cwd);
    const wtBefore = captureWorktreeList(src.cwd);

    await assert.rejects(
      () =>
        withDetachedWorktree({
          repoPath: src.cwd,
          revision: "0".repeat(40),
          runRoot,
          callback: async () => {
            throw new Error("must-not-run");
          },
        }),
      WorktreeError,
    );

    assert.equal(captureSourceStatusV2(src.cwd), statusBefore);
    assert.equal(captureWorktreeList(src.cwd), wtBefore);
  });

  test("malformed revision rejected before git worktree add", async () => {
    const src = makeSourceRepo();
    const runRoot = makeRunRoot();
    await assert.rejects(
      () =>
        withDetachedWorktree({
          repoPath: src.cwd,
          revision: "HEAD",
          runRoot,
          callback: async () => "nope",
        }),
      WorktreeError,
    );
  });

  test("AbortSignal interruption cleans worktree and surfaces typed error", async () => {
    const src = makeSourceRepo();
    const runRoot = makeRunRoot();
    const statusBefore = captureSourceStatusV2(src.cwd);
    const wtBefore = captureWorktreeList(src.cwd);
    const ac = new AbortController();

    await assert.rejects(
      () =>
        withDetachedWorktree({
          repoPath: src.cwd,
          revision: src.head,
          runRoot,
          signal: ac.signal,
          callback: async () => {
            ac.abort();
            // simulate long work noticing abort
            if (ac.signal.aborted) {
              const err = new Error("aborted");
              err.name = "AbortError";
              throw err;
            }
          },
        }),
      (err) => err instanceof WorktreeError || err?.name === "AbortError",
    );

    assert.equal(captureSourceStatusV2(src.cwd), statusBefore);
    assert.equal(captureWorktreeList(src.cwd), wtBefore);
  });

  test("pre-aborted signal never creates worktree", async () => {
    const src = makeSourceRepo();
    const runRoot = makeRunRoot();
    const wtBefore = captureWorktreeList(src.cwd);
    const ac = new AbortController();
    ac.abort();

    await assert.rejects(
      () =>
        withDetachedWorktree({
          repoPath: src.cwd,
          revision: src.head,
          runRoot,
          signal: ac.signal,
          callback: async () => "nope",
        }),
      WorktreeError,
    );
    assert.equal(captureWorktreeList(src.cwd), wtBefore);
  });

  test("repeated interruption still leaves source pristine", async () => {
    const src = makeSourceRepo();
    const statusBefore = captureSourceStatusV2(src.cwd);
    const wtBefore = captureWorktreeList(src.cwd);

    for (let i = 0; i < 3; i += 1) {
      const runRoot = makeRunRoot();
      const ac = new AbortController();
      await assert.rejects(() =>
        withDetachedWorktree({
          repoPath: src.cwd,
          revision: src.head,
          runRoot,
          signal: ac.signal,
          callback: async () => {
            ac.abort();
            const err = new Error("interrupt");
            err.name = "AbortError";
            throw err;
          },
        }),
      );
    }

    assert.equal(captureSourceStatusV2(src.cwd), statusBefore);
    assert.equal(captureWorktreeList(src.cwd), wtBefore);
  });

  test("rejects non-absolute runRoot and repoPath", async () => {
    const src = makeSourceRepo();
    await assert.rejects(
      () =>
        withDetachedWorktree({
          repoPath: "relative",
          revision: src.head,
          runRoot: makeRunRoot(),
          callback: async () => null,
        }),
      WorktreeError,
    );
    await assert.rejects(
      () =>
        withDetachedWorktree({
          repoPath: src.cwd,
          revision: src.head,
          runRoot: "relative",
          callback: async () => null,
        }),
      WorktreeError,
    );
  });

  test("stale registration: add worktree, delete directory, lifecycle recovers and ends unregistered", async () => {
    const src = makeSourceRepo();
    const runRoot = makeRunRoot();
    const stalePath = join(runRoot, "stale-wt");
    const statusBefore = captureSourceStatusV2(src.cwd);
    const wtBefore = captureWorktreeList(src.cwd);

    fixtureGit(src.cwd, ["worktree", "add", "--detach", stalePath, src.head]);
    assert.equal(worktreeListMentionsPath(captureWorktreeList(src.cwd), stalePath), true);
    rmSync(stalePath, { recursive: true, force: true });
    // Directory gone but registration remains (prunable/stale).
    assert.equal(worktreeListMentionsPath(captureWorktreeList(src.cwd), stalePath), true);
    assert.equal(existsSync(stalePath), false);

    const outcome = await withDetachedWorktree({
      repoPath: src.cwd,
      revision: src.head,
      runRoot,
      worktreeId: "stale-wt",
      callback: async ({ worktreePath }) => {
        assert.equal(worktreePath, stalePath);
        assert.ok(existsSync(worktreePath));
        return "recovered";
      },
    });

    assert.equal(outcome.result, "recovered");
    assert.equal(existsSync(stalePath), false);
    assert.equal(worktreeListMentionsPath(captureWorktreeList(src.cwd), stalePath), false);
    assert.equal(captureSourceStatusV2(src.cwd), statusBefore);
    assert.equal(captureWorktreeList(src.cwd), wtBefore);
  });

  test("hung worktree remove+prune: never reports success; typed WorktreeError; no registration leak", async () => {
    const src = makeSourceRepo();
    const runRoot = makeRunRoot();
    const fake = installFakeGit({ hangOn: ["worktree remove", "worktree prune"] });
    temps.push(fake.dir);
    const statusBefore = captureSourceStatusV2(src.cwd);
    const wtBefore = captureWorktreeList(src.cwd);
    let callbackRan = false;
    let observedPath = "";

    await assert.rejects(
      () =>
        withDetachedWorktree({
          repoPath: src.cwd,
          revision: src.head,
          runRoot,
          worktreeId: "hang-wt",
          // > cold-start of node fake-git (~200ms); short enough that hung remove/prune trip timeout.
          timeoutMs: 800,
          gitBin: fake.gitBin,
          callback: async ({ worktreePath }) => {
            callbackRan = true;
            observedPath = worktreePath;
            return { ok: true };
          },
        }),
      (err) => err instanceof WorktreeError && /cleanup|registered|worktree/i.test(err.message),
    );

    assert.equal(callbackRan, true);
    // Must not leave a registered worktree for the path (recovery or hard fail after verify).
    // Use real git for observation (fake hangs on remove/prune only).
    const listAfter = captureWorktreeList(src.cwd);
    if (observedPath) {
      assert.equal(
        worktreeListMentionsPath(listAfter, observedPath),
        false,
        `registration leak for ${observedPath}:\n${listAfter}`,
      );
      assert.equal(existsSync(observedPath), false);
    }
    assert.equal(captureSourceStatusV2(src.cwd), statusBefore);
    // Source main worktree registration only (same as before) once leak-free.
    assert.equal(captureWorktreeList(src.cwd), wtBefore);
  });

  test("cleanup failure dominates successful callback (no success return)", async () => {
    const src = makeSourceRepo();
    const runRoot = makeRunRoot();
    const fake = installFakeGit({ hangOn: ["worktree remove", "worktree prune"] });
    temps.push(fake.dir);

    let resolvedValue = null;
    await assert.rejects(
      async () => {
        const outcome = await withDetachedWorktree({
          repoPath: src.cwd,
          revision: src.head,
          runRoot,
          worktreeId: "dom-wt",
          timeoutMs: 800,
          gitBin: fake.gitBin,
          callback: async () => {
            resolvedValue = "callback-success";
            return resolvedValue;
          },
        });
        // If implementation wrongly returns, force fail:
        assert.fail(`must not resolve success, got ${JSON.stringify(outcome)}`);
      },
      WorktreeError,
    );
    assert.equal(resolvedValue, "callback-success");
    assert.equal(worktreeListMentionsPath(captureWorktreeList(src.cwd), join(runRoot, "dom-wt")), false);
  });

  test("callback error is not swallowed when cleanup also fails", async () => {
    const src = makeSourceRepo();
    const runRoot = makeRunRoot();
    const fake = installFakeGit({ hangOn: ["worktree remove", "worktree prune"] });
    temps.push(fake.dir);

    await assert.rejects(
      () =>
        withDetachedWorktree({
          repoPath: src.cwd,
          revision: src.head,
          runRoot,
          worktreeId: "cb-err-wt",
          timeoutMs: 800,
          gitBin: fake.gitBin,
          callback: async () => {
            throw new Error("injected-callback-failure");
          },
        }),
      (err) => {
        if (!(err instanceof WorktreeError)) return false;
        // Cleanup dominates message, but original callback error must remain reachable.
        const cause = err.cause;
        return (
          /cleanup|registered|worktree/i.test(err.message) &&
          cause instanceof Error &&
          cause.message === "injected-callback-failure"
        );
      },
    );
    assert.equal(worktreeListMentionsPath(captureWorktreeList(src.cwd), join(runRoot, "cb-err-wt")), false);
  });
});
