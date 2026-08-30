#!/usr/bin/env node
/**
 * CLI for the layered identity migration (ADR 0009, plan Todo 8b).
 *
 * Two-phase explicit migration with dry-run default and typed exit codes:
 *
 *   0  — success (dry-run, prepare, or rebuild completed)
 *   1  — infra/typed error (DB open, store error, corruption, MixedVersion)
 *   2  — semantic blocker (Human Gate incomplete, missing required flags)
 *
 * Usage:
 *   # Dry-run inventory (default — ZERO writes):
 *   slice-migrate dry-run --db <path>
 *
 *   # Phase A — create v2 L0 candidates (NEVER accepts; Human Gate pending):
 *   slice-migrate prepare --db <path> --execute
 *
 *   # Phase B — rebuild L1/L2/Slice from accepted v2 candidates:
 *   slice-migrate rebuild --db <path> --execute \
 *     --accepted-candidate <id> [--accepted-candidate <id> ...]
 *
 * --execute is REQUIRED for any write. Omitting it is always dry-run.
 *
 * @module skills/explorer-query/src/slice-migrate-cli.mjs
 */

import { DatabaseSync } from "node:sqlite";
import { dryRun, prepare, rebuild } from "./slice-migrate.mjs";
import {
  migrateSliceSchema,
  SHARED_SCHEMA_VERSIONS_DDL,
  SLICE_COMPONENT,
  SLICE_SCHEMA_SUPPORTED_VERSION,
} from "./slice-store-schema.mjs";
import {
  assertComponentSchemaVersionSupported,
  migrateComponentSchema,
  migrateLayerTableNames,
  UnsupportedSchemaVersionError,
} from "../../explorer-l0/src/schema-versions.mjs";
import { L1_COMPONENT, L1_SCHEMA_SUPPORTED_VERSION, L1_MIGRATION_STEPS } from "../../explorer-l1/src/system-store.mjs";
import { L2_COMPONENT, L2_SCHEMA_SUPPORTED_VERSION, L2_MIGRATION_STEPS } from "../../explorer-l2/src/journey-store.mjs";
import { SystemStoreError } from "../../explorer-l1/src/errors.mjs";
import { JourneyStoreError } from "../../explorer-l2/src/journey-store.mjs";
import { SliceStoreError, SliceMigrationError } from "./slice-errors.mjs";

const INFRA_ERRORS = new Set([
  SliceStoreError, SliceMigrationError, SystemStoreError, JourneyStoreError,
  UnsupportedSchemaVersionError,
]);

/**
 * Run the migration CLI with the given argv. Returns the exit code; never
 * throws (callers should `process.exit(await runSliceMigrateCli(process.argv))`).
 *
 * @param {string[]} argv
 * @returns {Promise<{ code: 0 | 1 | 2, report?: object, stderr?: string }>}
 */
export async function runSliceMigrateCli(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    return { code: 2, stderr: args.error };
  }
  if (args.help) {
    return { code: 0, stderr: HELP_TEXT };
  }

  let db;
  try {
    db = args.execute
      ? openDbWithAllSchemas(args.db)
      : new DatabaseSync(args.db, { readOnly: true });
  } catch (err) {
    return { code: 1, stderr: `failed to open db: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    if (args.command === "dry-run") {
      const report = dryRun({ db });
      return { code: 0, report };
    }
    if (args.command === "prepare") {
      if (!args.execute) {
        // dry-run is the default; --execute required for actual writes.
        const report = dryRun({ db });
        return { code: 0, report };
      }
      const l0Store = makeL0StoreAdapter();
      const report = prepare({ db, l0Store, dryRun: false });
      if (report.rolled_back) {
        return { code: 2, report, stderr: report.error };
      }
      return { code: 0, report };
    }
    if (args.command === "rebuild") {
      if (!args.execute) {
        const report = dryRun({ db });
        return { code: 0, report };
      }
      if (!args.acceptedCandidate || args.acceptedCandidate.length === 0) {
        return { code: 2, stderr: "rebuild --execute requires --accepted-candidate <id> (proof of Human Gate)" };
      }
      const report = rebuild({
        db,
        acceptedV2CandidateIds: args.acceptedCandidate,
        // rebuildL1/rebuildL2 are caller-provided in real deployments (Todo 19
        // wires them to the actual stitch/bind APIs). When omitted, rebuild
        // just resets the derived tables atomically.
      });
      if (report.rolled_back) {
        return { code: 2, report, stderr: report.error };
      }
      return { code: 0, report };
    }
    return { code: 2, stderr: `unknown command: ${args.command}` };
  } catch (err) {
    if (INFRA_ERRORS.some((Klass) => err instanceof Klass)) {
      return { code: 1, stderr: `${err.name}: ${err.message}` };
    }
    return { code: 1, stderr: `unexpected error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    try { db.close(); } catch { /* best effort */ }
  }
}

