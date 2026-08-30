/**
 * Hermetic protocol test for the one-invocation Descobrir workflow.
 *
 * Fake seams record every phase call so we can assert the strict order
 * setup_status -> prepare -> chunk_dispatch -> finalize, the retry policy
 * (only failed chunks, max 3 attempts), and the blocked-end-with-run_id
 * contract when a chunk exhausts retries.
 *
 * No Graphify, Git, filesystem, or SQLite is touched.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { runDescobrirProtocol, DEFAULT_MAX_ATTEMPTS } from "../src/descobrir-protocol.mjs";

/**
 * Build a fake seam bundle that records every call into `log`.
 * @param {{
 *   setupStatus?: object,
 *   prepareResult?: object,
 *   dispatchBehavior?: (ctx: { chunk_key: string, attempt: number }) =>
 *     { ok: true, payload?: object } | { ok: false, blockers: object[] },
 *   finalizeResult?: object,
 *   prepareThrows?: Error,
 * }} [config]
 * @param {string[]} [log] shared phase log array
 */
function fakeSeams(config = {}, log = []) {
  const dispatchCalls = [];
  const seams = {
    setupStatus: () => {
      log.push("setup_status");
      return (
        config.setupStatus ?? {
          installed: true,
          matches_pin: true,
          version: "0.9.32",
          setup_command: "node skills/descobrir/cli.mjs setup",
        }
      );
    },
    prepare: (input) => {
      log.push("prepare");
      if (config.prepareThrows) throw config.prepareThrows;
      return (
        config.prepareResult ?? {
          status: "prepared",
          run_id: "run-abc",
          run_root: "/tmp/run-abc",
          source_revision: "deadbeef",
          chunk_index: {
            version: 1,
            chunks: [
              { chunk_key: "chunkA", fact_keys: ["f1"], content_sha256: "a".repeat(64), byte_length: 10, fact_count: 1 },
              { chunk_key: "chunkB", fact_keys: ["f2"], content_sha256: "b".repeat(64), byte_length: 10, fact_count: 1 },
            ],
          },
          descriptor: { run_id: "run-abc", status: "prepared" },
        }
      );
    },
    dispatchChunk: (ctx) => {
      log.push(`chunk_dispatch:${ctx.chunk_key}:attempt${ctx.attempt}`);
      dispatchCalls.push({ ...ctx });
      if (config.dispatchBehavior) return config.dispatchBehavior(ctx);
      return { ok: true, payload: { chunk_key: ctx.chunk_key } };
    },
    finalize: (ctx) => {
      log.push("finalize");
      return (
        config.finalizeResult ?? {
          status: "finalized",
          exit_code: 0,
          run_id: ctx.run_id,
          candidate_id: "cand-1",
          created: true,
          canonical_graph_hash: "c".repeat(64),
        }
      );
    },
  };
  return { seams, dispatchCalls };
}

