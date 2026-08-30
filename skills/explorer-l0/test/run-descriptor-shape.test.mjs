/**
 * Seam: pure closed build/validate/hash/freeze for run descriptor v1.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { repositorySnapshot } from "../src/git-reader.mjs";
import { chunkArtifactPath, recomputeManifestId } from "../src/manifest-builder.mjs";
import {
  RUN_DESCRIPTOR_VERSION,
  RUN_PATHS,
  RunDescriptorError,
  buildRunDescriptor,
  explorerPayloadPath,
  requireDirtyName,
  validateRunDescriptor,
} from "../src/run-descriptor-shape.mjs";
import { sha256Text, stablePretty, stableStringify } from "../src/stable-json.mjs";
import {
  MUTATION_PRE,
  buildFixtureParts,
  buildInput,
  packageIntent,
} from "./run-descriptor-fixtures.mjs";

const gitTemps = [];
afterEach(() => {
  while (gitTemps.length) rmSync(gitTemps.pop(), { recursive: true, force: true });
});

describe("constants", () => {
  test("version-1 frozen paths", () => {
    assert.equal(RUN_DESCRIPTOR_VERSION, 1);
    assert.equal(RUN_PATHS.descriptor, "run-descriptor.json");
    assert.equal(RUN_PATHS.mutationPre, "mutation-pre.json");
    assert.throws(() => { /** @type {any} */ (RUN_PATHS).descriptor = "x"; });
  });
});