/**
 * Minimal L0 store adapter. In a real deployment this would call
 * `persistCandidate(canonicalizeCandidatePackage(payload))` through the actual
 * L0 store API. For the CLI we expose a stub that operators replace via
 * the L0 CLI's persist-candidate command before running `slice-migrate prepare`.
 *
 * @returns {{ persistV2Candidate: (payload: object, txDb: object) => { candidate_id: string } }}
 */
function makeL0StoreAdapter() {
  return {
    persistV2Candidate(payload, txDb) {
      // Real path (Todo 19): canonicalize payload through
      // canonicalizeCandidatePackage, then persistCandidate through the L0
      // store using txDb. For now, we throw so operators don't accidentally
      // run prepare without wiring this up.
      throw new Error(
        "slice-migrate CLI prepare --execute requires a wired L0 store adapter; " +
          "use the L0 CLI's persist-candidate command, then re-run slice-migrate rebuild",
      );
    },
  };
}

/**
 * Open the shared DB and apply every component's schema migration forward-only.
 * @param {string} dbPath
 */
function openDbWithAllSchemas(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    assertComponentSchemaVersionSupported(
      db,
      SLICE_COMPONENT,
      SLICE_SCHEMA_SUPPORTED_VERSION,
      SliceMigrationError,
    );
    assertComponentSchemaVersionSupported(db, L1_COMPONENT, L1_SCHEMA_SUPPORTED_VERSION);
    assertComponentSchemaVersionSupported(db, L2_COMPONENT, L2_SCHEMA_SUPPORTED_VERSION);
    migrateLayerTableNames(db, Error);
    db.exec(SHARED_SCHEMA_VERSIONS_DDL);
    // Slice first (idempotent — slice-store-schema already does SHARED DDL).
    migrateSliceSchema(db);
    // L1.
    migrateComponentSchema({
      db,
      component: L1_COMPONENT,
      supportedVersion: L1_SCHEMA_SUPPORTED_VERSION,
      steps: L1_MIGRATION_STEPS,
      errorCtor: SystemStoreError,
    });
    // L2.
    migrateComponentSchema({
      db,
      component: L2_COMPONENT,
      supportedVersion: L2_SCHEMA_SUPPORTED_VERSION,
      steps: L2_MIGRATION_STEPS,
      errorCtor: JourneyStoreError,
    });
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * Parse argv into a typed args object. Recognizes:
 *   dry-run | prepare | rebuild
 *   --db <path>
 *   --execute
 *   --accepted-candidate <id> (repeatable)
 *   --help | -h
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const args = { command: null, db: null, execute: false, acceptedCandidate: [], help: false };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--execute") args.execute = true;
    else if (a === "--db") {
      args.db = rest[i + 1];
      i += 1;
    } else if (a === "--accepted-candidate") {
      const v = rest[i + 1];
      if (typeof v === "string" && v.length > 0) args.acceptedCandidate.push(v);
      i += 1;
    } else if (!args.command && ["dry-run", "prepare", "rebuild"].includes(a)) {
      args.command = a;
    } else {
      return { error: `unexpected argument: ${a}\n\n${HELP_TEXT}` };
    }
  }
  if (args.help) return args;
  if (!args.command) return { error: `missing command\n\n${HELP_TEXT}` };
  if (!args.db) return { error: `--db <path> is required\n\n${HELP_TEXT}` };
  return args;
}

const HELP_TEXT = `slice-migrate — ADR 0009 layered identity migration

Usage:
  slice-migrate dry-run --db <path>
  slice-migrate prepare --db <path> --execute
  slice-migrate rebuild --db <path> --execute --accepted-candidate <id> [--accepted-candidate <id> ...]

Flags:
  --db <path>              Shared system SQLite DB (required)
  --execute                REQUIRED for any write; omit for dry-run
  --accepted-candidate <id>  Candidate id proof that Human Gate accepted the v2 baseline
  --help, -h               Show this help

Exit codes: 0 success · 1 infra/typed · 2 semantic blocker (Human Gate incomplete, missing flags)
`;

// When invoked directly as a script, run and exit with the returned code.
if (import.meta.url === `file://${process.argv[1]}`) {
  runSliceMigrateCli(process.argv).then(({ code, stderr }) => {
    if (stderr) console.error(stderr);
    process.exit(code);
  });
}