describe("runDescobrirProtocol phase order", () => {
  test("happy path: setup_status -> prepare -> chunk_dispatch per chunk -> finalize", async () => {
    /** @type {string[]} */
    const log = [];
    const { seams } = fakeSeams({}, log);

    const result = await runDescobrirProtocol(
      { namespace: "ns", logical_repo: "repo", project_path: "/repo", db: "/db.sqlite" },
      seams,
    );

    assert.equal(result.status, "finalized");
    assert.equal(result.phase, "finalize");
    // setup_status first, prepare second, finalize last.
    assert.equal(log[0], "setup_status");
    assert.equal(log[1], "prepare");
    assert.equal(log[log.length - 1], "finalize");
    // Both chunks dispatched exactly once on happy path.
    const dispatches = log.filter((e) => e.startsWith("chunk_dispatch:"));
    assert.deepEqual(
      dispatches.sort(),
      ["chunk_dispatch:chunkA:attempt1", "chunk_dispatch:chunkB:attempt1"].sort(),
    );
  });

  test("setup_required: dispatch/prepare/finalize never run when Graphify missing", async () => {
    /** @type {string[]} */
    const log = [];
    const { seams } = fakeSeams(
      {
        setupStatus: {
          installed: false,
          matches_pin: false,
          version: null,
          setup_command: "node skills/descobrir/cli.mjs setup",
        },
      },
      log,
    );

    const result = await runDescobrirProtocol(
      { namespace: "ns", logical_repo: "repo", project_path: "/repo" },
      seams,
    );

    assert.equal(result.status, "setup_required");
    assert.equal(result.phase, "setup_status");
    assert.equal(result.run_id, null);
    assert.equal(result.installed, false);
    assert.equal(
      result.setup_command,
      "node skills/descobrir/cli.mjs setup",
    );
    // No further phases touched.
    assert.deepEqual(log, ["setup_status"]);
  });

  test("setup_required on version mismatch: no manual Graphify fallback surfaced", async () => {
    /** @type {string[]} */
    const log = [];
    const { seams } = fakeSeams(
      {
        setupStatus: {
          installed: true,
          matches_pin: false,
          version: "0.10.0",
          setup_command: "node skills/descobrir/cli.mjs setup",
        },
      },
      log,
    );

    const result = await runDescobrirProtocol(
      { namespace: "ns", logical_repo: "repo", project_path: "/repo" },
      seams,
    );

    assert.equal(result.status, "setup_required");
    assert.equal(result.matches_pin, false);
    assert.equal(result.version, "0.10.0");
    assert.deepEqual(log, ["setup_status"]);
  });

  test("prepare_failed: dispatch and finalize never run when prepare throws", async () => {
    /** @type {string[]} */
    const log = [];
    const { seams } = fakeSeams(
      { prepareThrows: new Error("worktree timeout") },
      log,
    );

    const result = await runDescobrirProtocol(
      { namespace: "ns", logical_repo: "repo", project_path: "/repo" },
      seams,
    );

    assert.equal(result.status, "prepare_failed");
    assert.equal(result.phase, "prepare");
    assert.equal(result.run_id, null);
    assert.equal(result.error, "worktree timeout");
    assert.deepEqual(log, ["setup_status", "prepare"]);
  });
});

