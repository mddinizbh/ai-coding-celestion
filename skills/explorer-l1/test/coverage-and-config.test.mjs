import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  LEGACY_BUILTIN_CONFIG_MAP,
  parseInlineConfigMap,
  resolveConfigMap,
  unmappedConfigKeys,
} from "../src/config-map.mjs";
import { stitchL1 } from "../src/stitch.mjs";
import { makeFrontierFactId } from "../../explorer-l0/src/layered-id.mjs";

const meta = { namespace: "acme", source_revision: "rev" };
const fact = (repo, over) => ({
  kind: "http_outbound",
  namespace: meta.namespace,
  logical_repo: repo,
  source_revision: meta.source_revision,
  method: "GET",
  path: "/api/thing",
  contract_key: "GET /api/thing",
  file: "f.kt",
  line: 1,
  evidence_snippet: "x",
  ...over,
  id: makeFrontierFactId({
    kind: over?.kind || "http_outbound",
    namespace: meta.namespace,
    logical_repo: repo,
    source_revision: meta.source_revision,
    identity_key: over?.contract_key || "GET /api/thing",
    file: over?.file || "f.kt",
    line: over?.line ?? 1,
  }),
});

describe("config map is project data, not a built-in constant", () => {
  test("inline pairs parse and override everything else", () => {
    const parsed = parseInlineConfigMap("A_URL=svc-a,B_URL=svc-b");
    assert.deepEqual(parsed, { A_URL: "svc-a", B_URL: "svc-b" });
    const { map, sources } = resolveConfigMap({
      system_namespace: "whatever-system",
      inline: "TAX_BASE_URL=overridden",
    });
    assert.equal(map.TAX_BASE_URL, "overridden");
    assert.equal(sources.at(-1).kind, "inline");
  });

  test("a file next to the store is picked up by system namespace", () => {
    const dir = mkdtempSync(join(tmpdir(), "l1-cfg-"));
    mkdirSync(join(dir, "config-maps"), { recursive: true });
    writeFileSync(
      join(dir, "config-maps", "acme-system.json"),
      JSON.stringify({ config_target_repo: { ACME_API_URL: "acme-api" } }),
    );
    const { map, sources } = resolveConfigMap({
      system_namespace: "acme-system",
      system_db: join(dir, "acme.sqlite"),
    });
    assert.equal(map.ACME_API_URL, "acme-api");
    assert.ok(sources.some((s) => s.kind === "store_config"));
  });

  test("legacy built-ins are still there but declared as such", () => {
    const { map, sources } = resolveConfigMap({ system_namespace: "none-system" });
    assert.equal(map.TAX_BASE_URL, LEGACY_BUILTIN_CONFIG_MAP.TAX_BASE_URL);
    assert.equal(sources[0].kind, "legacy_builtin");
    const clean = resolveConfigMap({
      system_namespace: "none-system",
      include_legacy_builtin: false,
    });
    assert.deepEqual(clean.map, {});
  });

  test("rejects a malformed map instead of silently scoring low", () => {
    const dir = mkdtempSync(join(tmpdir(), "l1-cfg-bad-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ KEY: 42 }));
    assert.throws(
      () => resolveConfigMap({ system_namespace: "x-system", file: bad }),
      /logical_repo string/,
    );
  });

  test("reports which config keys would promote edges if mapped", () => {
    const frontiers = {
      portal: [fact("portal", { config_key: "IAM_API_URL" }), fact("portal", { config_key: "BASE_URL" })],
    };
    const unmapped = unmappedConfigKeys(frontiers, { IAM_API_URL: "cloud" });
    assert.deepEqual(unmapped, [{ config_key: "BASE_URL", seen_in: ["portal"] }]);
  });
});

describe("an empty frontier blocks instead of reporting zero edges", () => {
  const repos = [
    { logical_repo: "a", repo_path: "/nope" },
    { logical_repo: "b", repo_path: "/nope" },
  ];

  test("blocks, names the repo and persists nothing", () => {
    const res = stitchL1({
      namespace: "acme",
      system_namespace: "acme-system",
      repos,
      frontiers: { a: [fact("a")], b: [] },
      skip_baseline_check: true,
      dry_run: true,
    });
    assert.equal(res.status, "blocked");
    assert.equal(res.exit_code, 2);
    assert.deepEqual(res.empty_repos, ["b"]);
    assert.equal(res.blockers[0].code, "frontier_empty");
    assert.equal(res.blockers[0].logical_repo, "b");
    assert.ok(res.blockers[0].hint.includes("frontier-report"));
    assert.equal(res.edge_count, undefined, "no edge count is reported for a blocked run");
  });

  test("--allow-empty-frontier is an explicit opt-in, not the default", () => {
    const res = stitchL1({
      namespace: "acme",
      system_namespace: "acme-system",
      repos,
      frontiers: { a: [fact("a")], b: [] },
      skip_baseline_check: true,
      dry_run: true,
      allow_empty_frontier: true,
    });
    assert.equal(res.status, "dry_run");
    assert.deepEqual(res.empty_repos, ["b"]);
  });

  test("a fully covered system is untouched by the check", () => {
    const res = stitchL1({
      namespace: "acme",
      system_namespace: "acme-system",
      repos,
      frontiers: {
        a: [fact("a", { config_key: "A_URL" })],
        b: [
          fact("b", { kind: "http_inbound", file: "Ctl.java", line: 9 }),
        ],
      },
      skip_baseline_check: true,
      dry_run: true,
    });
    assert.equal(res.status, "dry_run");
    assert.deepEqual(res.empty_repos, []);
    assert.deepEqual(res.unmapped_config_keys, [{ config_key: "A_URL", seen_in: ["a"] }]);
  });
});
