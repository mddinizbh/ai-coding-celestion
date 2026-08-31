import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { openOpsStore, OpsStoreError } from "../src/store.mjs";

describe("ops journal", () => {
  test("log + list + challenges roundtrip", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-"));
    const store = openOpsStore(join(dir, "ops.sqlite"));
    try {
      const { run_id } = store.log({
        phase: "finalize",
        status: "blocked",
        namespace: "uai",
        logical_repos: ["uai-auth"],
        detail: { blockers: 2 },
        challenges: [
          {
            code: "missing_payload",
            detail: "c:0000.json vs c_0000.json",
            how_we_attacked: "emit-payloads",
          },
        ],
      });
      assert.ok(run_id.startsWith("ops-"));
      const runs = store.listRuns({ namespace: "uai" });
      assert.equal(runs.length, 1);
      assert.equal(runs[0].phase, "finalize");
      const ch = store.listChallenges({ code: "missing_payload" });
      assert.equal(ch.length, 1);
      assert.equal(ch[0].how_we_attacked, "emit-payloads");
    } finally {
      store.close();
    }
  });

  test("rejects absolute /Users path in detail", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-"));
    const store = openOpsStore(join(dir, "ops.sqlite"));
    try {
      assert.throws(
        () =>
          store.log({
            phase: "test",
            status: "ok",
            detail: { path: "/Users/attacker/secret/file.txt" },
          }),
        OpsStoreError
      );
    } finally {
      store.close();
    }
  });

  test("rejects current hostname in detail", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-"));
    const store = openOpsStore(join(dir, "ops.sqlite"));
    try {
      assert.throws(
        () =>
          store.log({
            phase: "test",
            status: "ok",
            detail: { host: hostname() },
          }),
        OpsStoreError
      );
    } finally {
      store.close();
    }
  });

  test("rejects secret-bearing material in challenge detail", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-"));
    const store = openOpsStore(join(dir, "ops.sqlite"));
    try {
      assert.throws(
        () =>
          store.log({
            phase: "test",
            status: "blocked",
            challenges: [{ code: "sec", detail: "password=supersecret123" }],
          }),
        OpsStoreError
      );
    } finally {
      store.close();
    }
  });

  test("rejects nested unsafe value in detail", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-"));
    const store = openOpsStore(join(dir, "ops.sqlite"));
    try {
      assert.throws(
        () =>
          store.log({
            phase: "test",
            status: "ok",
            detail: { meta: { inner: "/home/attacker/.ssh/id_rsa" } },
          }),
        OpsStoreError
      );
    } finally {
      store.close();
    }
  });

  test("accepts safe data without paths/hostname/secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-"));
    const store = openOpsStore(join(dir, "ops.sqlite"));
    try {
      const { run_id } = store.log({
        phase: "test",
        status: "ok",
        detail: { msg: "relative/path is ok", note: "no secrets here" },
        challenges: [{ code: "c1", detail: "explanation without host" }],
      });
      assert.ok(run_id);
    } finally {
      store.close();
    }
  });

  test("no partial write when unsafe (transaction rolls back)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-"));
    const dbPath = join(dir, "ops.sqlite");
    const store = openOpsStore(dbPath);
    try {
      assert.throws(
        () =>
          store.log({
            phase: "test",
            status: "blocked",
            challenges: [{ code: "bad", detail: "/Users/attacker/path" }],
          }),
        OpsStoreError
      );
      // after failure, no rows should exist
      const runs = store.listRuns({});
      const chs = store.listChallenges({});
      assert.equal(runs.length, 0);
      assert.equal(chs.length, 0);
    } finally {
      store.close();
    }
  });

  test("rejects nested unsafe object key in detail", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-"));
    const store = openOpsStore(join(dir, "ops.sqlite"));
    try {
      assert.throws(
        () =>
          store.log({
            phase: "test",
            status: "ok",
            detail: { "/Users/attacker/.env": "secret" },
          }),
        OpsStoreError
      );
    } finally {
      store.close();
    }
  });

  test("rejects unsafe how_we_attacked", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-"));
    const store = openOpsStore(join(dir, "ops.sqlite"));
    try {
      assert.throws(
        () =>
          store.log({
            phase: "test",
            status: "blocked",
            challenges: [{ code: "x", detail: "ok", how_we_attacked: "password=foo" }],
          }),
        OpsStoreError
      );
    } finally {
      store.close();
    }
  });

  test("accepts benign technical prose (token budget, no secrets here)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-"));
    const store = openOpsStore(join(dir, "ops.sqlite"));
    try {
      const { run_id } = store.log({
        phase: "test",
        status: "ok",
        detail: { note: "token budget is 100k", msg: "no secrets here" },
        challenges: [{ code: "c2", detail: "explanation with secret word but no assignment", how_we_attacked: "use token bucket" }],
      });
      assert.ok(run_id);
    } finally {
      store.close();
    }
  });

  test("rejects secret-bearing key (password as key)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-"));
    const store = openOpsStore(join(dir, "ops.sqlite"));
    try {
      assert.throws(
        () =>
          store.log({
            phase: "test",
            status: "ok",
            detail: { password: "supersecret" },
          }),
        OpsStoreError
      );
    } finally {
      store.close();
    }
  });
});
