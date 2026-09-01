import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalizeSignal,
  makeObservationId,
  makeGapKey,
} from "../src/canonical-observation.mjs";
import {
  detectObservations,
  validateObservation,
  confirmObservation,
} from "../src/detect-observations.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", shell: false }).trim();
}

function makeRepo(files) {
  const cwd = mkdtempSync(join(tmpdir(), "audit-observation-"));
  git(cwd, ["init", "-q", "-b", "main"]);
  for (const [relativeFile, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, relativeFile)), { recursive: true });
    writeFileSync(join(cwd, relativeFile), body);
  }
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-q", "-m", "fixture"]);
  return { cwd, head: git(cwd, ["rev-parse", "HEAD"]) };
}

function crossRepoObservation(overrides = {}) {
  const fields = overrides.fields ?? {
    from_logical_repo: "checkout",
    to_contract_key: "GET /invoices/{param}",
  };
  const canonical = canonicalizeSignal({ capability: "cross-repo-http", fields });
  const gap_scope = { namespace: "ns", logical_repos: ["checkout"] };
  const base = {
    run_id: "run-1",
    capability: "cross-repo-http",
    signal_key: canonical.signal_key,
    target_signature: canonical.target_signature,
    logical_repo: "checkout",
    relative_file: "src/Client.kt",
    source_anchor: "Client#fetch",
    source_revision: "fixture-revision",
    line: 2,
    evidence_snippet:
      'fun fetch() = RestTemplate().getForObject("/invoices/{id}", Invoice::class.java)',
    coverage_classification: canonical.complete ? "POSSIBLE_OMISSION" : "UNKNOWN",
    confirmation_status: "NEEDS_REVIEW",
    gap_reason: "missing-frontier-fact",
    gap_scope,
  };
  const merged = Object.assign({}, base, overrides, {
    signal_key: canonical.signal_key,
    target_signature: canonical.target_signature,
  });
  merged.observation_id = makeObservationId({
    capability: merged.capability,
    target_signature: merged.target_signature,
    source_evidence_identity: {
      logical_repo: merged.logical_repo,
      relative_file: merged.relative_file,
      source_anchor: merged.source_anchor,
    },
  });
  merged.gap_key = makeGapKey({
    reason: merged.gap_reason,
    scope: merged.gap_scope,
    capability: merged.capability,
    target_signature: merged.target_signature,
  });
  return merged;
}

test("detectObservations derives source_revision and source_anchor from committed bytes", () => {
  const repo = makeRepo({
    "src/BillingClient.kt":
      '@FeignClient(name="billing")\ninterface BillingClient {\n@GetMapping("/invoices/{id}")\nfun get(id: String): Invoice\n}',
  });
  const observations = detectObservations({
    namespace: "ns",
    run_id: "run-1",
    repo_path: repo.cwd,
    revision: repo.head,
    logical_repo: "checkout",
    frontier_report: { facts: [], files_scanned: 1, files_total: 1 },
  });
  const feign = observations.find((item) => item.capability === "spring-feign");
  assert.equal(feign.source_revision, repo.head);
  assert.equal(feign.relative_file, "src/BillingClient.kt");
  assert.equal(feign.source_anchor, "BillingClient#get");
  rmSync(repo.cwd, { recursive: true, force: true });
});

test("exact cross-repo signal is COVERED and NOT_APPLICABLE", () => {
  const observation = crossRepoObservation({ line: 12 });
  const fact = {
    kind: "http_outbound",
    logical_repo: "checkout",
    contract_key: "GET /invoices/{param}",
    file: observation.relative_file,
    line: 40,
  };
  const actual = validateObservation({ observation, frontier_facts: [fact] });
  assert.equal(actual.coverage_classification, "COVERED");
  assert.equal(actual.confirmation_status, "NOT_APPLICABLE");
});

