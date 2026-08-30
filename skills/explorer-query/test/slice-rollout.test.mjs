import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { main } from "../cli.mjs";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSliceStore } from "../src/slice-store.mjs";

describe("slice rollout flag", () => {
  it("answer without --use-slice-cache keeps legacy path and creates no system DB", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "slice-rollout-"));
    try {
      const edges = join(tmp, "edges.json");
      const systemDb = join(tmp, "system.sqlite");
      writeFileSync(edges, JSON.stringify({ edges: [] }));
      const code = await main(["answer", "--system-namespace", "test", "--edges", edges, "--system-db", systemDb]);
      assert.equal(code, 0);
      assert.equal(existsSync(systemDb), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("answer without --use-slice-cache remains legacy after a slice DB already exists", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "slice-rollout-"));
    try {
      const edges = join(tmp, "edges.json");
      const systemDb = join(tmp, "system.sqlite");
      writeFileSync(edges, JSON.stringify({ edges: [] }));
      openSliceStore(systemDb).close();
      assert.equal(existsSync(systemDb), true);
      const code = await main(["answer", "--system-namespace", "test", "--edges", edges, "--system-db", systemDb]);
      assert.equal(code, 0);
      assert.equal(existsSync(systemDb), true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
