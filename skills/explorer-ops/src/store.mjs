/**
 * Journal store: one row per pipeline phase, optional challenges.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

import { SCHEMA_SQL } from "./schema.mjs";

export class OpsStoreError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "OpsStoreError";
  }
}

export function defaultOpsDbPath() {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
  return join(data, "descobrir", "ops.sqlite");
}

/**
 * @param {string} dbPath
 */
export function openOpsStore(dbPath) {
  if (typeof dbPath !== "string" || dbPath === "") {
    throw new OpsStoreError("dbPath must be a non-empty string");
  }
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);

  return {
    _db: db,
    dbPath,
    close() {
      db.close();
    },

    /**
     * @param {{
     *   run_id?: string,
     *   namespace?: string,
     *   phase: string,
     *   status: string,
     *   logical_repos?: string[],
     *   detail?: object,
     *   challenges?: { code: string, detail: string, how_we_attacked?: string }[],
     * }} rec
     */
    log(rec) {
      if (typeof rec.phase !== "string" || rec.phase === "") {
        throw new OpsStoreError("phase is required");
      }
      if (typeof rec.status !== "string" || rec.status === "") {
        throw new OpsStoreError("status is required");
      }
      const runId =
        typeof rec.run_id === "string" && rec.run_id !== ""
          ? rec.run_id
          : `ops-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO ops_runs (run_id, started_at, namespace, phase, status, logical_repos, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId,
        now,
        rec.namespace ?? null,
        rec.phase,
        rec.status,
        rec.logical_repos ? JSON.stringify(rec.logical_repos) : null,
        JSON.stringify(rec.detail ?? {}),
        now,
      );
      for (const ch of rec.challenges ?? []) {
        if (typeof ch.code !== "string" || ch.code === "") continue;
        db.prepare(
          `INSERT INTO ops_challenges (run_id, code, detail, how_we_attacked, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(runId, ch.code, ch.detail ?? "", ch.how_we_attacked ?? null, now);
      }
      return { run_id: runId, created_at: now };
    },

    /**
     * @param {{ namespace?: string, limit?: number }} q
     */
    listRuns(q = {}) {
      const limit = Number.isInteger(q.limit) && q.limit > 0 ? q.limit : 20;
      if (typeof q.namespace === "string" && q.namespace !== "") {
        return db
          .prepare(
            `SELECT run_id, started_at, namespace, phase, status, logical_repos, detail_json, created_at
             FROM ops_runs WHERE namespace = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(q.namespace, limit);
      }
      return db
        .prepare(
          `SELECT run_id, started_at, namespace, phase, status, logical_repos, detail_json, created_at
           FROM ops_runs ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit);
    },

    /**
     * @param {{ code?: string, limit?: number }} q
     */
    listChallenges(q = {}) {
      const limit = Number.isInteger(q.limit) && q.limit > 0 ? q.limit : 50;
      if (typeof q.code === "string" && q.code !== "") {
        return db
          .prepare(
            `SELECT id, run_id, code, detail, how_we_attacked, created_at
             FROM ops_challenges WHERE code = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(q.code, limit);
      }
      return db
        .prepare(
          `SELECT id, run_id, code, detail, how_we_attacked, created_at
           FROM ops_challenges ORDER BY created_at DESC LIMIT ?`,
        )
        .all(limit);
    },
  };
}
