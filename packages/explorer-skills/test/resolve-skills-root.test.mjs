import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveSkillsRoot } from "../src/resolve-skills-root.mjs";

describe("resolveSkillsRoot", () => {
  test("finds monorepo skills from package src", () => {
    const root = resolveSkillsRoot();
    assert.ok(existsSync(join(root, "explorer-l0", "install.mjs")));
    assert.ok(existsSync(join(root, "explorer-query", "SKILL.md")));
  });
});
