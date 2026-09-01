/**
 * Journal store: one row per pipeline phase, optional challenges.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { homedir, hostname as getHostname } from "node:os";
import { join } from "node:path";

import { SCHEMA_SQL } from "./schema.mjs";
import { createLearningLoopPersistence } from "./learning-loop-store.mjs";
import { createLearningLoopApi } from "./learning-loop-api.mjs";

export class OpsStoreError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "OpsStoreError";
  }
}

const HOSTNAME = getHostname();
const PATH_RE = /(^|[\s"'`(=:])(\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/)[^\s"'`)\]}]*/;
const SECRET_KEYWORD_RE = /\b(password|secret|token|api[_-]?key|private[_-]?key)\b/i;
const SECRET_ASSIGN_RE = /\b(password|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*\S+/i;

function isUnsafeString(s) {
  if (typeof s !== "string") return false;
  if (s.includes(HOSTNAME)) return true;
  if (PATH_RE.test(s)) return true;
  if (SECRET_ASSIGN_RE.test(s)) return true;
  return false;
}

function isSecretKeyword(s) {
  return typeof s === "string" && SECRET_KEYWORD_RE.test(s);
}

function hasUnsafe(v) {
  if (typeof v === "string") return isUnsafeString(v);
  if (Array.isArray(v)) return v.some(hasUnsafe);
  if (v && typeof v === "object") {
    return Object.keys(v).some((k) => isSecretKeyword(k) || isUnsafeString(k) || hasUnsafe(v[k])) ||
           Object.values(v).some(hasUnsafe);
  }
  return false;
}

function validateLogInput(rec) {
  if (rec.detail && hasUnsafe(rec.detail)) {
    throw new OpsStoreError("unsafe content in detail (path, hostname or secret)");
  }
  for (const ch of rec.challenges ?? []) {
    if (hasUnsafe(ch.detail) || hasUnsafe(ch.how_we_attacked)) {
      throw new OpsStoreError("unsafe content in challenge (path, hostname or secret)");
    }
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
  db.exec("PRAGMA foreign_keys = ON;");
  const _learningLoopPersistence = createLearningLoopPersistence(db);
  const _learningLoopApi = createLearningLoopApi(db, _learningLoopPersistence);

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
      validateLogInput(rec);
      const runId =
        typeof rec.run_id === "string" && rec.run_id !== ""
          ? rec.run_id
          : `ops-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
      const now = new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
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
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
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

    recordOutcome: _learningLoopApi.recordOutcome,
    loadContext: _learningLoopApi.loadContext,
    resolveGap: _learningLoopApi.resolveGap,
  };
}
