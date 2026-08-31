import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { openOpsStore } from "../src/store.mjs";

describe("ops journal", () => {
  test("log + list + challenges roundtrip", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-"));
    const store = openOpsStore(join(dir, "ops.sqlite"));
    try {
      const { run_id } = store.log({
        phase: "finalize",
        status: "blocked",
        namespace: "uai",
        logical_repos: ["uai-auth"],
        detail: { blockers: 2 },
        challenges: [
          {
            code: "missing_payload",
            detail: "c:0000.json vs c_0000.json",
            how_we_attacked: "emit-payloads",
          },
        ],
      });
      assert.ok(run_id.startsWith("ops-"));
      const runs = store.listRuns({ namespace: "uai" });
      assert.equal(runs.length, 1);
      assert.equal(runs[0].phase, "finalize");
      const ch = store.listChallenges({ code: "missing_payload" });
      assert.equal(ch.length, 1);
      assert.equal(ch[0].how_we_attacked, "emit-payloads");
    } finally {
      store.close();
    }
  });
});
