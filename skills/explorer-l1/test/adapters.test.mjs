import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as jsClient from "../src/adapters/js-http-client.mjs";
import * as routeYaml from "../src/adapters/route-manifest-yaml.mjs";
import { adapterFor } from "../src/adapters/index.mjs";
import { contractKey, normalizeHttpPath, normalizeMethod } from "../src/path-normalize.mjs";

const helpers = { contractKey, normalizeHttpPath, normalizeMethod };
const meta = { namespace: "demo", logical_repo: "portal", source_revision: "125675e9" };

const CLIENT_JS = `
function iamUrl() {
    return process.env.IAM_API_URL || "http://localhost:8080";
}

function apiKey() {
    return process.env.IAM_API_KEY || "";
}

function callBearer(method, path, body) {
    var url = iamUrl() + path;
    return fetch.post(url, { body: JSON.stringify(body) });
}

exports.login = function (username, password) {
    return callBearer("POST", "/api/v1/iam/auth/login", { username: username });
};

exports.register = function (name) {
    var url = iamUrl() + "/api/v1/iam/auth/register";
    return fetch.post(url, {});
};
`;

const MANIFEST = `
- type: runtime
  virtual_hosts:
    - hostname: "default"
      rules:
        - path: "/api/auth/login"
          methods: ["POST"]
          roles: ["*"]

        - path: "/api/payment/public"
          methods: ["*"]
          roles: ["*"]

        - path: "/api/user"
          methods: ["GET", "PUT"]
`;

describe("js-http-client adapter", () => {
  test("only claims client libraries, never handlers or bundles", () => {
    assert.equal(jsClient.matches("scripts/lib/iam-client.js"), true);
    assert.equal(jsClient.matches("scripts/api/auth/forgot-password.js"), false);
    assert.equal(jsClient.matches("static/js/vendor/app.min.js"), false);
    assert.equal(jsClient.matches("node_modules/lib/x.js"), false);
  });

  test("an API KEY next to an API URL is not treated as a service binding", () => {
    const { byFn, keys } = jsClient.collectBaseUrlBindings(CLIENT_JS.split("\n"));
    assert.equal(byFn.iamUrl, "IAM_API_URL");
    assert.equal(byFn.apiKey, undefined, "IAM_API_KEY is not a base URL");
    assert.deepEqual(keys, ["IAM_API_URL"]);
  });

  test("carries the config key so the edge can be config-bound, not guessed", () => {
    const facts = jsClient.extract(CLIENT_JS, "scripts/lib/iam-client.js", meta, helpers);
    const outbound = facts.filter((f) => f.kind === "http_outbound");
    assert.equal(outbound.length, 2);
    for (const f of outbound) assert.equal(f.config_key, "IAM_API_URL");
    assert.deepEqual(
      outbound.map((f) => f.contract_key).sort(),
      ["POST /api/v1/iam/auth/login", "POST /api/v1/iam/auth/register"],
    );
    assert.ok(facts.some((f) => f.kind === "config_binding" && f.config_key === "IAM_API_URL"));
  });
});

describe("route-manifest-yaml adapter", () => {
  test("claims demo.yaml and nothing else", () => {
    assert.equal(routeYaml.matches("customer/demo.yaml"), true);
    assert.equal(routeYaml.matches("src/main/resources/application.yml"), false);
    assert.equal(adapterFor("admin/demo.yaml")?.id, "route-manifest-yaml");
  });

  test("declares routes as INBOUND — the direction the generic yaml rule got wrong", () => {
    const facts = routeYaml.extract(MANIFEST, "customer/demo.yaml", meta, helpers);
    for (const f of facts) assert.equal(f.kind, "http_inbound");
    assert.deepEqual(
      facts.map((f) => f.contract_key).sort(),
      ["GET /api/user", "POST /api/auth/login", "PUT /api/user"],
    );
  });

  test('methods: ["*"] is skipped instead of inventing verbs', () => {
    const facts = routeYaml.extract(MANIFEST, "customer/demo.yaml", meta, helpers);
    assert.equal(
      facts.some((f) => f.path === "/api/payment/public"),
      false,
      "a wildcard verb is not a declared contract",
    );
    assert.ok(routeYaml.describes().blind_to.some((s) => s.includes('methods: ["*"]')));
  });
});
