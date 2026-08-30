import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, afterEach } from "node:test";
import {
  extractConfigMapCandidates,
  buildConfigMapCandidate,
} from "../src/config-map-values.mjs";

describe("config-map-values extractor (working-tree, line-oriented, deterministic)", () => {
  let tmpRoots = [];

  function makeRepo(name, files) {
    const root = mkdtempSync(join(tmpdir(), `cfgval-${name}-`));
    tmpRoots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
    return { logical_repo: name, repo_path: root };
  }

  afterEach(() => {
    for (const r of tmpRoots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {}
    }
    tmpRoots = [];
  });

  test("exact hostname match (dotted part == logical_repo)", () => {
    const repoA = makeRepo("payment-service", {
      "application.yml": "PAYMENT_URL: https://payment-service.internal:8080\n",
    });
    const { candidates, gaps } = extractConfigMapCandidates([repoA]);
    assert.equal(gaps.length, 0);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].config_key, "PAYMENT_URL");
    assert.equal(candidates[0].logical_repo, "payment-service");
    assert.equal(candidates[0].derivation, "deploy-file");
    assert.ok(candidates[0].evidence.file.includes("application.yml"));
  });

  test("env-segment stripping from dotted parts (prod stripped -> exact match)", () => {
    const repoB = makeRepo("acme-tax", {
      "bootstrap-prod.yml": "TAX_BASE_URL: https://acme-tax.prod.cluster.local\n",
    });
    const { candidates, gaps } = extractConfigMapCandidates([repoB]);
    assert.equal(gaps.length, 0);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].config_key, "TAX_BASE_URL");
    assert.equal(candidates[0].logical_repo, "acme-tax");
  });

  test("ambiguous hostname (multiple logical match) -> gap, not proposed", () => {
    const repoC = makeRepo("cloud", {
      "application.json": '{"CLOUD_URL": "https://cloud.svc.dev"}',
    });
    const repoD = makeRepo("svc", {
      "application.json": '{"CLOUD_URL": "https://cloud.svc.dev"}',
    });
    // hostname parts "cloud","svc","dev" match TWO logicals in set -> ambiguous
    const { candidates, gaps } = extractConfigMapCandidates([repoC, repoD]);
    assert.equal(candidates.length, 0);
    assert.ok(gaps.length >= 1);
    assert.ok(gaps.some((g) => g.reason && g.reason.includes("multiple")));
  });

  test("localhost / IP / unknown hostname -> silently skipped (no candidate, no gap)", () => {
    const repoE = makeRepo("svc", {
      ".env": "LOCAL_URL=http://localhost:8080\nIP_URL=https://127.0.0.1:9000\n",
      "application.yml": "UNKNOWN: https://does-not-exist.example.com\n",
    });
    const { candidates, gaps } = extractConfigMapCandidates([repoE]);
    assert.equal(candidates.length, 0);
    assert.equal(gaps.length, 0);
  });

  test(".env + JSON + YAML all parsed (mixed keys)", () => {
    const repoPortal = makeRepo("portal", {
      ".env": "AUTH_URL=https://auth-service\n",
      "application-dev.yml": "REPORT_URL: https://report-service.dev\n",
      "bootstrap.json": '{"QUEUE_URL":"https://queue-service"}',
    });
    // include the target logicals so hostname match succeeds
    const repoAuth = makeRepo("auth-service", {});
    const repoReport = makeRepo("report-service", {});
    const repoQueue = makeRepo("queue-service", {});
    const { candidates, gaps } = extractConfigMapCandidates([
      repoPortal,
      repoAuth,
      repoReport,
      repoQueue,
    ]);
    assert.equal(gaps.length, 0);
    assert.equal(candidates.length, 3);
    const keys = candidates.map((c) => c.config_key).sort();
    assert.deepEqual(keys, ["AUTH_URL", "QUEUE_URL", "REPORT_URL"]);
  });

  test("determinism: identical input tree -> byte-equal JSON output (sorted)", () => {
    const repoG = makeRepo("det", {
      "application.yml": "A_URL: https://a-service\nB_URL: https://b-service\n",
    });
    const r1 = extractConfigMapCandidates([repoG]);
    const r2 = extractConfigMapCandidates([repoG]);
    const j1 = JSON.stringify(buildConfigMapCandidate(r1, "test-sys"), null, 2);
    const j2 = JSON.stringify(buildConfigMapCandidate(r2, "test-sys"), null, 2);
    assert.equal(j1, j2);
    // also check keys appear in alpha order in config_target_repo
    const parsed = JSON.parse(j1);
    const targetKeys = Object.keys(parsed.config_target_repo);
    assert.deepEqual(targetKeys, [...targetKeys].sort());
  });

  test("buildConfigMapCandidate produces expected shape with _provenance and _gaps", () => {
    const repoH = makeRepo("prov-service", {
      "application.yml": "P_URL: https://prov-service\n",
    });
    const derived = extractConfigMapCandidates([repoH]);
    const out = buildConfigMapCandidate(derived, "demo-system");
    assert.ok(out._comment.includes("demo-system"));
    assert.ok(out.config_target_repo.P_URL === "prov-service");
    assert.ok(out._provenance.P_URL);
    assert.ok(out._provenance.P_URL.derivation === "deploy-file");
    assert.ok(Array.isArray(out._gaps));
  });
});
