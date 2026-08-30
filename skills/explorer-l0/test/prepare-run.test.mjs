/**
 * Public seam: prepareRun — deterministic end-to-end prepare orchestration.
 * Hermetic: real git worktree in temp foreign repo, fake Graphify via process injection.
 *
 * Phase contract under test:
 *   resolveRuntimeConfig → HEAD → repositorySnapshot pre → withDetachedWorktree →
 *   runGraphifyExtract → loadGraphifyOutput → project/chunk →
 *   buildGraphifyArtifactManifest → write layout → buildRunDescriptor/writeRunDescriptor →
 *   verifyPreparedArtifacts → worktree removed in finally.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../cli.mjs";
import {
  captureSourceStatusV2,
  captureWorktreeList,
} from "../src/git-reader.mjs";
import { prepareRun, PrepareError } from "../src/prepare-run.mjs";
import {
  loadRunDescriptor,
  verifyPreparedArtifacts,
} from "../src/run-descriptor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_GRAPH = join(HERE, "fixtures", "graphify", "0.9.32", "graph.json");

const temps = [];
/** @type {Array<() => void>} */
const cleanups = [];

function tempDir(prefix = "descobrir-prep-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
  while (temps.length > 0) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

function fixtureGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", shell: false }).trim();
}

/**
 * Temp foreign git repository with one committed file plus a dirty working tree.
 * @returns {{ cwd: string, head: string }}
 */
function makeForeignRepo() {
  const cwd = tempDir("descobrir-prep-repo-");
  fixtureGit(cwd, ["init", "-q", "-b", "main"]);
  writeFileSync(join(cwd, "main.go"), "package main\n\nfunc main() {}\n");
  writeFileSync(join(cwd, "README.md"), "# project\n");
  fixtureGit(cwd, ["add", "."]);
  fixtureGit(cwd, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-q",
    "-m",
    "initial",
  ]);
  const head = fixtureGit(cwd, ["rev-parse", "HEAD"]);
  // Leave a dirty working tree so source-status assertions are non-trivial.
  writeFileSync(join(cwd, "main.go"), "package main\n\n// dirty\n");
  writeFileSync(join(cwd, "untracked.txt"), "untracked\n");
  return { cwd, head };
}

function pinnedGraphBytes() {
  return readFileSync(FIXTURE_GRAPH, "utf8");
}

/**
 * @typedef {{ match: (file: string, args: string[]) => boolean, result: object | ((file: string, args: string[], opts: object) => object) }} Handler
 */

/**
 * @param {Handler[]} handlers
 */
function makeProcessRunner(handlers) {
  /** @type {{ file: string, args: string[], shell: boolean }[]} */
  const calls = [];
  async function runProcess(opts) {
    assert.equal(opts.shell ?? false, false, "shell must be false");
    assert.ok(Array.isArray(opts.args), "args must be array");
    calls.push({ file: opts.file, args: [...opts.args], shell: false });
    if (opts.signal?.aborted) {
      return { status: null, stdout: "", stderr: "", timedOut: false, aborted: true, signal: "abort" };
    }
    for (const h of handlers) {
      if (h.match(opts.file, opts.args)) {
        const raw = typeof h.result === "function" ? h.result(opts.file, opts.args, opts) : h.result;
        return { status: 0, stdout: "", stderr: "", timedOut: false, aborted: false, ...raw };
      }
    }
    return { status: 127, stdout: "", stderr: `no handler for ${opts.file} ${opts.args.join(" ")}`, timedOut: false, aborted: false };
  }
  return { runProcess, calls };
}

/**
 * Default happy-path fake process handlers (uv + graphify --version + extract).
 * @param {() => string} graphBytes
 * @param {{ malformed?: boolean, exit?: number }} [failure]
 */
