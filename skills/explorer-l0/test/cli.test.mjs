import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { main } from "../cli.mjs";
import { canonicalizeCandidatePackage } from "../src/candidate-package.mjs";
import { coverageDraftInputs, explorerDraft } from "./fixtures.mjs";

const temps = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "descobrir-cli-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

describe("descobrir CLI", () => {
  test("persist-candidate → accept → export round-trip", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "store.sqlite");
    const draftPath = join(dir, "draft.json");
    const outPath = join(dir, "export.json");

    const draft = explorerDraft({
      coverage_report: coverageDraftInputs(),
    });
    const expected = canonicalizeCandidatePackage(draft);
    writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");

    const persistCode = await main([
      "persist-candidate",
      "--db",
      dbPath,
      "--input",
      draftPath,
    ]);
    assert.equal(persistCode, 0);

    const acceptCode = await main([
      "accept",
      "--db",
      dbPath,
      "--namespace",
      expected.namespace,
      "--logical-repo",
      expected.logical_repo,
      "--graph-hash",
      expected.graph_index.canonical_graph_hash,
      "--approver",
      "Marley",
    ]);
    assert.equal(acceptCode, 0);

    const exportCode = await main([
      "export",
      "--db",
      dbPath,
      "--namespace",
      expected.namespace,
      "--logical-repo",
      expected.logical_repo,
      "--accepted",
      "--output",
      outPath,
    ]);
    assert.equal(exportCode, 0);
    const exported = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(
      exported.graph_index.canonical_graph_hash,
      expected.graph_index.canonical_graph_hash,
    );
  });

  test("accept without approver fails with non-zero exit", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "store.sqlite");
    const draftPath = join(dir, "draft.json");
    const draft = explorerDraft({
      coverage_report: coverageDraftInputs(),
    });
    const expected = canonicalizeCandidatePackage(draft);
    writeFileSync(draftPath, `${JSON.stringify(draft)}\n`, "utf8");
    await main(["persist-candidate", "--db", dbPath, "--input", draftPath]);
    const code = await main([
      "accept",
      "--db",
      dbPath,
      "--namespace",
      expected.namespace,
      "--logical-repo",
      expected.logical_repo,
      "--graph-hash",
      expected.graph_index.canonical_graph_hash,
    ]);
    assert.notEqual(code, 0);
  });

  test("unknown command fails", async () => {
    const code = await main(["nope"]);
    assert.notEqual(code, 0);
  });

  test("project-obsidian writes deterministic Markdown from the accepted baseline", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "store.sqlite");
    const draftPath = join(dir, "draft.json");
    const outDir = join(dir, "projection");

    const draft = explorerDraft({ coverage_report: coverageDraftInputs() });
    const expected = canonicalizeCandidatePackage(draft);
    writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");

    await main(["persist-candidate", "--db", dbPath, "--input", draftPath]);
    await main([
      "accept",
      "--db",
      dbPath,
      "--namespace",
      expected.namespace,
      "--logical-repo",
      expected.logical_repo,
      "--graph-hash",
      expected.graph_index.canonical_graph_hash,
      "--approver",
      "Marley",
    ]);

    const code = await main([
      "project-obsidian",
      "--db",
      dbPath,
      "--namespace",
      expected.namespace,
      "--logical-repo",
      expected.logical_repo,
      "--out",
      outDir,
    ]);
    assert.equal(code, 0);
    assert.ok(existsSync(join(outDir, "README.md")), "README.md must exist");
    const readme = readFileSync(join(outDir, "README.md"), "utf8");
    assert.ok(readme.includes(expected.graph_index.canonical_graph_hash));
    assert.ok(/read_only: true/.test(readme));
    assert.ok(/READ-ONLY/.test(readme));
    // No absolute paths leaked into generated Markdown.
    assert.equal(readme.includes(dir), false);
  });

  test("project-obsidian exits non-zero when no accepted baseline exists", async () => {
    const dir = tempDir();
    const dbPath = join(dir, "store.sqlite");
    const outDir = join(dir, "projection");
    // Fresh store, no acceptance performed.
    const code = await main([
      "project-obsidian",
      "--db",
      dbPath,
      "--namespace",
      "ghost",
      "--logical-repo",
      "ghost-repo",
      "--out",
      outDir,
    ]);
    assert.notEqual(code, 0);
    assert.equal(existsSync(outDir), false, "no projection should be written on failure");
  });
});
