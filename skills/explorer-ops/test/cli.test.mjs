import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  canonicalizeSignal,
  makeGapKey,
  makeObservationId,
} from "../../explorer-audit/src/canonical-observation.mjs";

function cliOutcomeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "ops-cli-loop-"));
  const db = join(dir, "ops.sqlite");
  const canonical = canonicalizeSignal({
    capability: "cross-repo-http",
    fields: { from_logical_repo: "checkout", to_contract_key: "GET /invoices/{param}" },
  });
  const gap_scope = { namespace: "ns", logical_repos: ["checkout"] };
  const observation = {
    run_id: "run-1",
    capability: "cross-repo-http",
    signal_key: canonical.signal_key,
    target_signature: canonical.target_signature,
    logical_repo: "checkout",
    relative_file: "src/Client.kt",
    source_anchor: "Client#fetch",
    source_revision: "rev-1",
    line: 2,
    evidence_snippet: "RestTemplate.getForObject",
    coverage_classification: "POSSIBLE_OMISSION",
    confirmation_status: "AUTO_CONFIRMED",
    gap_reason: "missing-frontier-fact",
    gap_scope,
    observed_at: "2026-09-01T10:00:00.000Z",
  };
  observation.observation_id = makeObservationId({
    capability: observation.capability,
    target_signature: observation.target_signature,
    source_evidence_identity: {
      logical_repo: observation.logical_repo,
      relative_file: observation.relative_file,
      source_anchor: observation.source_anchor,
    },
  });
  observation.gap_key = makeGapKey({
    reason: observation.gap_reason,
    scope: observation.gap_scope,
    capability: observation.capability,
    target_signature: observation.target_signature,
  });
  return {
    dir,
    db,
    input: {
      run: {
        run_id: "run-1",
        namespace: "ns",
        phase: "audit",
        status: "ok",
        logical_repos: ["checkout"],
        source_revision: "rev-1",
        started_at: "2026-09-01T10:00:00.000Z",
      },
      observations: [observation],
    },
  };
}

function run(args) {
  return spawnSync("node", ["skills/explorer-ops/cli.mjs", ...args], { encoding: "utf8" });
}

test("record-outcome accepts literal JSON and load-context reads the promoted gap", () => {
  const fixture = cliOutcomeFixture();
  const recorded = run(["record-outcome", "--db", fixture.db, "--input-json", JSON.stringify(fixture.input)]);
  assert.equal(recorded.status, 0, recorded.stderr);
  const loaded = run([
    "load-context",
    "--db",
    fixture.db,
    "--scope-json",
    JSON.stringify({ namespace: "ns", logical_repos: ["checkout"] }),
    "--objective",
    "audit coverage",
    "--limit",
    "20",
  ]);
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(JSON.parse(loaded.stdout).gaps[0].gap_key, fixture.input.observations[0].gap_key);
  rmSync(fixture.dir, { recursive: true, force: true });
});

test("resolve-gap closes a promoted gap with accepted evidence", () => {
  const fixture = cliOutcomeFixture();
  const recorded = run(["record-outcome", "--db", fixture.db, "--input-json", JSON.stringify(fixture.input)]);
  assert.equal(recorded.status, 0, recorded.stderr);
  const resolved = run([
    "resolve-gap",
    "--db",
    fixture.db,
    "--gap-key",
    fixture.input.observations[0].gap_key,
    "--resolution",
    "resolved",
    "--accepted-evidence-ref",
    "src/Client.kt#Client.fetch",
  ]);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.equal(JSON.parse(resolved.stdout).status, "resolved");
  rmSync(fixture.dir, { recursive: true, force: true });
});

test("argument and JSON errors exit 1 while OpsStoreError exits 2", () => {
  const fixture = cliOutcomeFixture();
  const invalidJson = run(["record-outcome", "--db", fixture.db, "--input-json", "{"]);
  assert.equal(invalidJson.status, 1);
  const contractError = run([
    "load-context",
    "--db",
    fixture.db,
    "--scope-json",
    JSON.stringify({ namespace: "ns", logical_repos: ["checkout"] }),
    "--objective",
    "audit coverage",
    "--limit",
    "0",
  ]);
  assert.equal(contractError.status, 2);
  rmSync(fixture.dir, { recursive: true, force: true });
});