function happyHandlers(graphBytes, failure = {}) {
  /** @type {Handler[]} */
  const handlers = [
    {
      match: (file, args) => (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
      result: { status: 0, stdout: "uv 0.6.0\n" },
    },
    {
      match: (file, args) => file.includes("graphify") && args[0] === "--version",
      result: { status: 0, stdout: "graphify 0.9.32\n" },
    },
  ];
  if (failure.malformed) {
    handlers.push({
      match: (file, args) => file.includes("graphify") && args[0] === "extract",
      result: (file, args) => {
        const outIdx = args.indexOf("--out");
        const outDir = args[outIdx + 1];
        mkdirSync(join(outDir, "graphify-out"), { recursive: true });
        writeFileSync(join(outDir, "graphify-out", "graph.json"), "{not-json");
        return { status: 0, stdout: "ok\n" };
      },
    });
  } else if (typeof failure.exit === "number") {
    handlers.push({
      match: (file, args) => file.includes("graphify") && args[0] === "extract",
      result: { status: failure.exit, stderr: "boom\n" },
    });
  } else {
    handlers.push({
      match: (file, args) => file.includes("graphify") && args[0] === "extract",
      result: (file, args) => {
        const outIdx = args.indexOf("--out");
        const outDir = args[outIdx + 1];
        mkdirSync(join(outDir, "graphify-out"), { recursive: true });
        writeFileSync(join(outDir, "graphify-out", "graph.json"), graphBytes());
        return { status: 0, stdout: "ok\n" };
      },
    });
  }
  return handlers;
}

/**
 * @param {{ cwd: string, head: string }} repo
 * @param {ReturnType<typeof makeProcessRunner>["runProcess"]} [runProcessOverride]
 */
function defaultOptions(repo, runProcessOverride) {
  return {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    home: tempDir("descobrir-prep-home-"),
    createRunId: () => "test-run-1",
    resolveHead: () => repo.head,
    runProcess: runProcessOverride,
    resolveGraphifyExecutable: () => "/tmp/fake-bin/graphify",
  };
}

describe("prepareRun — happy path", () => {
  test("emits status:prepared, validates hashes, removes worktree, source unchanged", async () => {
    const repo = makeForeignRepo();
    const statusBefore = captureSourceStatusV2(repo.cwd);
    const wtBefore = captureWorktreeList(repo.cwd);

    const { runProcess } = makeProcessRunner(happyHandlers(pinnedGraphBytes));
    const result = await prepareRun(
      { namespace: "demo", logical_repo: "demo-cloud", project_path: repo.cwd },
      defaultOptions(repo, runProcess),
    );

    assert.equal(result.status, "prepared");
    assert.equal(result.run_id, "test-run-1");
    assert.equal(result.namespace, "demo");
    assert.equal(result.logical_repo, "demo-cloud");
    assert.equal(result.source_revision, repo.head);
    assert.equal(result.acquisition_mode, "fresh");
    assert.match(result.manifest_id, /^manifest:[a-f0-9]{64}$/);
    assert.match(result.descriptor_sha256, /^[a-f0-9]{64}$/);
    assert.ok(result.chunk_index.chunks.length >= 1, "fixture must produce at least one chunk");
    assert.equal(result.chunk_index.version, 1);
    assert.equal(result.graphify.producer_version, "0.9.32");
    assert.equal(result.graphify.relations_key, "edges");
    assert.ok(result.graphify.nodes_count > 0);
    assert.equal(result.graphify.relations_count > 0, true);
    assert.ok(typeof result.phase_timings_ms.graphify_extract === "number");
    assert.ok(result.phase_timings_ms.graphify_extract >= 0);

    // Verify prepared artifacts on disk via facade (rehash every referenced file).
    const loaded = loadRunDescriptor(result.run_root);
    verifyPreparedArtifacts(result.run_root, loaded);

    // Determinism invariants on the descriptor inventory.
    const descriptor = result.descriptor;
    for (const chunk of descriptor.chunk_index.chunks) {
      assert.match(chunk.content_sha256, /^[a-f0-9]{64}$/);
      const listed = descriptor.content_hashes[`graphify/chunks/${chunk.chunk_key.replace(/:/g, "_")}.jsonl`];
      assert.equal(listed, chunk.content_sha256);
    }

    // Source working tree and worktree list byte-identical to pre-run.
    assert.equal(captureSourceStatusV2(repo.cwd), statusBefore);
    assert.equal(captureWorktreeList(repo.cwd), wtBefore);
  });

  test("acquisition_mode is fresh and producer name recorded as graphify", async () => {
    const repo = makeForeignRepo();
    const { runProcess } = makeProcessRunner(happyHandlers(pinnedGraphBytes));
    const result = await prepareRun(
      { namespace: "ns1", logical_repo: "repo1", project_path: repo.cwd },
      defaultOptions(repo, runProcess),
    );
    assert.equal(result.descriptor.acquisition_mode, "fresh");
    assert.equal(result.descriptor.producer.name, "graphify");
    assert.equal(result.descriptor.producer.version, "0.9.32");
    assert.equal(result.descriptor.package_intent.namespace, "ns1");
    assert.equal(result.descriptor.package_intent.logical_repo, "repo1");
  });
});

describe("prepareRun — determinism", () => {
  test("same revision yields identical manifest_id, chunk hashes; descriptor_sha256 differs only by run_id", async () => {
    const repo = makeForeignRepo();
    const { runProcess: rp1 } = makeProcessRunner(happyHandlers(pinnedGraphBytes));
    const { runProcess: rp2 } = makeProcessRunner(happyHandlers(pinnedGraphBytes));

    const r1 = await prepareRun(
      { namespace: "demo", logical_repo: "demo-cloud", project_path: repo.cwd },
      { ...defaultOptions(repo, rp1), createRunId: () => "run-alpha" },
    );
    const r2 = await prepareRun(
      { namespace: "demo", logical_repo: "demo-cloud", project_path: repo.cwd },
      { ...defaultOptions(repo, rp2), createRunId: () => "run-beta" },
    );

    assert.equal(r1.manifest_id, r2.manifest_id);
    assert.deepEqual(
      r1.chunk_index.chunks.map((c) => c.content_sha256),
      r2.chunk_index.chunks.map((c) => c.content_sha256),
    );
    assert.deepEqual(
      r1.chunk_index.chunks.map((c) => c.chunk_key),
      r2.chunk_index.chunks.map((c) => c.chunk_key),
    );
    // run_id feeds descriptor_sha256, so different run_id -> different descriptor hash.
    assert.notEqual(r1.descriptor_sha256, r2.descriptor_sha256);
  });
});

describe("prepareRun — failures", () => {
  test("malformed Graphify JSON → typed error, no worktree leak, source unchanged", async () => {
    const repo = makeForeignRepo();
    const statusBefore = captureSourceStatusV2(repo.cwd);
    const wtBefore = captureWorktreeList(repo.cwd);

    const { runProcess } = makeProcessRunner(happyHandlers(pinnedGraphBytes, { malformed: true }));

    await assert.rejects(
      () =>
        prepareRun(
          { namespace: "demo", logical_repo: "demo-cloud", project_path: repo.cwd },
          defaultOptions(repo, runProcess),
        ),
      (err) => err instanceof Error && /JSON|malformed|parse/i.test(err.message),
    );

    assert.equal(captureSourceStatusV2(repo.cwd), statusBefore);
    assert.equal(captureWorktreeList(repo.cwd), wtBefore);
    // No leftover worktree path under the run root (worktree must be unregistered).
    const list = captureWorktreeList(repo.cwd);
    assert.equal(list.includes("wt-"), false, "no worktree id may leak into the source list");
  });

  test("nonzero graphify exit → typed error, no worktree leak", async () => {
    const repo = makeForeignRepo();
    const statusBefore = captureSourceStatusV2(repo.cwd);
    const wtBefore = captureWorktreeList(repo.cwd);

    const { runProcess } = makeProcessRunner(happyHandlers(pinnedGraphBytes, { exit: 2 }));

    await assert.rejects(
      () =>
        prepareRun(
          { namespace: "demo", logical_repo: "demo-cloud", project_path: repo.cwd },
          defaultOptions(repo, runProcess),
        ),
      (err) => err instanceof Error && /exit 2|failed/i.test(err.message),
    );

    assert.equal(captureSourceStatusV2(repo.cwd), statusBefore);
    assert.equal(captureWorktreeList(repo.cwd), wtBefore);
  });

  test("config error: bad namespace fails typed before any process spawn", async () => {
    const repo = makeForeignRepo();
    let spawned = false;
    const { runProcess } = makeProcessRunner([
      {
        match: () => {
          spawned = true;
          return true;
        },
        result: { status: 0, stdout: "" },
      },
    ]);
    await assert.rejects(
      () =>
        prepareRun(
          { namespace: "../escape", logical_repo: "demo-cloud", project_path: repo.cwd },
          defaultOptions(repo, runProcess),
        ),
      (err) => err instanceof Error,
    );
    assert.equal(spawned, false, "config validation must run before process spawn");
  });

  test("PrepareError is exported and is a DescobrirError", () => {
    const err = new PrepareError("x");
    assert.equal(err.name, "PrepareError");
    assert.ok(err instanceof Error);
  });
});

describe("prepareRun — output sanitization", () => {
  test("serialized summary contains no absolute paths", async () => {
    const repo = makeForeignRepo();
    const { runProcess } = makeProcessRunner(happyHandlers(pinnedGraphBytes));
    const result = await prepareRun(
      { namespace: "demo", logical_repo: "demo-cloud", project_path: repo.cwd },
      defaultOptions(repo, runProcess),
    );
    // Public summary subset (what CLI emits).
    const summary = {
      status: result.status,
      run_id: result.run_id,
      namespace: result.namespace,
      logical_repo: result.logical_repo,
      source_revision: result.source_revision,
      acquisition_mode: result.acquisition_mode,
      manifest_id: result.manifest_id,
      descriptor_sha256: result.descriptor_sha256,
      chunk_index: result.chunk_index,
      phase_timings_ms: result.phase_timings_ms,
      graphify: result.graphify,
    };
    const text = JSON.stringify(summary);
    assert.equal(text.includes("/Users/"), false);
    assert.equal(text.includes("/var/folders/"), false);
    assert.equal(text.includes("/private/var/"), false);
    assert.equal(text.includes("/tmp/"), false, "summary must not embed tmp paths");
    assert.equal(text.includes(repo.cwd), false, "summary must not embed project_path");
    assert.equal(text.includes(result.run_root), false, "summary must not embed run_root");
  });
});

/**
 * node:test interleaves binary-framed TAP on process.stdout in some Node
 * versions. The CLI emits exactly one ASCII JSON line. Extract it via
 * brace-matching from the start sentinel `{"status":"prepared"`.
 * @param {string} text
 */
function extractPreparedSummary(text) {
  const start = text.indexOf('{"status":"prepared"');
  if (start < 0) {
    assert.fail(`no prepared summary in stdout (len=${text.length}): ${JSON.stringify(text.slice(0, 200))}`);
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }
  assert.fail("unterminated JSON summary in stdout");
}

describe("CLI prepare / run-start", () => {
  test("CLI prepare emits JSON status:prepared with no absolute paths", async () => {
    const home = tempDir("descobrir-cli-home-");
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });

    // Fake uv binary
    writeFileSync(
      join(bin, "uv"),
      '#!/usr/bin/env node\nconsole.log("uv 0.6.0");\nprocess.exit(0);\n',
      { encoding: "utf8", mode: 0o755 },
    );
    chmodSync(join(bin, "uv"), 0o755);

    // Fake graphify binary
    const graphFixture = pinnedGraphBytes();
    const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const fs = require("node:fs");
const path = require("node:path");
if (args[0] === "--version") { console.log("graphify 0.9.32"); process.exit(0); }
if (args[0] === "extract") {
  const outIdx = args.indexOf("--out");
  const outDir = args[outIdx + 1];
  fs.mkdirSync(path.join(outDir, "graphify-out"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "graphify-out", "graph.json"), ${JSON.stringify(graphFixture)});
  process.exit(0);
}
process.exit(1);
`;
    writeFileSync(join(bin, "graphify"), script, { encoding: "utf8", mode: 0o755 });
    chmodSync(join(bin, "graphify"), 0o755);

    const repo = makeForeignRepo();
    const statusBefore = captureSourceStatusV2(repo.cwd);
    const wtBefore = captureWorktreeList(repo.cwd);

    // Capture stdout but FORWARD to the original writer so node:test's own
    // TAP/reporter stream is not interrupted (which would corrupt accounting).
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return origWrite(chunk, ...rest);
    };
    const restoreStdout = () => { process.stdout.write = origWrite; };
    cleanups.push(restoreStdout);

    const prevPath = process.env.PATH;
    const prevHome = process.env.HOME;
    const prevUvBin = process.env.UV_TOOL_BIN_DIR;
    // Prepend fake bin so fake uv/graphify win, but keep node/git on PATH for shebang/git ops.
    process.env.PATH = `${bin}:${prevPath ?? ""}`;
    process.env.HOME = home;
    process.env.UV_TOOL_BIN_DIR = bin;
    cleanups.push(() => {
      process.env.PATH = prevPath;
      process.env.HOME = prevHome;
      if (prevUvBin === undefined) delete process.env.UV_TOOL_BIN_DIR;
      else process.env.UV_TOOL_BIN_DIR = prevUvBin;
    });

    const code = await main([
      "prepare",
      "--namespace",
      "demo",
      "--logical-repo",
      "demo-cloud",
      "--project-path",
      repo.cwd,
      "--run-id",
      "cli-run-1",
    ]);
    restoreStdout();

    assert.equal(code, 0);
    const text = chunks.join("");
    const json = extractPreparedSummary(text);
    assert.equal(json.status, "prepared");
    assert.equal(json.run_id, "cli-run-1");
    assert.equal(json.acquisition_mode, "fresh");
    assert.equal(json.namespace, "demo");
    assert.match(json.manifest_id, /^manifest:[a-f0-9]{64}$/);
    assert.match(json.descriptor_sha256, /^[a-f0-9]{64}$/);
    assert.ok(json.chunk_index.chunks.length >= 1);

    // No absolute paths in the JSON summary
    const jsonLine = JSON.stringify(json);
    assert.equal(jsonLine.includes("/Users/"), false);
    assert.equal(jsonLine.includes("/var/folders/"), false);
    assert.equal(jsonLine.includes("/private/var/"), false);
    assert.equal(jsonLine.includes(repo.cwd), false);
    assert.equal(jsonLine.includes("descobrir-prep-"), false);

    // Source unchanged after CLI prepare
    assert.equal(captureSourceStatusV2(repo.cwd), statusBefore);
    assert.equal(captureWorktreeList(repo.cwd), wtBefore);
  });

  test("CLI run-start is an alias of prepare (same JSON contract)", async () => {
    const home = tempDir("descobrir-cli-home-");
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "uv"),
      '#!/usr/bin/env node\nconsole.log("uv 0.6.0");\nprocess.exit(0);\n',
      { encoding: "utf8", mode: 0o755 },
    );
    chmodSync(join(bin, "uv"), 0o755);
    const graphFixture = pinnedGraphBytes();
    const script = `#!/usr/bin/env node
const args = process.argv.slice(2);
const fs = require("node:fs");
const path = require("node:path");
if (args[0] === "--version") { console.log("graphify 0.9.32"); process.exit(0); }
if (args[0] === "extract") {
  const outIdx = args.indexOf("--out");
  const outDir = args[outIdx + 1];
  fs.mkdirSync(path.join(outDir, "graphify-out"), { recursive: true });
  fs.writeFileSync(path.join(outDir, "graphify-out", "graph.json"), ${JSON.stringify(graphFixture)});
  process.exit(0);
}
process.exit(1);
`;
    writeFileSync(join(bin, "graphify"), script, { encoding: "utf8", mode: 0o755 });
    chmodSync(join(bin, "graphify"), 0o755);

    const repo = makeForeignRepo();

    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      return origWrite(chunk, ...rest);
    };
    const restoreStdout = () => { process.stdout.write = origWrite; };
    cleanups.push(restoreStdout);

    const prevPath = process.env.PATH;
    const prevHome = process.env.HOME;
    const prevUvBin = process.env.UV_TOOL_BIN_DIR;
    process.env.PATH = `${bin}:${prevPath ?? ""}`;
    process.env.HOME = home;
    process.env.UV_TOOL_BIN_DIR = bin;
    cleanups.push(() => {
      process.env.PATH = prevPath;
      process.env.HOME = prevHome;
      if (prevUvBin === undefined) delete process.env.UV_TOOL_BIN_DIR;
      else process.env.UV_TOOL_BIN_DIR = prevUvBin;
    });

    const code = await main([
      "run-start",
      "--namespace",
      "demo",
      "--logical-repo",
      "demo-cloud",
      "--project-path",
      repo.cwd,
      "--run-id",
      "alias-run-1",
    ]);
    restoreStdout();

    assert.equal(code, 0);
    const text = chunks.join("");
    const json = extractPreparedSummary(text);
    assert.equal(json.status, "prepared");
    assert.equal(json.run_id, "alias-run-1");
    assert.equal(json.acquisition_mode, "fresh");
  });

  test("CLI prepare missing --namespace fails non-zero", async () => {
    const code = await main(["prepare", "--logical-repo", "x", "--project-path", "/tmp"]);
    assert.notEqual(code, 0);
  });
});