test("line proximity without target signature is MAYBE_COVERED and NEEDS_REVIEW", () => {
  const observation = crossRepoObservation({ line: 12 });
  const fact = {
    kind: "http_outbound",
    logical_repo: "checkout",
    contract_key: "POST /other",
    file: observation.relative_file,
    line: 10,
  };
  const actual = validateObservation({ observation, frontier_facts: [fact] });
  assert.equal(actual.coverage_classification, "MAYBE_COVERED");
  assert.equal(actual.confirmation_status, "NEEDS_REVIEW");
});

test("confirmation never promotes a MAYBE_COVERED proximity match", () => {
  const repo = makeRepo({
    "src/Client.kt":
      'class Client {\n  fun fetch() = RestTemplate().getForObject("/invoices/{id}", Invoice::class.java)\n}\n',
  });
  const observation = crossRepoObservation({ line: 2, source_revision: repo.head });
  const nearFact = {
    kind: "http_outbound",
    logical_repo: "checkout",
    contract_key: "POST /other",
    file: observation.relative_file,
    line: 3,
  };
  const validated = validateObservation({ observation, frontier_facts: [nearFact] });
  const confirmed = confirmObservation({
    observation: validated,
    frontier_facts: [nearFact],
    frontier_complete: true,
    repo_path: repo.cwd,
  });
  assert.equal(confirmed.coverage_classification, "MAYBE_COVERED");
  assert.equal(confirmed.confirmation_status, "NEEDS_REVIEW");
  rmSync(repo.cwd, { recursive: true, force: true });
});

test("semantic confirmation matches logical_repo together with contract_key", () => {
  const repo = makeRepo({
    "src/Client.kt":
      'class Client {\n  fun fetch() = RestTemplate().getForObject("/invoices/{id}", Invoice::class.java)\n}\n',
  });
  const observation = crossRepoObservation({ line: 2, source_revision: repo.head });
  const otherRepoFact = {
    kind: "http_outbound",
    logical_repo: "billing",
    contract_key: observation.signal_key.fields.to_contract_key,
    file: "src/Other.kt",
    line: 20,
  };
  const validated = validateObservation({ observation, frontier_facts: [otherRepoFact] });
  const confirmed = confirmObservation({
    observation: validated,
    frontier_facts: [otherRepoFact],
    frontier_complete: true,
    repo_path: repo.cwd,
  });
  assert.equal(confirmed.coverage_classification, "POSSIBLE_OMISSION");
  assert.equal(confirmed.confirmation_status, "AUTO_CONFIRMED");
  rmSync(repo.cwd, { recursive: true, force: true });
});

test("complete cross-repo semantic absence is AUTO_CONFIRMED", () => {
  const repo = makeRepo({
    "src/Client.kt":
      'class Client {\n  fun fetch() = RestTemplate().getForObject("/invoices/{id}", Invoice::class.java)\n}\n',
  });
  const observation = crossRepoObservation({ line: 2, source_revision: repo.head });
  const actual = confirmObservation({
    observation,
    frontier_facts: [],
    frontier_complete: true,
    repo_path: repo.cwd,
  });
  assert.equal(actual.coverage_classification, "POSSIBLE_OMISSION");
  assert.equal(actual.confirmation_status, "AUTO_CONFIRMED");
  rmSync(repo.cwd, { recursive: true, force: true });
});

test("frontier_complete=false forces NEEDS_REVIEW even for complete cross-repo-http", () => {
  const repo = makeRepo({
    "src/Client.kt":
      'class Client {\n  fun fetch() = RestTemplate().getForObject("/invoices/{id}", Invoice::class.java)\n}\n',
  });
  const observation = crossRepoObservation({ line: 2, source_revision: repo.head });
  const actual = confirmObservation({
    observation,
    frontier_facts: [],
    frontier_complete: false,
    repo_path: repo.cwd,
  });
  assert.equal(actual.confirmation_status, "NEEDS_REVIEW");
  rmSync(repo.cwd, { recursive: true, force: true });
});

