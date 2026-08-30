import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  SliceError,
  SliceStoreError,
  SliceCollisionError,
  SliceDeterminismError,
  SliceMigrationError,
  SliceMaterializationError,
  exitCodeForError,
  sanitizeSliceErrorMessage,
} from "../src/slice-errors.mjs";

describe("slice-errors — class identity", () => {
  test("each class preserves name and is instanceof SliceError + Error", () => {
    const cases = [
      [SliceStoreError, "SliceStoreError"],
      [SliceCollisionError, "SliceCollisionError"],
      [SliceDeterminismError, "SliceDeterminismError"],
      [SliceMigrationError, "SliceMigrationError"],
      [SliceMaterializationError, "SliceMaterializationError"],
    ];
    for (const [Klass, expectedName] of cases) {
      const err = new Klass("boom");
      assert.equal(err.name, expectedName);
      assert.equal(err.message, "boom");
      assert.ok(err instanceof SliceError, `${expectedName} instanceof SliceError`);
      assert.ok(err instanceof Error, `${expectedName} instanceof Error`);
    }
  });

  test("base SliceError preserves name and forwards cause when provided", () => {
    const root = new Error("disk gone");
    const err = new SliceError("wrap", { cause: root });
    assert.equal(err.name, "SliceError");
    assert.equal(err.cause, root);
  });

  test("cause is omitted entirely when not provided (no cause: undefined)", () => {
    const err = new SliceStoreError("plain");
    assert.equal(err.cause, undefined);
    // message stays domain-only — no path/secret leakage
    assert.equal(err.message, "plain");
  });

  test("SliceMaterializationError carries optional code field", () => {
    const err = new SliceMaterializationError("ceiling hit", { code: "SAFETY_CEILING" });
    assert.equal(err.code, "SAFETY_CEILING");
  });
});

describe("slice-errors — exit code classification", () => {
  test("infra errors map to exit 1", () => {
    assert.equal(exitCodeForError(new SliceStoreError("store down")), 1);
    assert.equal(exitCodeForError(new SliceMigrationError("migrate fail")), 1);
  });

  test("semantic blockers map to exit 2", () => {
    assert.equal(exitCodeForError(new SliceCollisionError("same key divergent")), 2);
    assert.equal(exitCodeForError(new SliceDeterminismError("smuggled field")), 2);
    assert.equal(
      exitCodeForError(new SliceMaterializationError("missing baseline")),
      2,
    );
  });

  test("unknown Error maps to exit 1, never 0", () => {
    assert.equal(exitCodeForError(new Error("??")), 1);
    assert.equal(exitCodeForError(new TypeError("bad")), 1);
  });

  test("no slice error class ever returns exit 0", () => {
    for (const Klass of [
      SliceStoreError,
      SliceCollisionError,
      SliceDeterminismError,
      SliceMigrationError,
      SliceMaterializationError,
    ]) {
      assert.notEqual(exitCodeForError(new Klass("x")), 0);
    }
  });
});

describe("slice-errors — CLI sanitizer", () => {
  test("scrubs POSIX /Users path to <path>", () => {
    const err = new SliceStoreError("cannot open /Users/marley/foo/data.sqlite");
    const out = sanitizeSliceErrorMessage(err);
    assert.equal(out, "SliceStoreError: cannot open <path>");
    assert.equal(out.includes("/Users/marley"), false, "must not leak POSIX user path");
  });

  test("scrubs POSIX /home path to <path>", () => {
    const err = new SliceCollisionError("baseline at /home/runner/bar/x.json diverged");
    const out = sanitizeSliceErrorMessage(err);
    assert.equal(out, "SliceCollisionError: baseline at <path> diverged");
    assert.equal(out.includes("/home/runner"), false);
  });

  test("scrubs Windows drive path to <path>", () => {
    const err = new SliceDeterminismError("read C:\\repo\\baz\\out.txt smuggled");
    const out = sanitizeSliceErrorMessage(err);
    assert.equal(out, "SliceDeterminismError: read <path> smuggled");
    assert.equal(out.includes("C:\\repo"), false);
  });

  test("scrubs all three path formats in a single message", () => {
    const err = new SliceMaterializationError(
      "merge /Users/marley/foo + /home/runner/bar + C:\\repo\\baz failed",
    );
    const out = sanitizeSliceErrorMessage(err);
    assert.equal(
      out,
      "SliceMaterializationError: merge <path> + <path> + <path> failed",
    );
    assert.equal(out.includes("/Users/"), false);
    assert.equal(out.includes("/home/"), false);
    assert.equal(out.includes(":\\repo"), false);
  });

  test("non-Error input still produces a scrubbed line", () => {
    const out = sanitizeSliceErrorMessage("stray /Users/x/y string");
    assert.equal(out, "Error: stray <path> string");
  });
});
