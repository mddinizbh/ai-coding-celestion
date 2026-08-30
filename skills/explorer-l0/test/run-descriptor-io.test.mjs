/**
 * Seam: atomic 0600 write/load of run-descriptor.json.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { loadRunDescriptor, writeRunDescriptor } from "../src/run-descriptor-io.mjs";
import {
  RUN_PATHS,
  RunDescriptorError,
  buildRunDescriptor,
} from "../src/run-descriptor-shape.mjs";
import { stablePretty } from "../src/stable-json.mjs";
import { buildFixtureParts, buildInput } from "./run-descriptor-fixtures.mjs";

const temps = [];
function tempRoot(prefix = "rd-io-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

describe("writeRunDescriptor / loadRunDescriptor", () => {
  test("atomic 0600 round-trip", () => {
    const d = buildRunDescriptor(buildInput(buildFixtureParts()));
    const root = tempRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const written = writeRunDescriptor(root, d);
    assert.equal(written.descriptor_sha256, d.descriptor_sha256);
    assert.ok(Object.isFrozen(written));
    const abs = join(root, RUN_PATHS.descriptor);
    assert.ok(existsSync(abs));
    assert.equal(statSync(abs).mode & 0o777, 0o600);
    const loaded = loadRunDescriptor(root);
    assert.equal(loaded.descriptor_sha256, d.descriptor_sha256);
    assert.ok(Object.isFrozen(loaded));
  });

  test("load wraps errors without absolute path leak", () => {
    const root = tempRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    assert.throws(
      () => loadRunDescriptor(root),
      (err) => {
        assert.ok(err instanceof RunDescriptorError);
        assert.ok(!err.message.includes(root));
        assert.ok(!err.message.includes("/var/"));
        assert.ok(!err.message.includes("/private/"));
        return true;
      },
    );
    writeFileSync(join(root, RUN_PATHS.descriptor), "{not-json", { mode: 0o600 });
    assert.throws(
      () => loadRunDescriptor(root),
      (err) => err instanceof RunDescriptorError && !err.message.includes(root),
    );
  });

  test("repeated partial writes leave last valid descriptor; no tmp leftovers", () => {
    const parts = buildFixtureParts();
    const d1 = buildRunDescriptor(buildInput(parts, { run_id: "run1" }));
    const d2 = buildRunDescriptor(buildInput(parts, { run_id: "run2" }));
    const root = tempRoot();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeRunDescriptor(root, d1);
    writeRunDescriptor(root, d2);
    const loaded = loadRunDescriptor(root);
    assert.equal(loaded.run_id, "run2");
    assert.equal(loaded.descriptor_sha256, d2.descriptor_sha256);
    assert.ok(!readdirSync(root).some((n) => n.includes(".tmp") || n.startsWith(".run-descriptor.")));
  });

  test("rejects non-absolute run_root and invalid descriptor", () => {
    const d = buildRunDescriptor(buildInput());
    assert.throws(() => writeRunDescriptor("relative", d), RunDescriptorError);
    assert.throws(() => writeRunDescriptor("", d), RunDescriptorError);
    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    assert.throws(() => writeRunDescriptor(root, null), RunDescriptorError);
    assert.throws(() => writeRunDescriptor(root, { ...d, records: [] }), RunDescriptorError);
  });

  test("load rejects tampered self-hash", () => {
    const d = buildRunDescriptor(buildInput());
    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    writeRunDescriptor(root, d);
    const abs = join(root, RUN_PATHS.descriptor);
    const raw = JSON.parse(readFileSync(abs, "utf8"));
    raw.run_id = "tampered";
    writeFileSync(abs, `${JSON.stringify(raw)}\n`);
    assert.throws(() => loadRunDescriptor(root), RunDescriptorError);
  });

  test("load rejects escaping symlink descriptor without absolute path leak", () => {
    const d = buildRunDescriptor(buildInput());
    const root = tempRoot();
    const outside = tempRoot("rd-io-out-");
    mkdirSync(root, { recursive: true });
    const outsideFile = join(outside, "evil.json");
    writeFileSync(outsideFile, stablePretty(d), { mode: 0o600 });
    symlinkSync(outsideFile, join(root, RUN_PATHS.descriptor));
    assert.throws(
      () => loadRunDescriptor(root),
      (err) => {
        assert.ok(err instanceof RunDescriptorError);
        assert.match(err.message, /symlink|regular file/i);
        assert.ok(!err.message.includes(root));
        assert.ok(!err.message.includes(outside));
        assert.ok(!err.message.includes("/var/"));
        assert.ok(!err.message.includes("/private/"));
        return true;
      },
    );
  });

  test("load rejects internal symlink descriptor", () => {
    const d = buildRunDescriptor(buildInput());
    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    const real = join(root, "real-descriptor.json");
    writeFileSync(real, stablePretty(d), { mode: 0o600 });
    symlinkSync(real, join(root, RUN_PATHS.descriptor));
    assert.throws(
      () => loadRunDescriptor(root),
      (err) => err instanceof RunDescriptorError && /symlink|regular file/i.test(err.message),
    );
  });

  test("load rejects directory at descriptor path", () => {
    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, RUN_PATHS.descriptor));
    assert.throws(
      () => loadRunDescriptor(root),
      (err) => {
        assert.ok(err instanceof RunDescriptorError);
        assert.match(err.message, /regular file|directory|symlink/i);
        assert.ok(!err.message.includes(root));
        return true;
      },
    );
  });

  test("load accepts regular file descriptor only", () => {
    const d = buildRunDescriptor(buildInput());
    const root = tempRoot();
    mkdirSync(root, { recursive: true });
    writeRunDescriptor(root, d);
    const loaded = loadRunDescriptor(root);
    assert.equal(loaded.descriptor_sha256, d.descriptor_sha256);
    assert.equal(statSync(join(root, RUN_PATHS.descriptor)).isFile(), true);
  });
});