test("git read failure forces NEEDS_REVIEW", () => {
  const observation = crossRepoObservation({ source_revision: "nonexistent-rev" });
  const actual = confirmObservation({
    observation,
    frontier_facts: [],
    frontier_complete: true,
    repo_path: "/tmp/nonexistent",
  });
  assert.equal(actual.confirmation_status, "NEEDS_REVIEW");
});

test("unreproducible source_anchor forces NEEDS_REVIEW", () => {
  const repo = makeRepo({
    "src/Client.kt": 'class Client {\n  fun fetch() = RestTemplate().getForObject("/invoices/{id}", Invoice::class.java)\n}\n',
  });
  const observation = crossRepoObservation({
    line: 2,
    source_revision: repo.head,
    source_anchor: "Client#wrong",
  });
  const actual = confirmObservation({
    observation,
    frontier_facts: [],
    frontier_complete: true,
    repo_path: repo.cwd,
  });
  assert.equal(actual.confirmation_status, "NEEDS_REVIEW");
  rmSync(repo.cwd, { recursive: true, force: true });
});

test("java-call capability remains NEEDS_REVIEW", () => {
  const observation = {
    ...crossRepoObservation(),
    capability: "java-call",
    confirmation_status: "NEEDS_REVIEW",
  };
  const actual = confirmObservation({
    observation,
    frontier_facts: [],
    frontier_complete: true,
    repo_path: "/tmp",
  });
  assert.equal(actual.confirmation_status, "NEEDS_REVIEW");
});

test("cross-repo-http with empty to_contract_key is UNKNOWN and NEEDS_REVIEW", () => {
  const observation = crossRepoObservation({
    fields: { from_logical_repo: "checkout", to_contract_key: "" },
  });
  const actual = validateObservation({ observation, frontier_facts: [] });
  assert.equal(actual.coverage_classification, "UNKNOWN");
  assert.equal(actual.confirmation_status, "NEEDS_REVIEW");
});

test("detectObservations applies validate then confirm using frontier_report facts (flow enforcement)", () => {
  const repo = makeRepo({
    "src/Client.kt":
      'class Client {\n  fun fetch() = RestTemplate().getForObject("/invoices/{id}", Invoice::class.java)\n}\n',
  });
  const fact = {
    kind: "http_outbound",
    namespace: "ns",
    logical_repo: "checkout",
    source_revision: repo.head,
    contract_key: "GET /invoices/{param}",
    file: "src/Client.kt",
    line: 40,
  };
  const observations = detectObservations({
    namespace: "ns",
    run_id: "run-1",
    repo_path: repo.cwd,
    revision: repo.head,
    logical_repo: "checkout",
    frontier_report: { facts: [fact], files_scanned: 1, files_total: 1, source_revision: repo.head },
  });
  const httpObs = observations.find((o) => o.capability === "cross-repo-http");
  assert.equal(httpObs.coverage_classification, "COVERED");
  assert.equal(httpObs.confirmation_status, "NOT_APPLICABLE");
  rmSync(repo.cwd, { recursive: true, force: true });
});

test("mixed Feign interface + Controller class in one file emits both (per-type precedence)", () => {
  const repo = makeRepo({
    "src/Mixed.kt":
      '@FeignClient(name="billing")\ninterface BillingClient {\n@GetMapping("/invoices")\nfun get(): Invoice\n}\n\n@RestController\nclass OrderController {\n@GetMapping("/orders")\nfun list(): List<Order>\n}',
  });
  const observations = detectObservations({
    namespace: "ns",
    run_id: "run-1",
    repo_path: repo.cwd,
    revision: repo.head,
    logical_repo: "checkout",
    frontier_report: { facts: [], files_scanned: 1, files_total: 1, source_revision: repo.head },
  });
  const feign = observations.find((o) => o.capability === "spring-feign" && o.source_anchor === "BillingClient#get");
  const ctrl = observations.find((o) => o.capability === "spring-controller" && o.source_anchor === "OrderController#list");
  assert.ok(feign, "Feign must be emitted");
  assert.ok(ctrl, "Controller must be emitted independently");
  rmSync(repo.cwd, { recursive: true, force: true });
});

