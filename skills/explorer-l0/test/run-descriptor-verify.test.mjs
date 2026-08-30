/**
 * Seam: verifyPreparedArtifacts + listExplorerPayloadFiles + facade re-exports.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { chunkArtifactPath } from "../src/manifest-builder.mjs";
import {
  RUN_PATHS,
  RunDescriptorError,
  buildRunDescriptor,
  explorerPayloadPath,
  listExplorerPayloadFiles,
  loadRunDescriptor,
  validateRunDescriptor,
  verifyPreparedArtifacts,
  writeRunDescriptor,
} from "../src/run-descriptor.mjs";
import { stablePretty } from "../src/stable-json.mjs";
import {
  MUTATION_PRE,
  buildFixtureParts,
  buildInput,
} from "./run-descriptor-fixtures.mjs";

const temps = [];
function tempRoot(prefix = "rd-v-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

function materialize(runRoot, parts, descriptor) {
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const { loaded, projection, manifest } = parts;
  const writes = [
    [RUN_PATHS.artifactManifest, stablePretty(manifest)],
    [RUN_PATHS.mutationPre, stablePretty(MUTATION_PRE)],
    [RUN_PATHS.graphifyNative, loaded.nativeBytes],
    [RUN_PATHS.graphifyFacts, projection.jsonl],
    [RUN_PATHS.graphifyChunkIndex, projection.chunk_index_json],
    [RUN_PATHS.graphifyKeyMap, projection.key_map_json],
  ];
  for (const [rel, content] of writes) {
    const abs = join(runRoot, rel);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    if (Buffer.isBuffer(content)) writeFileSync(abs, content);
    else writeFileSync(abs, content, { encoding: "utf8" });
    chmodSync(abs, 0o600);
  }
  for (const chunk of projection.chunks) {
    const rel = chunkArtifactPath(chunk.chunk_key);
    const abs = join(runRoot, rel);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    writeFileSync(abs, chunk.jsonl, { encoding: "utf8", mode: 0o600 });
    chmodSync(abs, 0o600);
  }
  mkdirSync(join(runRoot, RUN_PATHS.explorerPayloads), { recursive: true, mode: 0o700 });
  writeRunDescriptor(runRoot, descriptor);
}

describe("verifyPreparedArtifacts", () => {
  test("accepts intact prepared run", () => {
    const parts = buildFixtureParts();
    const d = buildRunDescriptor(buildInput(parts));
    const root = tempRoot();
    materialize(root, parts, d);
    const ok = verifyPreparedArtifacts(root, d);
    assert.equal(ok.descriptor_sha256, d.descriptor_sha256);
    assert.ok(Object.isFrozen(ok));
  });

  test("fails on one-byte mutation", () => {
    const parts = buildFixtureParts();
    const d = buildRunDescriptor(buildInput(parts));
    const root = tempRoot();
    materialize(root, parts, d);
    const fp = join(root, RUN_PATHS.graphifyFacts);
    const b = readFileSync(fp);
    b[0] = (b[0] + 1) % 256;
    writeFileSync(fp, b);
    assert.throws(() => verifyPreparedArtifacts(root, d), /hash mismatch/i);
  });

  test("rejects symlink prepared artifacts", () => {
    const parts = buildFixtureParts();
    const d = buildRunDescriptor(buildInput(parts));
    const root = tempRoot();
    materialize(root, parts, d);
    const outside = join(tempRoot("rd-out-"), "secret.txt");
    writeFileSync(outside, "secret\n");
    const target = join(root, RUN_PATHS.graphifyFacts);
    rmSync(target);
    symlinkSync(outside, target);
    assert.throws(
      () => verifyPreparedArtifacts(root, d),
      (e) => e instanceof RunDescriptorError && /symlink/i.test(e.message) && !e.message.includes(outside),
    );
  });

  test("rejects directory-as-file", () => {
    const parts = buildFixtureParts();
    const d = buildRunDescriptor(buildInput(parts));
    const root = tempRoot();
    materialize(root, parts, d);
    const target = join(root, RUN_PATHS.graphifyFacts);
    rmSync(target);
    mkdirSync(target);
    assert.throws(() => verifyPreparedArtifacts(root, d), /regular file/i);
  });

  test("fails when mutation-pre file hash drifts", () => {
    const parts = buildFixtureParts();
    const d = buildRunDescriptor(buildInput(parts));
    const root = tempRoot();
    materialize(root, parts, d);
    writeFileSync(
      join(root, RUN_PATHS.mutationPre),
      stablePretty({ ...MUTATION_PRE, tracked_file_count: 9 }),
    );
    assert.throws(() => verifyPreparedArtifacts(root, d), /hash mismatch|mutation/i);
  });

  test("fails on path traversal in descriptor paths", () => {
    const parts = buildFixtureParts();
    const d = buildRunDescriptor(buildInput(parts));
    const root = tempRoot();
    materialize(root, parts, d);
    const evil = structuredClone(d);
    evil.paths.artifact_manifest = "../outside.json";
    delete evil.descriptor_sha256;
    // validate rejects before verify
    assert.throws(() => validateRunDescriptor(evil), RunDescriptorError);
    assert.throws(() => verifyPreparedArtifacts(root, evil), RunDescriptorError);
  });
});

describe("listExplorerPayloadFiles", () => {
  test("returns frozen expected/found/missing; ignores noise; rejects expected symlink", () => {
    const parts = buildFixtureParts();
    const d = buildRunDescriptor(buildInput(parts));
    const root = tempRoot();
    materialize(root, parts, d);
    const inv0 = listExplorerPayloadFiles(root, d);
    assert.ok(Object.isFrozen(inv0));
    assert.ok(Object.isFrozen(inv0.expected));
    assert.equal(inv0.found.length, 0);
    assert.deepEqual(inv0.missing, inv0.expected);
    assert.ok(inv0.expected.length >= 1);

    const exp0 = explorerPayloadPath(parts.chunk_index.chunks[0].chunk_key);
    writeFileSync(join(root, exp0), "{}", { mode: 0o600 });
    writeFileSync(join(root, RUN_PATHS.explorerPayloads, "noise.json"), "{}", { mode: 0o600 });
    const inv1 = listExplorerPayloadFiles(root, d);
    assert.deepEqual(inv1.found, [exp0]);
    assert.ok(!inv1.found.some((p) => p.includes("noise")));
    assert.equal(inv1.missing.length, inv1.expected.length - 1);

    // expected path as symlink → reject
    rmSync(join(root, exp0));
    const outs = tempRoot("rd-pl-");
    writeFileSync(join(outs, "x"), "{}");
    symlinkSync(join(outs, "x"), join(root, exp0));
    assert.throws(() => listExplorerPayloadFiles(root, d), /symlink/i);
  });
});

describe("facade exports", () => {
  test("public API surface from run-descriptor.mjs", () => {
    assert.equal(typeof buildRunDescriptor, "function");
    assert.equal(typeof validateRunDescriptor, "function");
    assert.equal(typeof writeRunDescriptor, "function");
    assert.equal(typeof loadRunDescriptor, "function");
    assert.equal(typeof verifyPreparedArtifacts, "function");
    assert.equal(typeof listExplorerPayloadFiles, "function");
    assert.equal(typeof explorerPayloadPath, "function");
    assert.equal(RUN_PATHS.descriptor, "run-descriptor.json");
    assert.equal(new RunDescriptorError("x").name, "RunDescriptorError");
  });
});

describe("manual QA probe", () => {
  test("full seam: write/load/verify + adversarial classes", () => {
    const parts = buildFixtureParts();
    const d = buildRunDescriptor(buildInput(parts));
    const root = tempRoot();
    materialize(root, parts, d);
    const loaded = loadRunDescriptor(root);
    verifyPreparedArtifacts(root, loaded);

    // stale chunk
    rmSync(join(root, chunkArtifactPath(parts.chunk_index.chunks[0].chunk_key)));
    assert.throws(() => verifyPreparedArtifacts(root, loaded), RunDescriptorError);

    // malformed
    assert.throws(() => buildRunDescriptor(null), RunDescriptorError);
    assert.throws(() => validateRunDescriptor({}), RunDescriptorError);

    // locale-stable
    const a = buildRunDescriptor(buildInput(parts));
    const b = buildRunDescriptor(buildInput(parts));
    assert.equal(a.descriptor_sha256, b.descriptor_sha256);
  });
});
