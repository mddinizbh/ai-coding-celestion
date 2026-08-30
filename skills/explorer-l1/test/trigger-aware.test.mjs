import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { makeFrontierFactId } from "../../explorer-l0/src/layered-id.mjs";
import { extractFrontierFromGit } from "../src/frontier-extract.mjs";
import { matchFrontiers } from "../src/matcher.mjs";
import { contractKey } from "../src/path-normalize.mjs";

const tempRepos = [];

afterEach(() => {
  for (const path of tempRepos.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function frontierFact(partial) {
  const identityKey = partial.contract_key || partial.topic;
  return {
    namespace: "acme",
    source_revision: "abc",
    file: partial.file || "source.kt",
    line: partial.line || 1,
    evidence_snippet: partial.evidence_snippet || "evidence",
    id: makeFrontierFactId({
      kind: partial.kind,
      namespace: "acme",
      logical_repo: partial.logical_repo,
      source_revision: "abc",
      identity_key: identityKey,
      file: partial.file || "source.kt",
      line: partial.line || 1,
    }),
    ...partial,
  };
}

describe("trigger-aware frontier extraction", () => {
  test("extracts both poll and fan-out calls from an active crontab line", () => {
    const repo = mkdtempSync(join(tmpdir(), "explorer-l1-cron-"));
    tempRepos.push(repo);
    mkdirSync(join(repo, "cron.d"));
    writeFileSync(
      join(repo, "cron.d", "jobs"),
      '*/5 10-23,0-1 * * * root curl -s "$TAX_BASE_URL/private/ipva/order/pending-list/BRADESCO?force=true" | python3 -c "print()" | xargs -P 0 -I ID curl -s -X POST "$TAX_BASE_URL/private/ipva/order/ID/submit"\n',
    );
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "add", "cron.d/jobs"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Explorer Test",
      "-c",
      "user.email=explorer@example.invalid",
      "commit",
      "-q",
      "-m",
      "fixture",
    ]);
    const revision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    const facts = extractFrontierFromGit({
      repoPath: repo,
      revision,
      namespace: "acme",
      logical_repo: "acme-cron",
    });
    const calls = facts.filter((fact) => fact.kind === "http_outbound");

    assert.equal(calls.length, 2);
    const poll = calls.find((fact) => fact.method === "GET");
    const submit = calls.find((fact) => fact.method === "POST");
    assert.equal(poll?.path, "/private/ipva/order/pending-list/bradesco");
    assert.equal(submit?.path, "/private/ipva/order/{param}/submit");
    assert.equal(poll?.config_key, "TAX_BASE_URL");
    assert.equal(submit?.config_key, "TAX_BASE_URL");
    assert.equal(poll?.trigger, "cron");
    assert.equal(submit?.trigger, "cron");
    assert.equal(poll?.schedule, "*/5 10-23,0-1 * * *");
    assert.equal(poll?.operation_index, 0);
    assert.equal(submit?.operation_index, 1);
    assert.equal(poll?.pipeline_id, submit?.pipeline_id);
  });

  test("extracts common message publishers and consumers from source", () => {
    const repo = mkdtempSync(join(tmpdir(), "explorer-l1-message-"));
    tempRepos.push(repo);
    mkdirSync(join(repo, "src"));
    writeFileSync(
      join(repo, "src", "Payments.kt"),
      `class Payments(private val kafkaTemplate: KafkaTemplate<String, String>) {
    @KafkaListener(topics = ["payment-approved"])
    fun consume(message: String) = Unit

    fun publish(payload: String) {
        kafkaTemplate.send("payment-approved", payload)
    }
}
`,
    );
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "add", "src/Payments.kt"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Explorer Test",
      "-c",
      "user.email=explorer@example.invalid",
      "commit",
      "-q",
      "-m",
      "fixture",
    ]);
    const revision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    const facts = extractFrontierFromGit({
      repoPath: repo,
      revision,
      namespace: "acme",
      logical_repo: "payments",
    });

    const publisher = facts.find((fact) => fact.kind === "topic_publish");
    const consumer = facts.find((fact) => fact.kind === "topic_consume");
    assert.equal(publisher?.topic, "payment-approved");
    assert.equal(consumer?.topic, "payment-approved");
    assert.equal(publisher?.trigger, "queue");
    assert.equal(consumer?.trigger, "queue");
    assert.equal(publisher?.messaging_system, "kafka");
    assert.equal(consumer?.messaging_system, "kafka");
  });

  test("infers an exchange method declared after a multiline URL", () => {
    const repo = mkdtempSync(join(tmpdir(), "explorer-l1-exchange-"));
    tempRepos.push(repo);
    mkdirSync(join(repo, "src"));
    writeFileSync(
      join(repo, "src", "Provider.kt"),
      'class Provider(@Value("${TAX_PROVIDER_ALT_URL}") private val apiUrl: String) {\n' +
      '    fun pay() = restTemplate.exchange<Response>(\n' +
      '        "$apiUrl/private/debits/${state.name}/${category.name}/pay",\n' +
      '        HttpMethod.POST,\n' +
      '        request\n' +
      '    )\n' +
      '}\n',
    );
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "add", "src/Provider.kt"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Explorer Test",
      "-c",
      "user.email=explorer@example.invalid",
      "commit",
      "-q",
      "-m",
      "fixture",
    ]);
    const revision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    const facts = extractFrontierFromGit({
      repoPath: repo,
      revision,
      namespace: "acme",
      logical_repo: "acme-tax",
    });
    const payment = facts.find((fact) => fact.path?.endsWith("/{param}/{param}/pay"));

    assert.equal(payment?.method, "POST");
    assert.equal(payment?.config_key, "TAX_PROVIDER_ALT_URL");
  });
});

