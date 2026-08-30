#!/usr/bin/env node
/**
 * CLI for safe Context Slice garbage collection (plan Todo 16).
 *
 * Dry-run default. Deletes ONLY context_slice_* rows via FK cascade.
 * NEVER touches L0/L1/L2. NEVER runs VACUUM.
 *
 * Usage:
 *   slice-gc --db <path>                                  # dry-run (default)
 *   slice-gc --db <path> --execute                        # delete all slices
 *   slice-gc --db <path> --execute --older-than <iso>     # delete old slices
 *   slice-gc --db <path> --execute --except-hash <hash>   # preserve a hash
 *   slice-gc --db <path> --execute --keep-current         # preserve current
 *
 * Exit codes: 0 success · 1 infra/typed · 2 semantic blocker (invalid filters/flags).
 *
 * @module skills/explorer-query/src/slice-gc-cli.mjs
 */

import { DatabaseSync } from "node:sqlite";
import { runGc } from "./slice-gc.mjs";
import { migrateSliceSchema } from "./slice-store-schema.mjs";
import {
  SliceStoreError,
  exitCodeForError,
  sanitizeSliceErrorMessage,
} from "./slice-errors.mjs";

const HELP_TEXT = `slice-gc — safe context slice garbage collection

Usage:
  slice-gc --db <path> [filters] [--execute]

Flags:
  --db <path>             Shared system SQLite DB (required)
  --execute               REQUIRED to delete; omit for dry-run (default)
  --older-than <iso>      Only GC slices with created_at < timestamp (ISO 8601)
  --except-hash <hash>    Never delete this slice_hash (64-char hex; repeatable)
  --keep-current          Never delete slices referenced by context_slice_current
  --help, -h              Show this help

Deletes ONLY context_slice_* tables via FK cascade. Never touches L0/L1/L2.
Never runs VACUUM.

Exit codes: 0 success · 1 infra/typed · 2 semantic blocker
`;

const HASH_RE = /^[a-f0-9]{64}$/;

/**
 * Run the slice-gc CLI. Returns `{ code, report?, stderr? }`; never throws.
 *
 * @param {string[]} argv
 * @returns {Promise<{ code: 0 | 1 | 2, report?: object, stderr?: string }>}
 */
export async function runSliceGcCli(argv) {
  const args = parseArgs(argv);
  if (args.error) return { code: 2, stderr: args.error };
  if (args.help) return { code: 0, stderr: HELP_TEXT };

  // CLI-level filter validation (exit 2 for user input errors).
  if (args.olderThan !== null) {
    if (Number.isNaN(new Date(args.olderThan).getTime())) {
      return {
        code: 2,
        stderr: `--older-than must be a valid ISO 8601 timestamp: ${args.olderThan}`,
      };
    }
  }
  for (const h of args.exceptHash) {
    if (!HASH_RE.test(h)) {
      return {
        code: 2,
        stderr: `--except-hash must be a 64-char lowercase hex sha256: ${h}`,
      };
    }
  }

  let db;
  try {
    db = new DatabaseSync(args.db);
    migrateSliceSchema(db);
  } catch (err) {
    return {
      code: 1,
      stderr: `failed to open db: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const report = runGc({
      db,
      filters: {
        olderThan: args.olderThan,
        exceptHash: args.exceptHash,
        keepCurrent: args.keepCurrent,
      },
      dryRun: !args.execute,
    });
    return { code: 0, report };
  } catch (err) {
    return {
      code: exitCodeForError(err),
      stderr: sanitizeSliceErrorMessage(err),
    };
  } finally {
    try {
      if (db) db.close();
    } catch {
      // best effort
    }
  }
}

/**
 * Parse argv into a typed args object.
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const args = {
    db: null,
    execute: false,
    olderThan: null,
    exceptHash: [],
    keepCurrent: false,
    help: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--execute") {
      args.execute = true;
    } else if (a === "--keep-current") {
      args.keepCurrent = true;
    } else if (a === "--db") {
      args.db = rest[i + 1];
      i += 1;
    } else if (a === "--older-than") {
      args.olderThan = rest[i + 1];
      i += 1;
    } else if (a === "--except-hash") {
      const v = rest[i + 1];
      if (typeof v === "string" && v.length > 0) args.exceptHash.push(v);
      i += 1;
    } else {
      return { error: `unexpected argument: ${a}\n\n${HELP_TEXT}` };
    }
  }
  if (args.help) return args;
  if (!args.db) return { error: `--db <path> is required\n\n${HELP_TEXT}` };
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSliceGcCli(process.argv).then(({ code, stderr }) => {
    if (stderr) console.error(stderr);
    process.exit(code);
  });
}