describe("runDescobrirProtocol chunk retry policy", () => {
  test("one chunk banned field -> only that chunk retried, others stay at 1 attempt", async () => {
    /** @type {string[]} */
    const log = [];
    // chunkA returns a banned_field blocker on attempt 1, ok on attempt 2.
    // chunkB always ok.
    const { seams, dispatchCalls } = fakeSeams(
      {
        dispatchBehavior: (ctx) => {
          if (ctx.chunk_key === "chunkA" && ctx.attempt === 1) {
            return {
              ok: false,
              blockers: [
                {
                  code: "banned_field",
                  chunk_keys: ["chunkA"],
                  detail: "record: authority field 'confidence' is not allowed",
                  retryable: true,
                },
              ],
            };
          }
          return { ok: true, payload: { chunk_key: ctx.chunk_key } };
        },
      },
      log,
    );

    const result = await runDescobrirProtocol(
      { namespace: "ns", logical_repo: "repo", project_path: "/repo" },
      seams,
    );

    assert.equal(result.status, "finalized");
    // chunkA dispatched twice (retry), chunkB dispatched once.
    const aCalls = dispatchCalls.filter((c) => c.chunk_key === "chunkA");
    const bCalls = dispatchCalls.filter((c) => c.chunk_key === "chunkB");
    assert.equal(aCalls.length, 2, "chunkA must be retried exactly once");
    assert.equal(bCalls.length, 1, "chunkB must NOT be retried");
    assert.equal(aCalls[0].attempt, 1);
    assert.equal(aCalls[1].attempt, 2);
    // finalize still ran.
    assert.equal(log[log.length - 1], "finalize");
  });

  test("third failure ends blocked with run_id and failed chunk keys", async () => {
    /** @type {string[]} */
    const log = [];
    // chunkA always fails with a retryable banned_field.
    // chunkB always ok.
    const { seams, dispatchCalls } = fakeSeams(
      {
        dispatchBehavior: (ctx) => {
          if (ctx.chunk_key === "chunkA") {
            return {
              ok: false,
              blockers: [
                {
                  code: "banned_field",
                  chunk_keys: ["chunkA"],
                  detail: "record: authority field 'confidence' is not allowed",
                  retryable: true,
                },
              ],
            };
          }
          return { ok: true, payload: { chunk_key: ctx.chunk_key } };
        },
      },
      log,
    );

    const result = await runDescobrirProtocol(
      { namespace: "ns", logical_repo: "repo", project_path: "/repo" },
      seams,
    );

    assert.equal(result.status, "blocked");
    assert.equal(result.phase, "chunk_dispatch");
    assert.equal(result.run_id, "run-abc");
    assert.deepEqual(result.failed_chunk_keys, ["chunkA"]);
    // chunkA attempted exactly maxAttempts times.
    const aCalls = dispatchCalls.filter((c) => c.chunk_key === "chunkA");
    assert.equal(aCalls.length, DEFAULT_MAX_ATTEMPTS);
    assert.equal(aCalls[0].attempt, 1);
    assert.equal(aCalls[1].attempt, 2);
    assert.equal(aCalls[2].attempt, 3);
    // chunkB succeeded on attempt 1, never retried.
    const bCalls = dispatchCalls.filter((c) => c.chunk_key === "chunkB");
    assert.equal(bCalls.length, 1);
    // finalize MUST NOT run when chunks are blocked.
    assert.equal(log.includes("finalize"), false);
    // Blockers from every failed attempt are surfaced.
    assert.ok(result.blockers.length >= DEFAULT_MAX_ATTEMPTS);
    assert.ok(
      result.blockers.every(
        (b) => b.code === "banned_field" && b.chunk_keys.includes("chunkA"),
      ),
    );
  });

  test("default maxAttempts is 3", () => {
    assert.equal(DEFAULT_MAX_ATTEMPTS, 3);
  });

  test("dispatch exception is treated as retryable and surfaced in blockers", async () => {
    /** @type {string[]} */
    const log = [];
    let calls = 0;
    const { seams, dispatchCalls } = fakeSeams(
      {
        dispatchBehavior: (ctx) => {
          if (ctx.chunk_key === "chunkA") {
            calls += 1;
            if (calls < 3) {
              throw new Error("subagent crashed");
            }
            return { ok: true, payload: { chunk_key: "chunkA" } };
          }
          return { ok: true, payload: { chunk_key: ctx.chunk_key } };
        },
      },
      log,
    );

    const result = await runDescobrirProtocol(
      { namespace: "ns", logical_repo: "repo", project_path: "/repo" },
      seams,
    );

    assert.equal(result.status, "finalized");
    const aCalls = dispatchCalls.filter((c) => c.chunk_key === "chunkA");
    assert.equal(aCalls.length, 3, "crashed attempts counted as retries");
  });

  test("finalize_blocked: finalize returns blocked -> protocol preserves finalize status", async () => {
    /** @type {string[]} */
    const log = [];
    const { seams } = fakeSeams(
      {
        finalizeResult: {
          status: "blocked",
          exit_code: 2,
          run_id: "run-abc",
          blockers: [
            {
              code: "unknown_node_key",
              chunk_keys: [],
              detail: "record references unknown node_key 'n:42'",
              retryable: true,
            },
          ],
          retryable_chunk_keys: [],
        },
      },
      log,
    );

    const result = await runDescobrirProtocol(
      { namespace: "ns", logical_repo: "repo", project_path: "/repo" },
      seams,
    );

    assert.equal(result.status, "finalize_blocked");
    assert.equal(result.phase, "finalize");
    assert.equal(result.finalize.status, "blocked");
    assert.equal(result.finalize.exit_code, 2);
  });

  test("custom maxAttempts respected", async () => {
    /** @type {string[]} */
    const log = [];
    const { seams, dispatchCalls } = fakeSeams(
      {
        dispatchBehavior: (ctx) => ({
          ok: false,
          blockers: [
            {
              code: "banned_field",
              chunk_keys: [ctx.chunk_key],
              detail: "authority field",
              retryable: true,
            },
          ],
        }),
      },
      log,
    );

    const result = await runDescobrirProtocol(
      { namespace: "ns", logical_repo: "repo", project_path: "/repo" },
      { ...seams, maxAttempts: 2 },
    );

    assert.equal(result.status, "blocked");
    // 2 chunks * 2 attempts each = 4 dispatch calls.
    assert.equal(dispatchCalls.length, 4);
  });

  test("phase order is strict even on retry: setup -> prepare -> dispatches -> finalize", async () => {
    /** @type {string[]} */
    const log = [];
    const { seams } = fakeSeams(
      {
        dispatchBehavior: (ctx) => {
          if (ctx.chunk_key === "chunkA" && ctx.attempt === 1) {
            return {
              ok: false,
              blockers: [
                {
                  code: "banned_field",
                  chunk_keys: ["chunkA"],
                  detail: "retry me",
                  retryable: true,
                },
              ],
            };
          }
          return { ok: true, payload: { chunk_key: ctx.chunk_key } };
        },
      },
      log,
    );

    await runDescobrirProtocol(
      { namespace: "ns", logical_repo: "repo", project_path: "/repo" },
      seams,
    );

    // Index assertions: setup_status and prepare before all dispatches,
    // finalize after all dispatches.
    const setupIdx = log.indexOf("setup_status");
    const prepareIdx = log.indexOf("prepare");
    const finalizeIdx = log.indexOf("finalize");
    const firstDispatchIdx = log.findIndex((e) => e.startsWith("chunk_dispatch"));
    const lastDispatchIdx =
      log.length - 1 - [...log].reverse().findIndex((e) => e.startsWith("chunk_dispatch"));
    assert.ok(setupIdx === 0, "setup_status must be first");
    assert.ok(prepareIdx === 1, "prepare must be second");
    assert.ok(firstDispatchIdx > prepareIdx, "dispatch must follow prepare");
    assert.ok(finalizeIdx === -1 ? true : finalizeIdx > lastDispatchIdx, "finalize after dispatches");
  });
});

