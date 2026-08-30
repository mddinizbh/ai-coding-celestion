import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(mjs|js|md)$/.test(name)) out.push(p);
  }
  return out;
}

describe("skill isolation", () => {
  test("no source file imports from prototypes/**", () => {
    const files = walk(join(root, "src")).concat([join(root, "cli.mjs")]);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.equal(
        /prototypes\//.test(text),
        false,
        `${file} must not reference prototypes/`,
      );
      assert.equal(
        /from\s+['"][^'"]*prototypes/.test(text),
        false,
        `${file} must not import prototypes`,
      );
    }
  });
});