describe("trigger-aware frontier matching", () => {
  test("classifies webhook HTTP contracts without changing HTTP matching", () => {
    const key = contractKey("POST", "/external/webhook/{partner}");
    const edges = matchFrontiers(
      [
        frontierFact({
          kind: "http_outbound",
          logical_repo: "acme-cron",
          method: "POST",
          path: "/external/webhook/{param}",
          contract_key: key,
          config_key: "TAX_BASE_URL",
          trigger: "cron",
        }),
      ],
      [
        frontierFact({
          kind: "http_inbound",
          logical_repo: "acme-tax",
          method: "POST",
          path: "/external/webhook/{param}",
          contract_key: key,
        }),
      ],
      { config_target_repo: { TAX_BASE_URL: "acme-tax" } },
    );

    assert.equal(edges.length, 1);
    assert.equal(edges[0].trigger, "cron");
    assert.equal(edges[0].interaction, "webhook");
  });

  test("matches topic publishers to consumers as queue-triggered edges", () => {
    const edges = matchFrontiers(
      [
        frontierFact({
          kind: "topic_publish",
          logical_repo: "orders",
          topic: "payment-approved",
          file: "PaymentPublisher.kt",
        }),
      ],
      [
        frontierFact({
          kind: "topic_consume",
          logical_repo: "acme-tax",
          topic: "payment-approved",
          file: "PaymentListener.kt",
        }),
      ],
    );

    assert.equal(edges.length, 1);
    assert.equal(edges[0].trigger, "queue");
    assert.equal(edges[0].interaction, "topic");
    assert.equal(edges[0].match_kind, "topic_contract");
    assert.equal(edges[0].contract_key, "TOPIC payment-approved");
    assert.equal(edges[0].from.fact_id.includes("topic_publish"), true);
    assert.equal(edges[0].to.fact_id.includes("topic_consume"), true);
  });

  test("matches concrete cron segments to parameterized inbound routes", () => {
    const outboundKey = contractKey(
      "GET",
      "/private/debits/SP/IPVA/payment/PROCESSING/retrieve-list",
    );
    const inboundKey = contractKey(
      "GET",
      "/private/debits/{state}/{debitType}/payment/{paymentStatus}/retrieve-list",
    );
    const edges = matchFrontiers(
      [
        frontierFact({
          kind: "http_outbound",
          logical_repo: "acme-cron",
          method: "GET",
          path: "/private/debits/sp/ipva/payment/processing/retrieve-list",
          contract_key: outboundKey,
          config_key: "TAX_PROVIDER_ALT_BASE_URL",
          trigger: "cron",
        }),
      ],
      [
        frontierFact({
          kind: "http_inbound",
          logical_repo: "tax-provider-alt",
          method: "GET",
          path: "/private/debits/{param}/{param}/payment/{param}/retrieve-list",
          contract_key: inboundKey,
        }),
      ],
    );

    assert.equal(edges.length, 1);
    assert.equal(edges[0].trigger, "cron");
    assert.equal(edges[0].path_match, "template");
    assert.ok(edges[0].score >= 0.9);
  });
});
