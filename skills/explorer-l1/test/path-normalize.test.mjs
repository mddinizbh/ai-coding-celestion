import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  contractKey,
  normalizeHttpPath,
  normalizeMethod,
} from "../src/path-normalize.mjs";

describe("normalizeHttpPath", () => {
  test("normalizes spring and kotlin templates to same contract", () => {
    const a = normalizeHttpPath(
      "/api/debits/{state}/category/{category}/renavam/{renavam}",
    );
    const b = normalizeHttpPath(
      "/api/debits/${state.name}/category/${category.name}/renavam/$renavam",
    );
    const c = normalizeHttpPath(
      "https://controller.example/api/debits/{state}/category/{category}/renavam/{renavam}",
    );
    assert.equal(a, b);
    assert.equal(a, "/api/debits/{param}/category/{param}/renavam/{param}");
    assert.equal(c, a);
  });

  test("contractKey includes method", () => {
    assert.equal(
      contractKey("get", "/api/debits/{x}"),
      "GET /api/debits/{param}",
    );
    assert.equal(normalizeMethod("post"), "POST");
  });
});
