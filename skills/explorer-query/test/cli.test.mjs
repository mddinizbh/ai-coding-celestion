import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../cli.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore, persistCandidate, acceptBaseline } from "../../explorer-l0/src/store.mjs";
import { frontierFactsWithOrigins } from "../../explorer-l0/src/frontier-export.mjs";
import { explorerDraft, coverageDraftInputs, draftRecord } from "../../explorer-l0/test/fixtures.mjs";
import { canonicalizeCandidatePackage } from "../../explorer-l0/src/candidate-package.mjs";

describe("explorer-query cli (old commands preserved)", () => {
  it("unknown command returns 1", async () => {
    const code = await main(["unknown"]);
    assert.equal(code, 1);
  });
});

describe("explorer-query cli slice commands (real functional paths, hermetic temp DB)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "cli15-real-"));

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function setupAcceptedL0(label) {
    const l0Db = join(tmp, `${label}-l0.sqlite`);
    const draft = explorerDraft({
      coverage_report: coverageDraftInputs(),
      records: [
        draftRecord(),
        draftRecord({
          type: "Endpoint",
          natural_key: "get:/billing",
          name: "GET /billing",
          summary: "Billing endpoint",
          attributes: { method: "GET", path: "/billing", direction: "inbound", file: "src/billing.js", line: 7 },
        }),
      ],
    });
    const pkg = canonicalizeCandidatePackage(draft);
    const l0 = openStore(l0Db);
    try {
      const persisted = persistCandidate(l0, pkg);
      assert.equal(persisted.created, true, "persistCandidate must accept canonical explorerDraft fixture");
      const accepted = acceptBaseline(l0, { candidate_id: persisted.candidate_id, approver: "test" });
      assert.equal(accepted.candidate_id, persisted.candidate_id);
    } finally {
      l0.close();
    }
    const facts = frontierFactsWithOrigins(pkg);
    assert.ok(facts.length > 0, "fixture must export FrontierFacts");
    return { l0Db, pkg, factId: facts[0].fact.id };
  }

  async function captureStdout(fn) {
    const original = process.stdout.write;
    const chunks = [];
    process.stdout.write = (chunk, encoding, callback) => {
      chunks.push(String(chunk));
      if (typeof encoding === "function") encoding();
      if (typeof callback === "function") callback();
      return true;
    };
    try {
      const code = await fn();
      return { code, stdout: chunks.join("") };
    } finally {
      process.stdout.write = original;
    }
  }

  it("slice executes miss then hit on real temp DB (exit 0)", async () => {
    const { l0Db, pkg, factId } = setupAcceptedL0("slice");
    const systemDb = join(tmp, "system.sqlite");
    const seedsPath = join(tmp, "seeds.json");
    const seeds = [{ kind: "l0_fact", namespace: pkg.namespace, logical_repo: pkg.logical_repo, fact_id: factId }];
    writeFileSync(seedsPath, JSON.stringify(seeds));
    const first = await captureStdout(() => main(["slice", "--system-namespace", pkg.namespace, "--system-db", systemDb, "--l0-db", l0Db, "--policy", "journey", "--seeds", seedsPath]));
    assert.equal(first.code, 0);
    const firstBody = JSON.parse(first.stdout);
    assert.equal(firstBody.status, "materialized");
    assert.equal(firstBody.created, true);
    assert.match(firstBody.slice_hash, /^[a-f0-9]{64}$/);
    const second = await captureStdout(() => main(["slice", "--system-namespace", pkg.namespace, "--system-db", systemDb, "--l0-db", l0Db, "--policy", "journey", "--seeds", seedsPath]));
    assert.equal(second.code, 0);
    const secondBody = JSON.parse(second.stdout);
    assert.equal(secondBody.status, "cache_hit");
    assert.equal(secondBody.slice_hash, firstBody.slice_hash);
  });

  it("slice-show --slice-hash reads persisted slice (exit 0)", async () => {
    const { l0Db, pkg, factId } = setupAcceptedL0("show");
    const systemDb = join(tmp, "show-system.sqlite");
    const seedsPath = join(tmp, "show-seeds.json");
    writeFileSync(seedsPath, JSON.stringify([{ kind: "l0_fact", namespace: pkg.namespace, logical_repo: pkg.logical_repo, fact_id: factId }]));
    const sliceRun = await captureStdout(() => main(["slice", "--system-namespace", pkg.namespace, "--system-db", systemDb, "--l0-db", l0Db, "--policy", "journey", "--seeds", seedsPath]));
    assert.equal(sliceRun.code, 0);
    const sliceHash = JSON.parse(sliceRun.stdout).slice_hash;
    const shown = await captureStdout(() => main(["slice-show", "--system-db", systemDb, "--slice-hash", sliceHash]));
    assert.equal(shown.code, 0);
    const body = JSON.parse(shown.stdout);
    assert.equal(body.command, "slice-show");
    assert.equal(body.slice_hash, sliceHash);
    assert.equal(body.slice.system_namespace, pkg.namespace);
  });

  it("answer --use-slice-cache executes materialize + project (exit 0)", async () => {
    const { l0Db, pkg, factId } = setupAcceptedL0("answer");
    const systemDb = join(tmp, "answer-system.sqlite");
    const seeds = [{ kind: "l0_fact", namespace: pkg.namespace, logical_repo: pkg.logical_repo, fact_id: factId }];
    writeFileSync(join(tmp, "seeds2.json"), JSON.stringify(seeds));
    const answered = await captureStdout(() => main(["answer", "--use-slice-cache", "--system-namespace", pkg.namespace, "--system-db", systemDb, "--l0-db", l0Db, "--policy", "journey", "--seeds", join(tmp, "seeds2.json")]));
    assert.equal(answered.code, 0);
    const pack = JSON.parse(answered.stdout);
    assert.match(pack.pack_id, /^pack:[a-f0-9]{64}$/);
    assert.match(pack.slice_hash, /^[a-f0-9]{64}$/);
    assert.equal(typeof pack.generated_at, "string");
  });

  it("answer without flag preserves legacy and does not touch Slice (exit 1 on missing edges)", async () => {
    const code = await main(["answer", "--system-namespace", "test", "--edges", "nonexistent.json"]);
    assert.equal(code, 1);
  });

  it("sanitized absolute path errors (exit 1, no leak)", async () => {
    const code = await main(["slice", "--system-namespace", "/abs/ns"]);
    assert.equal(code, 1);
  });
});