test("two methods cannot steal annotations or calls across declaration boundaries", () => {
  const repo = makeRepo({
    "src/Bound.kt":
      'class Bound {\n  @GetMapping("/a")\n  fun a() {}\n  fun b() { RestTemplate().getForObject("/b", String::class.java) }\n}',
  });
  const observations = detectObservations({
    namespace: "ns",
    run_id: "run-1",
    repo_path: repo.cwd,
    revision: repo.head,
    logical_repo: "checkout",
    frontier_report: { facts: [], files_scanned: 1, files_total: 1, source_revision: repo.head },
  });
  const ctrl = observations.find((o) => o.source_anchor === "Bound#a");
  const http = observations.find((o) => o.source_anchor === "Bound#b");
  assert.ok(ctrl);
  assert.ok(http);
  assert.equal(observations.filter((o) => o.capability === "spring-controller").length, 1);
  rmSync(repo.cwd, { recursive: true, force: true });
});

test("exact containing Type#method anchors and deterministic evidence", () => {
  const repo = makeRepo({
    "src/Exact.kt": '@FeignClient(name="ex")\ninterface ExactClient {\n@GetMapping("/x")\nfun x(): X\n}',
  });
  const observations = detectObservations({
    namespace: "ns",
    run_id: "run-1",
    repo_path: repo.cwd,
    revision: repo.head,
    logical_repo: "checkout",
    frontier_report: { facts: [], files_scanned: 1, files_total: 1, source_revision: repo.head },
  });
  const feign = observations.find((o) => o.capability === "spring-feign");
  assert.equal(feign.source_anchor, "ExactClient#x");
  assert.ok(feign.evidence_snippet.includes("@GetMapping"));
  rmSync(repo.cwd, { recursive: true, force: true });
});

test("no framework/java-call duplication inside same type", () => {
  const repo = makeRepo({
    "src/NoDup.kt":
      '@FeignClient(name="nd")\ninterface NoDupClient {\n@GetMapping("/nd")\nfun nd(): ND\n}',
  });
  const observations = detectObservations({
    namespace: "ns",
    run_id: "run-1",
    repo_path: repo.cwd,
    revision: repo.head,
    logical_repo: "checkout",
    frontier_report: { facts: [], files_scanned: 1, files_total: 1, source_revision: repo.head },
  });
  const javaCalls = observations.filter((o) => o.capability === "java-call");
  assert.equal(javaCalls.length, 0);
  rmSync(repo.cwd, { recursive: true, force: true });
});

test("dynamic vs static completeness: non-empty args complete, zero/unknown incomplete", () => {
  const repo = makeRepo({
    "src/Dyn.kt":
      'class Dyn {\n  fun staticCall() = RestTemplate().getForObject("/s", String::class.java)\n  fun dynCall(p: String) = RestTemplate().getForObject(p, String::class.java)\n}',
  });
  const observations = detectObservations({
    namespace: "ns",
    run_id: "run-1",
    repo_path: repo.cwd,
    revision: repo.head,
    logical_repo: "checkout",
    frontier_report: { facts: [], files_scanned: 1, files_total: 1, source_revision: repo.head },
  });
  const stat = observations.find((o) => o.source_anchor === "Dyn#staticCall");
  const dyn = observations.find((o) => o.source_anchor === "Dyn#dynCall");
  assert.equal(stat.coverage_classification, "POSSIBLE_OMISSION");
  assert.equal(dyn.coverage_classification, "UNKNOWN");
  rmSync(repo.cwd, { recursive: true, force: true });
});
