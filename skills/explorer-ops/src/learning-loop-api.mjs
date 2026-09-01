/**
 * Learning Loop public API (Task 4).
 * Single transaction boundary over Task 3 primitives.
 * recordOutcome owns exactly one BEGIN IMMEDIATE; primitives remain transaction-agnostic.
 */
import { OpsStoreError } from "./store.mjs";
import { stableStringify } from "../../explorer-l0/src/stable-json.mjs";
import { hostname as getHostname } from "node:os";

const PATH_RE = /(^|[\s"'`(=:])(\/Users\/|\/home\/|[A-Za-z]:\\|\/private\/)[^\s"'`)\]}]*/;
const SECRET_KEYWORD_RE = /\b(password|secret|token|api[_-]?key|private[_-]?key)\b/i;
const SECRET_ASSIGN_RE = /\b(password|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*\S+/i;

const HOSTNAME = getHostname();

function isUnsafeString(s) {
  if (typeof s !== "string") return false;
  if (s.includes(HOSTNAME)) return true;
  if (PATH_RE.test(s)) return true;
  if (SECRET_ASSIGN_RE.test(s)) return true;
  return false;
}

function hasUnsafe(v) {
  if (typeof v === "string") return isUnsafeString(v);
  if (Array.isArray(v)) return v.some(hasUnsafe);
  if (v && typeof v === "object") {
    return Object.keys(v).some((k) => SECRET_KEYWORD_RE.test(k) || isUnsafeString(k) || hasUnsafe(v[k])) ||
           Object.values(v).some(hasUnsafe);
  }
  return false;
}

function isValidRepositoryReference(ref) {
  if (typeof ref !== "string" || ref === "") return false;
  if (hasUnsafe(ref)) return false;
  if (ref.includes("..")) return false;
  if (PATH_RE.test(ref)) return false;
  if (!ref.includes("#")) return false;
  const [pathPart, anchor] = ref.split("#");
  if (!pathPart || pathPart.trim() === "" || !anchor || anchor.trim() === "") return false;
  if (!/[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+#/.test(ref)) return false;
  return true;
}

function isValidHumanClosure(closure) {
  if (!closure || typeof closure !== "object") return false;
  if (typeof closure.actor !== "string" || closure.actor.trim() === "") return false;
  if (typeof closure.reason !== "string" || closure.reason.trim() === "") return false;
  if (hasUnsafe(closure.actor) || hasUnsafe(closure.reason)) return false;
  return true;
}

export function createLearningLoopApi(db, persistence) {
  if (!db || typeof db.prepare !== "function") {
    throw new OpsStoreError("db must be a DatabaseSync instance");
  }
  if (!persistence || typeof persistence.insertOrCompareRun !== "function") {
    throw new OpsStoreError("persistence must be createLearningLoopPersistence result");
  }

  function recordOutcome(input) {
    if (!input || !input.run || !Array.isArray(input.observations)) {
      throw new OpsStoreError("recordOutcome requires {run, observations}");
    }
    const run = input.run;
    if (typeof run.run_id !== "string" || run.run_id === "") {
      throw new OpsStoreError("run.run_id is required");
    }
    if (typeof run.started_at !== "string" || run.started_at === "") {
      throw new OpsStoreError("run.started_at is required for deterministic retry identity");
    }
    for (const obs of input.observations) {
      if (obs.run_id !== run.run_id || obs.source_revision !== run.source_revision) {
        throw new OpsStoreError("observation/run identity mismatch");
      }
    }
    const started_at = run.started_at;

    db.exec("BEGIN IMMEDIATE");
    try {
      persistence.insertOrCompareRun({
        run_id: run.run_id,
        namespace: run.namespace ?? null,
        phase: run.phase,
        status: run.status,
        logical_repos: run.logical_repos ?? null,
        source_revision: run.source_revision ?? null,
        started_at,
      });

      persistence.markAffectedGapsStale({
        run_id: run.run_id,
        scope: { namespace: run.namespace ?? null, logical_repos: run.logical_repos ?? [] },
        source_revision: run.source_revision ?? null,
        observed_at: started_at,
      });

      let observations_created = 0;
      let observations_reused = 0;
      let gap_occurrences_created = 0;

      for (const obs of input.observations) {
        const obsWithTime = {
          ...obs,
          observed_at: started_at,
          created_at: started_at,
        };
        const obsRes = persistence.insertOrCompareObservation(obsWithTime);
        if (obsRes.created) {
          observations_created++;
        } else {
          observations_reused++;
        }

        const isConfirmed = obs.confirmation_status === "AUTO_CONFIRMED" || obs.confirmation_status === "HUMAN_CONFIRMED";
        if (isConfirmed && obs.gap_key) {
          persistence.ensureCoverageGap({
            gap_key: obs.gap_key,
            reason: obs.gap_reason,
            scope: obs.gap_scope,
            capability: obs.capability,
            target_signature: obs.target_signature,
            observed_at: started_at,
          });
          const occRes = persistence.insertGapOccurrence({
            run_id: run.run_id,
            gap_key: obs.gap_key,
            observation_id: obs.observation_id,
            source_revision: run.source_revision ?? null,
            observed_at: started_at,
          });
          if (occRes.created) {
            gap_occurrences_created++;
          }
          persistence.rebuildGapProjection(obs.gap_key);

          // Reopen on confirmed recurrence (new occurrence in this run)
          if (occRes.created) {
            const current = persistence.getCoverageGap(obs.gap_key);
            if (current && (current.status === "stale" || current.status === "resolved" || current.status === "superseded")) {
              persistence.updateGapStatus({
                gap_key: obs.gap_key,
                expected_statuses: [current.status],
                to_status: "open",
              });
              persistence.appendGapHistory({
                gap_key: obs.gap_key,
                run_id: run.run_id,
                from_status: current.status,
                to_status: "open",
                source_revision: run.source_revision ?? null,
                transition_reason: "recurrence-confirmed",
                evidence_ref: null,
                created_at: started_at,
              });
            }
          }
        }
      }

      db.exec("COMMIT");
      return {
        run_id: run.run_id,
        observations_created,
        observations_reused,
        gap_occurrences_created,
      };
    } catch (e) {
      db.exec("ROLLBACK");
      if (e instanceof OpsStoreError) {
        throw e;
      }
      throw new OpsStoreError(e?.message || "recordOutcome failed");
    }
  }

  function loadContext(input) {
    if (!input || typeof input.objective !== "string" || input.objective === "") {
      throw new OpsStoreError("objective is required");
    }
    if (!input.scope || typeof input.scope.namespace !== "string") {
      throw new OpsStoreError("scope.namespace is required");
    }
    let limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new OpsStoreError("limit must be >= 1");
    }
    if (limit > 50) limit = 50;

    const raw = persistence.listContextGaps({ scope: input.scope, limit });
    const gaps = raw
      .filter((g) => g.status === "open" || g.status === "stale")
      .map((g) => ({
        gap_key: g.gap_key,
        reason: g.reason,
        capability: g.capability,
        status: g.status,
        occurrences: g.occurrences,
        last_seen: g.last_seen,
      }));

    return {
      objective: input.objective,
      gaps,
    };
  }

  function resolveGap(input) {
    if (!input || typeof input.gap_key !== "string" || input.gap_key === "") {
      throw new OpsStoreError("gap_key is required");
    }
    if (input.resolution !== "resolved" && input.resolution !== "superseded") {
      throw new OpsStoreError("resolution must be resolved or superseded");
    }
    const gap = persistence.getCoverageGap(input.gap_key);
    if (!gap || (gap.status !== "open" && gap.status !== "stale")) {
      throw new OpsStoreError("gap must be open or stale");
    }

    const evidence_ref = input.accepted_evidence_ref ?? null;
    const human = input.human_closure ?? null;
    const replacement = input.replacement_gap_key ?? null;

    if (evidence_ref && !isValidRepositoryReference(evidence_ref)) {
      throw new OpsStoreError("accepted_evidence_ref must be a scrubbed relative repository reference (path#anchor)");
    }
    if (human && !isValidHumanClosure(human)) {
      throw new OpsStoreError("human_closure requires non-empty actor and reason (scrubbed)");
    }
    if (replacement && hasUnsafe(replacement)) {
      throw new OpsStoreError("unsafe content in replacement_gap_key");
    }

    const hasClosure = !!evidence_ref || !!human;
    if (!hasClosure) {
      throw new OpsStoreError("resolved and superseded require accepted_evidence_ref or human_closure");
    }
    if (input.resolution === "superseded" && (!replacement || replacement === "")) {
      throw new OpsStoreError("superseded requires replacement_gap_key");
    }

    const previous_status = gap.status;
    db.exec("BEGIN IMMEDIATE");
    try {
      persistence.updateGapStatus({
        gap_key: input.gap_key,
        expected_statuses: [previous_status],
        to_status: input.resolution,
      });

      const transition_reason = input.resolution === "resolved" ? "gap-resolved" : "gap-superseded";
      persistence.appendGapHistory({
        gap_key: input.gap_key,
        run_id: null,
        from_status: previous_status,
        to_status: input.resolution,
        source_revision: null,
        transition_reason,
        evidence_ref: evidence_ref ?? (human ? stableStringify(human) : null),
        created_at: new Date().toISOString(),
      });

      db.exec("COMMIT");
      return {
        gap_key: input.gap_key,
        previous_status,
        status: input.resolution,
      };
    } catch (e) {
      db.exec("ROLLBACK");
      if (e instanceof OpsStoreError) throw e;
      throw new OpsStoreError(e?.message || "resolveGap failed");
    }
  }

  return {
    recordOutcome,
    loadContext,
    resolveGap,
  };
}
