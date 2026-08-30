import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { extract, matches, scanOperations, describes } from "../src/adapters/go-huma.mjs";
import { adapterFor, isAdapterFile } from "../src/adapters/index.mjs";
import { contractKey, normalizeHttpPath, normalizeMethod } from "../src/path-normalize.mjs";
import { matchFrontiers } from "../src/matcher.mjs";
import { makeFrontierFactId } from "../../explorer-l0/src/layered-id.mjs";

const helpers = { contractKey, normalizeHttpPath, normalizeMethod };
const meta = { namespace: "demo", logical_repo: "cloud", source_revision: "20c3d3d2" };

/** Shaped after cloud/domains/iam/services/api/service.go */
const GO_SOURCE = `package api

func (s *Service) Register(humaApi huma.API) {
	huma.Register(humaApi, huma.Operation{
		OperationID: "v1-iam-forgot-password",
		Method:      http.MethodPost,
		Path:        "/api/v1/iam/auth/forgot-password",
		Summary:     "Forgot password",
	}, s.ForgotPassword)

	huma.Register(humaApi, huma.Operation{
		OperationID: "v1-iam-get-user",
		Method:      http.MethodGet,
		Path:        "/api/v1/iam/users/{id}",
	}, s.GetUser)

	huma.Register(humaApi, huma.Operation{
		OperationID: "v1-iam-quoted-verb",
		Method:      "delete",
		Path:        "/api/v1/iam/users/{id}",
	}, s.DeleteUser)
}
`;

describe("go-huma adapter", () => {
  test("claims .go files but never _test.go", () => {
    assert.equal(matches("domains/iam/services/api/service.go"), true);
    assert.equal(matches("domains/iam/controller/service_test.go"), false);
    assert.equal(matches("src/main/java/Controller.java"), false);
  });

  test("registry routes .go to go-huma and leaves JVM files alone", () => {
    assert.equal(adapterFor("domains/iam/services/api/service.go")?.id, "go-huma");
    assert.equal(adapterFor("src/main/kotlin/Client.kt"), null);
    assert.equal(isAdapterFile("go.mod"), false);
  });

  test("scans Operation literals with const, quoted verb and path params", () => {
    const ops = scanOperations(GO_SOURCE, "service.go");
    assert.equal(ops.length, 3);
    assert.deepEqual(
      ops.map((o) => `${o.method} ${o.path}`),
      [
        "POST /api/v1/iam/auth/forgot-password",
        "GET /api/v1/iam/users/{id}",
        "DELETE /api/v1/iam/users/{id}",
      ],
    );
    assert.equal(ops[0].operation_id, "v1-iam-forgot-password");
    assert.ok(ops[0].line > 0);
  });

  test("emits http_inbound facts with normalized contract keys", () => {
    const facts = extract(GO_SOURCE, "domains/iam/services/api/service.go", meta, helpers);
    assert.equal(facts.length, 3);
    for (const f of facts) {
      assert.equal(f.kind, "http_inbound");
      assert.equal(f.logical_repo, "cloud");
      assert.equal(f.trigger, "http-sync");
      assert.ok(f.file && f.line > 0 && f.evidence_snippet);
      assert.equal(f.id, undefined, "id is stamped by frontier-extract, not by the adapter");
    }
    assert.equal(facts[0].contract_key, "POST /api/v1/iam/auth/forgot-password");
    // {id} must collapse into the shared {param} template so JVM callers can join
    assert.equal(facts[1].contract_key, "GET /api/v1/iam/users/{param}");
  });

  test("returns nothing for Go files without huma", () => {
    assert.deepEqual(extract("package main\nfunc main() {}\n", "main.go", meta, helpers), []);
  });

  test("declares what it is blind to", () => {
    const d = describes();
    assert.equal(d.id, "go-huma");
    assert.ok(d.blind_to.length > 0, "coverage gaps must be declarable, not implicit");
  });

  test("a JVM outbound call matches a Go inbound route", () => {
    const ck = contractKey("POST", "/api/v1/iam/auth/forgot-password");
    const goFacts = extract(GO_SOURCE, "domains/iam/services/api/service.go", meta, helpers).map(
      (f) => ({
        ...f,
        id: makeFrontierFactId({
          kind: f.kind,
          namespace: f.namespace,
          logical_repo: f.logical_repo,
          source_revision: f.source_revision,
          identity_key: f.contract_key,
          file: f.file,
          line: f.line,
        }),
      }),
    );
    const jvmOutbound = [
      {
        kind: "http_outbound",
        namespace: "demo",
        logical_repo: "portal",
        source_revision: "125675e9",
        method: "POST",
        path: "/api/v1/iam/auth/forgot-password",
        contract_key: ck,
        config_key: "IAM_API_URL",
        file: "IamClient.kt",
        line: 30,
        evidence_snippet: "post(\"$iamApiUrl/api/v1/iam/auth/forgot-password\")",
        id: makeFrontierFactId({
          kind: "http_outbound",
          namespace: "demo",
          logical_repo: "portal",
          source_revision: "125675e9",
          identity_key: ck,
          file: "IamClient.kt",
          line: 30,
        }),
      },
    ];

    const edges = matchFrontiers(jvmOutbound, goFacts, { system_namespace: "demo-system" });
    assert.equal(edges.length, 1);
    assert.equal(edges[0].contract_key, ck);
    assert.equal(edges[0].evidence_class, "contract-matched");

    // With the config map wired, the same pair is promoted from guess to evidence
    const bound = matchFrontiers(jvmOutbound, goFacts, {
      system_namespace: "demo-system",
      config_target_repo: { IAM_API_URL: "cloud" },
    });
    assert.equal(bound[0].match_kind, "config_binding");
    assert.ok(bound[0].score > edges[0].score, "config binding must outrank a bare path match");
  });
});