describe("runDescobrirProtocol seam contract", () => {
  test("rejects non-function setupStatus", async () => {
    await assert.rejects(
      () =>
        runDescobrirProtocol(
          { namespace: "ns", logical_repo: "repo", project_path: "/p" },
          /** @type {any} */ ({
            setupStatus: null,
            prepare: () => {},
            dispatchChunk: () => {},
            finalize: () => {},
          }),
        ),
      /setupStatus seam must be a function/,
    );
  });

  test("rejects maxAttempts < 1", async () => {
    /** @type {string[]} */
    const log = [];
    const { seams } = fakeSeams({}, log);
    await assert.rejects(
      () =>
        runDescobrirProtocol(
          { namespace: "ns", logical_repo: "repo", project_path: "/p" },
          /** @type {any} */ ({ ...seams, maxAttempts: 0 }),
        ),
      /maxAttempts must be a positive integer/,
    );
  });

  test("setupStatus with non-boolean installed is rejected", async () => {
    /** @type {string[]} */
    const log = [];
    const { seams } = fakeSeams(
      /** @type {any} */ ({
        setupStatus: { installed: "yes", matches_pin: true, version: "0.9.32", setup_command: "x" },
      }),
      log,
    );
    await assert.rejects(
      () =>
        runDescobrirProtocol(
          { namespace: "ns", logical_repo: "repo", project_path: "/p" },
          seams,
        ),
      /setupStatus result must have boolean installed and matches_pin/,
    );
  });

  test("prepare returning non-prepared status throws", async () => {
    /** @type {string[]} */
    const log = [];
    const { seams } = fakeSeams(
      /** @type {any} */ ({
        prepareResult: { status: "blocked", run_id: "x" },
      }),
      log,
    );
    await assert.rejects(
      () =>
        runDescobrirProtocol(
          { namespace: "ns", logical_repo: "repo", project_path: "/p" },
          seams,
        ),
      /prepare seam returned unexpected status 'blocked'/,
    );
  });
});