describe("buildRunDescriptor / validateRunDescriptor", () => {
  test("deterministic self-hash and sealed clone", () => {
    const parts = buildFixtureParts();
    const input = buildInput(parts);
    const a = buildRunDescriptor(input);
    const b = buildRunDescriptor(input);
    assert.equal(a.version, 1);
    assert.equal(a.status, "prepared");
    assert.equal(a.descriptor_sha256, b.descriptor_sha256);
    assert.equal(stableStringify(a), stableStringify(b));
    assert.ok(Object.isFrozen(a));
    assert.ok(Object.isFrozen(a.mutation_pre));
    assert.ok(Object.isFrozen(a.paths.chunks));
    const without = structuredClone(a);
    delete without.descriptor_sha256;
    assert.equal(a.descriptor_sha256, sha256Text(stableStringify(without)));
    assert.equal(validateRunDescriptor(a).descriptor_sha256, a.descriptor_sha256);
  });

  test("caller input aliasing cannot alter sealed descriptor", () => {
    const parts = buildFixtureParts();
    const input = buildInput(parts);
    const d = buildRunDescriptor(input);
    const hash = d.descriptor_sha256;
    input.run_id = "mutated";
    input.mutation_pre.dirty_path_count = 99;
    input.package_intent.namespace = "evil";
    assert.equal(d.run_id, "run1");
    assert.equal(d.mutation_pre.dirty_path_count, 0);
    assert.equal(d.package_intent.namespace, parts.manifest.namespace);
    assert.equal(d.descriptor_sha256, hash);
    assert.throws(() => { /** @type {any} */ (d).run_id = "x"; });
    assert.throws(() => { /** @type {any} */ (d.mutation_pre).tracked_file_count = 1; });
  });

  test("returned validate clone is frozen and revalidated", () => {
    const d = buildRunDescriptor(buildInput());
    const v = validateRunDescriptor(d);
    assert.notEqual(v, d);
    assert.ok(Object.isFrozen(v));
    assert.equal(v.descriptor_sha256, d.descriptor_sha256);
  });

  test("content_hashes exact inventory set", () => {
    const parts = buildFixtureParts();
    const d = buildRunDescriptor(buildInput(parts));
    const keys = Object.keys(d.content_hashes).sort();
    const expected = [
      RUN_PATHS.artifactManifest,
      RUN_PATHS.mutationPre,
      ...parts.manifest.artifacts.map((a) => a.path),
    ].sort();
    assert.deepEqual(keys, expected);
    assert.equal(d.content_hashes[RUN_PATHS.artifactManifest], sha256Text(stablePretty(parts.manifest)));
    assert.equal(d.content_hashes[RUN_PATHS.mutationPre], sha256Text(stablePretty(MUTATION_PRE)));
    for (const art of parts.manifest.artifacts) {
      assert.equal(d.content_hashes[art.path], art.content_sha256);
    }
  });

  test("rejects nested authority in mutation_pre / threshold / chunk / manifest", () => {
    const parts = buildFixtureParts();
    assert.throws(
      () => buildRunDescriptor(buildInput(parts, { mutation_pre: { ...MUTATION_PRE, records: [] } })),
      (e) => e instanceof RunDescriptorError && /forbidden|records/i.test(e.message),
    );
    assert.throws(
      () =>
        buildRunDescriptor(
          buildInput(parts, {
            package_intent: packageIntent({
              threshold: {
                minimum_repository_verified_percentage: 0,
                require_schema_valid: true,
                require_repeatability_pass: true,
                require_mutation_equivalent: true,
                require_producer_reconciliation_pass: true,
                project_path: "/tmp",
              },
            }),
          }),
        ),
      RunDescriptorError,
    );
    const badChunk = structuredClone(parts.chunk_index);
    badChunk.chunks[0].coverage = {};
    assert.throws(
      () => buildRunDescriptor(buildInput(parts, { chunk_index: badChunk })),
      RunDescriptorError,
    );
    const badMan = structuredClone(parts.manifest);
    badMan.candidate = {};
    assert.throws(
      () => buildRunDescriptor(buildInput(parts, { artifact_manifest: badMan })),
      RunDescriptorError,
    );
  });

  test("mutation_pre closed snapshot rules", () => {
    const parts = buildFixtureParts();
    assert.throws(
      () =>
        buildRunDescriptor(
          buildInput(parts, {
            mutation_pre: { ...MUTATION_PRE, tracked_file_count: -1 },
          }),
        ),
      /non-negative/i,
    );
    assert.throws(
      () =>
        buildRunDescriptor(
          buildInput(parts, {
            mutation_pre: {
              ...MUTATION_PRE,
              dirty_path_count: 1,
              dirty_names: ["/abs/x"],
            },
          }),
        ),
      RunDescriptorError,
    );
    assert.throws(
      () =>
        buildRunDescriptor(
          buildInput(parts, {
            mutation_pre: {
              ...MUTATION_PRE,
              dirty_path_count: 1,
              dirty_names: ["../escape"],
            },
          }),
        ),
      RunDescriptorError,
    );
    assert.throws(
      () =>
        buildRunDescriptor(
          buildInput(parts, {
            mutation_pre: { ...MUTATION_PRE, summary_hash: "zz" },
          }),
        ),
      /64 lowercase hex/i,
    );
    assert.throws(
      () =>
        buildRunDescriptor(
          buildInput(parts, {
            mutation_pre: {
              anchor_object_present: true,
              tracked_file_count: 1,
              dirty_path_count: 0,
              dirty_names: [],
              // missing summary_hash
            },
          }),
        ),
      RunDescriptorError,
    );
  });

  test("manifest id recomputed via existing helper; thin/wrong id rejected", () => {
    const parts = buildFixtureParts();
    assert.equal(parts.manifest.id, recomputeManifestId(parts.manifest));
    const wrong = structuredClone(parts.manifest);
    wrong.id = "manifest:" + "0".repeat(64);
    assert.throws(
      () => buildRunDescriptor(buildInput(parts, { artifact_manifest: wrong })),
      (e) => e instanceof RunDescriptorError && /recomputed|identity|manifest/i.test(e.message),
    );
    assert.throws(
      () =>
        buildRunDescriptor(
          buildInput(parts, {
            artifact_manifest: { id: "x", namespace: "n", artifacts: [] },
          }),
        ),
      RunDescriptorError,
    );
  });

  test("rejects package_intent / acquisition mismatch", () => {
    const parts = buildFixtureParts();
    assert.throws(
      () =>
        buildRunDescriptor(
          buildInput(parts, { package_intent: packageIntent({ namespace: "other" }) }),
        ),
      RunDescriptorError,
    );
    assert.throws(
      () => buildRunDescriptor(buildInput(parts, { acquisition_mode: "reused" })),
      /acquisition/i,
    );
  });

  test("rejects empty/extra inventory contradictions", () => {
    const parts = buildFixtureParts();
    const d = buildRunDescriptor(buildInput(parts));
    const extra = structuredClone(d);
    extra.content_hashes["graphify/extra.json"] = "b".repeat(64);
    delete extra.descriptor_sha256;
    extra.descriptor_sha256 = sha256Text(stableStringify(extra));
    assert.throws(() => validateRunDescriptor(extra), /content_hashes keys/i);

    const missing = structuredClone(d);
    delete missing.content_hashes[RUN_PATHS.mutationPre];
    delete missing.descriptor_sha256;
    missing.descriptor_sha256 = sha256Text(stableStringify(missing));
    assert.throws(() => validateRunDescriptor(missing), /content_hashes keys|mutation/i);

    const badPaths = structuredClone(d);
    badPaths.paths.chunks = { ...badPaths.paths.chunks, "c:9999": "graphify/chunks/c_9999.jsonl" };
    delete badPaths.descriptor_sha256;
    badPaths.descriptor_sha256 = sha256Text(stableStringify(badPaths));
    assert.throws(() => validateRunDescriptor(badPaths), RunDescriptorError);
  });

  test("rejects corrupt descriptor_sha256 and unknown top fields", () => {
    const d = buildRunDescriptor(buildInput());
    assert.throws(() => validateRunDescriptor({ ...structuredClone(d), descriptor_sha256: "0".repeat(64) }), /descriptor_sha256/i);
    assert.throws(() => validateRunDescriptor({ ...structuredClone(d), records: [] }), RunDescriptorError);
    assert.throws(() => validateRunDescriptor({ ...structuredClone(d), project_path: "/tmp" }), RunDescriptorError);
  });

  test("explorerPayloadPath safe derivation", () => {
    assert.equal(explorerPayloadPath("c:0000"), "explorer/payloads/c_0000.json");
    assert.throws(() => explorerPayloadPath("../evil"), RunDescriptorError);
    assert.throws(() => explorerPayloadPath("c:00/00"), RunDescriptorError);
    assert.throws(() => explorerPayloadPath("c:0000\0x"), RunDescriptorError);
  });

  test("chunk paths align with manifest generated chunks", () => {
    const parts = buildFixtureParts();
    const d = buildRunDescriptor(buildInput(parts));
    for (const c of parts.chunk_index.chunks) {
      assert.equal(d.paths.chunks[c.chunk_key], chunkArtifactPath(c.chunk_key));
      assert.equal(d.content_hashes[chunkArtifactPath(c.chunk_key)], c.content_sha256);
    }
  });

  test("dirty_names accepts spaces and strips matching outer quotes", () => {
    assert.equal(requireDirtyName("my file.ts", "t"), "my file.ts");
    assert.equal(requireDirtyName('"my file.ts"', "t"), "my file.ts");
    assert.equal(requireDirtyName("src/my file.ts", "t"), "src/my file.ts");
    assert.equal(requireDirtyName(".claude/", "t"), ".claude");
    assert.equal(requireDirtyName("src/main/java/", "t"), "src/main/java");
    assert.equal(requireDirtyName('".omo/"', "t"), ".omo");
    const parts = buildFixtureParts();
    const d = buildRunDescriptor(
      buildInput(parts, {
        mutation_pre: {
          anchor_object_present: true,
          tracked_file_count: 1,
          dirty_path_count: 1,
          dirty_names: ["my file.ts"],
          summary_hash: "c".repeat(64),
        },
      }),
    );
    assert.deepEqual(d.mutation_pre.dirty_names, ["my file.ts"]);
  });

  test("dirty_names rejects absolute, drive, NUL, newline, backslash, dot segments, quoted traversal", () => {
    const bad = [
      "/abs/x",
      "C:\\Windows\\x",
      "C:/Windows/x",
      "a\0b",
      "a\nb",
      "foo\\bar",
      "../escape",
      "foo/../bar",
      "foo/./bar",
      ".",
      "..",
      '"../evil"',
      '"/abs"',
      '""',
      '"C:/x"',
    ];
    for (const name of bad) {
      assert.throws(() => requireDirtyName(name, "t"), RunDescriptorError, name);
    }
    const parts = buildFixtureParts();
    assert.throws(
      () =>
        buildRunDescriptor(
          buildInput(parts, {
            mutation_pre: {
              ...MUTATION_PRE,
              dirty_path_count: 1,
              dirty_names: ['"../evil"'],
            },
          }),
        ),
      RunDescriptorError,
    );
  });

  test("buildRunDescriptor accepts repositorySnapshot dirty_names with spaced file", () => {
    const repo = mkdtempSync(join(tmpdir(), "rd-git-"));
    gitTemps.push(repo);
    const run = (args) => {
      const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      return r.stdout.trim();
    };
    run(["init"]);
    run(["config", "user.email", "test@example.com"]);
    run(["config", "user.name", "test"]);
    writeFileSync(join(repo, "README"), "x\n");
    run(["add", "README"]);
    run(["commit", "-m", "init"]);
    const rev = run(["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "my file.ts"), "export {}\n");

    const snap = repositorySnapshot({ cwd: repo, anchorRevision: rev });
    // Git porcelain may quote paths with spaces as "my file.ts".
    assert.ok(
      snap.dirty_names.some((n) => n === "my file.ts" || n === '"my file.ts"'),
      JSON.stringify(snap.dirty_names),
    );
    assert.equal(snap.dirty_path_count, snap.dirty_names.length);

    const parts = buildFixtureParts();
    const d = buildRunDescriptor(
      buildInput(parts, {
        mutation_pre: {
          anchor_object_present: snap.anchor_object_present,
          tracked_file_count: snap.tracked_file_count,
          dirty_path_count: snap.dirty_path_count,
          dirty_names: snap.dirty_names,
          summary_hash: snap.summary_hash,
        },
      }),
    );
    // Descriptor stores canonical unquoted dirty names.
    assert.deepEqual(d.mutation_pre.dirty_names, ["my file.ts"]);
    assert.equal(d.mutation_pre.summary_hash, snap.summary_hash);
  });
});
