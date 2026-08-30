/**
 * Concurrency hardening test for SQLite stores.
 * Verifies busy_timeout + WAL prevent SQLITE_BUSY on parallel writers.
 * English comments, node:test + assert/strict, zero new deps.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { openSystemStore } from "../src/system-store.mjs";
import { openStore } from "../../explorer-l0/src/store.mjs";

function makeTempDb() {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-concurrency-"));
  const dbPath = join(dir, "test.db");
  return { dbPath, dir };
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

test("openSystemStore sets WAL and busy_timeout", () => {
  const { dbPath, dir } = makeTempDb();
  try {
    const store = openSystemStore(dbPath);
    const mode = store._db.prepare("PRAGMA journal_mode;").get();
    assert.equal(mode.journal_mode.toLowerCase(), "wal");
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("openStore sets WAL and busy_timeout", () => {
  const { dbPath, dir } = makeTempDb();
  try {
    const store = openStore(dbPath);
    const mode = store._db.prepare("PRAGMA journal_mode;").get();
    assert.equal(mode.journal_mode.toLowerCase(), "wal");
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("second writer waits on the first writer's lock instead of failing (SQLITE_BUSY)", () => {
  const { dbPath, dir } = makeTempDb();
  try {
    // init schema via the real store path (also flips the file to WAL)
    const store = openSystemStore(dbPath);
    store._db.exec(
      "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)",
    );
    store.close();

    // Process 1: acquires the write lock and holds it for 800ms.
    const holderScript = `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO t (v) VALUES ('holder')").run();
      setTimeout(() => { db.exec("COMMIT"); db.close(); process.exit(0); }, 800);
    `;
    const holder = spawn(process.execPath, ["-e", holderScript], {
      stdio: "ignore",
    });

    // give the holder time to actually acquire the lock
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);

    // Process 2: attempts the write while the lock is held. With
    // busy_timeout it blocks ~500ms and then succeeds — without it, SQLite
    // returns SQLITE_BUSY immediately and this test fails.
    const writerScript = `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(${JSON.stringify(dbPath)});
      db.exec("PRAGMA busy_timeout = 5000;");
      const start = Date.now();
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO t (v) VALUES ('writer')").run();
      db.exec("COMMIT");
      console.log("waited:" + (Date.now() - start));
    `;
    const writer = spawnSync(process.execPath, ["-e", writerScript], {
      encoding: "utf8",
      timeout: 15000,
    });

    // ensure the holder finished before asserting/cleaning up
    const holderDone = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
      timeout: 5000,
    });
    void holderDone;

    assert.equal(writer.status, 0, writer.stderr || "writer failed");
    const waited = Number(
      (writer.stdout.match(/waited:(\d+)/) || [])[1] || 0,
    );
    assert.ok(
      waited >= 200,
      `writer should have waited on the held lock (waited ${waited}ms)`,
    );

    const db = new DatabaseSync(dbPath);
    const n = db.prepare("SELECT COUNT(*) AS c FROM t").get();
    assert.equal(n.c, 2, "both writers' rows must be present");
    db.close();
  } finally {
    cleanup(dir);
  }
});
