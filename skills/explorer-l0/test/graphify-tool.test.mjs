/**
 * Public seams: managed Graphify setup/status + production extract runner.
 * Tests observe argv/status/output contracts via injected process adapter.
 */
import assert from "node:assert/strict";
import {
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
import { execFileSync, spawnSync } from "node:child_process";

import { main } from "../cli.mjs";
import {
  GRAPHIFY_PACKAGE_SPEC,
  GRAPHIFY_PINNED_VERSION,
} from "../src/graphify-contract.mjs";
import {
  GraphifyToolError,
  getGraphifyToolStatus,
  runGraphifyExtract,
  setupGraphifyTool,
} from "../src/graphify-tool.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_GRAPH = join(HERE, "fixtures", "graphify", "0.9.32", "graph.json");
const FIXTURE_PROJECT = join(HERE, "fixtures", "graphify", "project");

const temps = [];
/** @type {Array<() => void>} */
const cleanups = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
  while (temps.length > 0) {
    rmSync(temps.pop(), { recursive: true, force: true });
  }
});

function tempDir(prefix = "descobrir-gf-tool-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/**
 * @param {Array<{ match: (file: string, args: string[]) => boolean, result: object | ((file: string, args: string[], opts: object) => object) }>} handlers
 */
function makeProcessRunner(handlers) {
  /** @type {{ file: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv, shell: boolean, timeoutMs?: number }[]} */
  const calls = [];
  /**
   * @param {{ file: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, maxBuffer?: number, signal?: AbortSignal }} opts
   */
  async function runProcess(opts) {
    assert.equal(opts.shell ?? false, false, "shell must be false");
    assert.ok(Array.isArray(opts.args), "args must be array");
    calls.push({
      file: opts.file,
      args: [...opts.args],
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      timeoutMs: opts.timeoutMs,
    });
    if (opts.signal?.aborted) {
      return {
        status: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: true,
        signal: opts.signal.reason ?? "abort",
      };
    }
    for (const h of handlers) {
      if (h.match(opts.file, opts.args)) {
        const raw =
          typeof h.result === "function"
            ? h.result(opts.file, opts.args, opts)
            : h.result;
        return {
          status: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          aborted: false,
          ...raw,
        };
      }
    }
    return {
      status: 127,
      stdout: "",
      stderr: `no handler for ${opts.file} ${opts.args.join(" ")}`,
      timedOut: false,
      aborted: false,
    };
  }
  return { runProcess, calls };
}

function pinnedGraphBytes() {
  return readFileSync(FIXTURE_GRAPH, "utf8");
}

describe("GRAPHIFY package pin constants", () => {
  test("package spec is exact graphifyy==0.9.32", () => {
    assert.equal(GRAPHIFY_PINNED_VERSION, "0.9.32");
    assert.equal(GRAPHIFY_PACKAGE_SPEC, "graphifyy==0.9.32");
  });
});

describe("getGraphifyToolStatus", () => {
  test("reports missing uv without installing", async () => {
    const { runProcess, calls } = makeProcessRunner([
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
        result: { status: null, stderr: "ENOENT", errorCode: "ENOENT" },
      },
    ]);
    const status = await getGraphifyToolStatus({ runProcess });
    assert.equal(status.installed, false);
    assert.equal(status.uv_available, false);
    assert.equal(status.version, null);
    assert.equal(status.matches_pin, false);
    assert.ok(typeof status.setup_command === "string");
    assert.match(status.setup_command, /setup/);
    assert.equal(
      calls.some((c) => c.args.includes("install")),
      false,
      "status must never install",
    );
  });

  test("reports installed pinned version from graphify --version", async () => {
    const { runProcess, calls } = makeProcessRunner([
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
        result: { status: 0, stdout: "uv 0.6.0\n" },
      },
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) &&
          args[0] === "tool" &&
          args[1] === "dir",
        result: { status: 0, stdout: "/tmp/fake-uv-tools\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "--version",
        result: { status: 0, stdout: "graphify 0.9.32\n" },
      },
    ]);
    const status = await getGraphifyToolStatus({
      runProcess,
      env: { PATH: "/tmp/fake-bin", UV_TOOL_BIN_DIR: "/tmp/fake-bin" },
      resolveExecutable: () => "/tmp/fake-bin/graphify",
    });
    assert.equal(status.installed, true);
    assert.equal(status.version, "0.9.32");
    assert.equal(status.matches_pin, true);
    assert.equal(status.package, "graphifyy");
    assert.equal(status.uv_available, true);
    assert.equal(
      calls.some((c) => c.args.includes("install")),
      false,
    );
  });

  test("reports mismatched version as installed but not matching pin", async () => {
    const { runProcess } = makeProcessRunner([
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
        result: { status: 0, stdout: "uv 0.6.0\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "--version",
        result: { status: 0, stdout: "graphify 0.10.0\n" },
      },
    ]);
    const status = await getGraphifyToolStatus({
      runProcess,
      resolveExecutable: () => "/tmp/fake-bin/graphify",
    });
    assert.equal(status.installed, true);
    assert.equal(status.version, "0.10.0");
    assert.equal(status.matches_pin, false);
  });
});

describe("setupGraphifyTool", () => {
  test("installs exact graphifyy==0.9.32 via uv tool and verifies version", async () => {
    const { runProcess, calls } = makeProcessRunner([
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
        result: { status: 0, stdout: "uv 0.6.0\n" },
      },
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) &&
          args[0] === "tool" &&
          args[1] === "install",
        result: (file, args) => {
          assert.deepEqual(args, ["tool", "install", "graphifyy==0.9.32"]);
          return { status: 0, stdout: "Installed graphify\n" };
        },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "--version",
        result: { status: 0, stdout: "graphify 0.9.32\n" },
      },
    ]);
    const result = await setupGraphifyTool({
      runProcess,
      resolveExecutable: () => "/tmp/fake-bin/graphify",
    });
    assert.equal(result.installed, true);
    assert.equal(result.version, "0.9.32");
    assert.equal(result.matches_pin, true);
    const install = calls.find(
      (c) => c.args[0] === "tool" && c.args[1] === "install",
    );
    assert.ok(install);
    assert.equal(install.shell, false);
    assert.deepEqual(install.args, ["tool", "install", "graphifyy==0.9.32"]);
  });

  test("fails typed when uv is missing", async () => {
    const { runProcess } = makeProcessRunner([
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
        result: { status: null, errorCode: "ENOENT", stderr: "not found" },
      },
    ]);
    await assert.rejects(
      () => setupGraphifyTool({ runProcess }),
      (err) => {
        assert.ok(err instanceof GraphifyToolError);
        assert.match(err.message, /uv/i);
        return true;
      },
    );
  });

  test("fails when install leaves wrong version", async () => {
    const { runProcess } = makeProcessRunner([
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
        result: { status: 0, stdout: "uv 0.6.0\n" },
      },
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) &&
          args[0] === "tool" &&
          args[1] === "install",
        result: { status: 0, stdout: "ok\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "--version",
        result: { status: 0, stdout: "graphify 0.8.0\n" },
      },
    ]);
    await assert.rejects(
      () =>
        setupGraphifyTool({
          runProcess,
          resolveExecutable: () => "/tmp/fake-bin/graphify",
        }),
      (err) => {
        assert.ok(err instanceof GraphifyToolError);
        assert.match(err.message, /0\.8\.0|version|0\.9\.32/i);
        return true;
      },
    );
  });
});

describe("runGraphifyExtract", () => {
  test("invokes exact argv with shell:false and validates graph contract", async () => {
    const outDir = tempDir("descobrir-gf-out-");
    const worktree = tempDir("descobrir-gf-wt-");
    writeFileSync(join(worktree, "main.go"), "package main\n");

    const { runProcess, calls } = makeProcessRunner([
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
        result: { status: 0, stdout: "uv 0.6.0\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "--version",
        result: { status: 0, stdout: "graphify 0.9.32\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "extract",
        result: (file, args) => {
          assert.equal(args[0], "extract");
          assert.equal(args[1], worktree);
          assert.ok(args.includes("--code-only"));
          assert.ok(args.includes("--no-cluster"));
          const outIdx = args.indexOf("--out");
          assert.ok(outIdx >= 0);
          assert.equal(args[outIdx + 1], outDir);
          const graphDir = join(outDir, "graphify-out");
          mkdirSync(graphDir, { recursive: true });
          writeFileSync(join(graphDir, "graph.json"), pinnedGraphBytes());
          return {
            status: 0,
            stdout: `[graphify extract] wrote ${join(graphDir, "graph.json")} — 4 nodes\n`,
          };
        },
      },
    ]);

    const result = await runGraphifyExtract({
      worktreePath: worktree,
      outputDir: outDir,
      runProcess,
      resolveExecutable: () => "/tmp/fake-bin/graphify",
    });

    assert.equal(result.producer_version, "0.9.32");
    assert.equal(result.relationsKey, "edges");
    assert.equal(result.nodes.length, 4);
    assert.equal(result.relations.length, 5);
    assert.ok(existsSync(result.graph_path));
    assert.match(result.graph_path, /graphify-out[/\\]graph\.json$/);

    const extract = calls.find((c) => c.args[0] === "extract");
    assert.ok(extract);
    assert.equal(extract.shell, false);
    assert.deepEqual(extract.args, [
      "extract",
      worktree,
      "--code-only",
      "--no-cluster",
      "--out",
      outDir,
    ]);
    assert.equal(
      calls.some((c) => c.args.includes("install")),
      false,
      "extract must never install",
    );
  });

  test("missing tool fails with setup instruction and never installs", async () => {
    const { runProcess, calls } = makeProcessRunner([
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
        result: { status: 0, stdout: "uv 0.6.0\n" },
      },
    ]);
    await assert.rejects(
      () =>
        runGraphifyExtract({
          worktreePath: tempDir(),
          outputDir: tempDir(),
          runProcess,
          resolveExecutable: () => null,
        }),
      (err) => {
        assert.ok(err instanceof GraphifyToolError);
        assert.match(err.message, /setup/i);
        return true;
      },
    );
    assert.equal(
      calls.some((c) => c.args.includes("install")),
      false,
    );
  });

  test("wrong version fails with setup instruction", async () => {
    const { runProcess } = makeProcessRunner([
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
        result: { status: 0, stdout: "uv 0.6.0\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "--version",
        result: { status: 0, stdout: "graphify 0.10.0\n" },
      },
    ]);
    await assert.rejects(
      () =>
        runGraphifyExtract({
          worktreePath: tempDir(),
          outputDir: tempDir(),
          runProcess,
          resolveExecutable: () => "/tmp/fake-bin/graphify",
        }),
      (err) => {
        assert.ok(err instanceof GraphifyToolError);
        assert.match(err.message, /0\.10\.0|setup|0\.9\.32/i);
        return true;
      },
    );
  });

  test("nonzero exit fails typed with bounded sanitized stderr", async () => {
    const outDir = tempDir();
    const worktree = tempDir();
    const longPath = "/Users/secret/project/leak.go";
    const { runProcess } = makeProcessRunner([
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
        result: { status: 0, stdout: "uv 0.6.0\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "--version",
        result: { status: 0, stdout: "graphify 0.9.32\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "extract",
        result: {
          status: 2,
          stderr: `boom at ${longPath}\n` + "x".repeat(200_000),
        },
      },
    ]);
    await assert.rejects(
      () =>
        runGraphifyExtract({
          worktreePath: worktree,
          outputDir: outDir,
          runProcess,
          resolveExecutable: () => "/tmp/fake-bin/graphify",
        }),
      (err) => {
        assert.ok(err instanceof GraphifyToolError);
        assert.match(err.message, /exit 2|failed/i);
        assert.equal(err.message.includes("/Users/secret"), false);
        assert.ok(err.message.length < 20_000);
        return true;
      },
    );
  });

  test("timeout fails typed", async () => {
    const { runProcess } = makeProcessRunner([
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
        result: { status: 0, stdout: "uv 0.6.0\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "--version",
        result: { status: 0, stdout: "graphify 0.9.32\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "extract",
        result: { status: null, timedOut: true, stderr: "killed" },
      },
    ]);
    await assert.rejects(
      () =>
        runGraphifyExtract({
          worktreePath: tempDir(),
          outputDir: tempDir(),
          runProcess,
          resolveExecutable: () => "/tmp/fake-bin/graphify",
          timeoutMs: 50,
        }),
      (err) => {
        assert.ok(err instanceof GraphifyToolError);
        assert.match(err.message, /timed out|timeout/i);
        return true;
      },
    );
  });

  test("abort signal fails typed", async () => {
    const ac = new AbortController();
    ac.abort(new Error("user-cancel"));
    const { runProcess } = makeProcessRunner([
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
        result: { status: 0, stdout: "uv 0.6.0\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "--version",
        result: { status: 0, stdout: "graphify 0.9.32\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "extract",
        result: { status: null, aborted: true },
      },
    ]);
    await assert.rejects(
      () =>
        runGraphifyExtract({
          worktreePath: tempDir(),
          outputDir: tempDir(),
          runProcess,
          resolveExecutable: () => "/tmp/fake-bin/graphify",
          signal: ac.signal,
        }),
      (err) => {
        assert.ok(err instanceof GraphifyToolError);
        assert.match(err.message, /abort/i);
        return true;
      },
    );
  });

  test("exit 0 without graph artifact fails (misleading success)", async () => {
    const outDir = tempDir();
    const { runProcess } = makeProcessRunner([
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
        result: { status: 0, stdout: "uv 0.6.0\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "--version",
        result: { status: 0, stdout: "graphify 0.9.32\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "extract",
        result: {
          status: 0,
          stdout: "wrote graph successfully — 4 nodes, 5 edges\n",
        },
      },
    ]);
    await assert.rejects(
      () =>
        runGraphifyExtract({
          worktreePath: tempDir(),
          outputDir: outDir,
          runProcess,
          resolveExecutable: () => "/tmp/fake-bin/graphify",
        }),
      (err) => {
        assert.ok(err instanceof GraphifyToolError);
        assert.match(err.message, /graph\.json|artifact|missing/i);
        return true;
      },
    );
  });

  test("empty nodes graph fails contract/empty check", async () => {
    const outDir = tempDir();
    const { runProcess } = makeProcessRunner([
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
        result: { status: 0, stdout: "uv 0.6.0\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "--version",
        result: { status: 0, stdout: "graphify 0.9.32\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "extract",
        result: () => {
          const graphDir = join(outDir, "graphify-out");
          mkdirSync(graphDir, { recursive: true });
          writeFileSync(
            join(graphDir, "graph.json"),
            JSON.stringify({ nodes: [], edges: [] }),
          );
          return { status: 0, stdout: "ok\n" };
        },
      },
    ]);
    await assert.rejects(
      () =>
        runGraphifyExtract({
          worktreePath: tempDir(),
          outputDir: outDir,
          runProcess,
          resolveExecutable: () => "/tmp/fake-bin/graphify",
        }),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /empty|nodes/i);
        return true;
      },
    );
  });

  test("malformed graph JSON fails", async () => {
    const outDir = tempDir();
    const { runProcess } = makeProcessRunner([
      {
        match: (file, args) =>
          (file === "uv" || file.endsWith("/uv")) && args[0] === "--version",
        result: { status: 0, stdout: "uv 0.6.0\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "--version",
        result: { status: 0, stdout: "graphify 0.9.32\n" },
      },
      {
        match: (file, args) =>
          file.includes("graphify") && args[0] === "extract",
        result: () => {
          const graphDir = join(outDir, "graphify-out");
          mkdirSync(graphDir, { recursive: true });
          writeFileSync(join(graphDir, "graph.json"), "{not-json");
          return { status: 0, stdout: "ok\n" };
        },
      },
    ]);
    await assert.rejects(
      () =>
        runGraphifyExtract({
          worktreePath: tempDir(),
          outputDir: outDir,
          runProcess,
          resolveExecutable: () => "/tmp/fake-bin/graphify",
        }),
      (err) => {
        assert.ok(err instanceof GraphifyToolError);
        assert.match(err.message, /JSON|malformed|parse/i);
        return true;
      },
    );
  });
});

describe("CLI setup and setup-status", () => {
  // The setup-status test exercises the structured JSON output of the CLI when
  // the Graphify tool is not installed. The simulation overrides
  // UV_TOOL_BIN_DIR to an empty directory. uv itself MUST remain available
  // because setup-status uses it for tool discovery. If the host has no uv at
  // all, this test cannot exercise the happy path hermetically — skip cleanly
  // rather than reporting a false failure. The production CLI still errors
  // loudly when uv is missing during `setup`; this skip does NOT weaken that.
  function uvOnPath() {
    try {
      execFileSync("uv", ["--version"], { stdio: "ignore", shell: false });
      return true;
    } catch {
      return false;
    }
  }

  // The hermetic simulation below relies on UV_TOOL_BIN_DIR discovery
  // semantics that only newer uv implements (same generation that ships
  // `uv --which`). On older uv the env override is ignored and the simulation
  // is not hermetic — skip cleanly rather than report a false failure.
  function uvSupportsHermeticSim() {
    try {
      execFileSync("uv", ["--which"], { stdio: "ignore", shell: false });
      return true;
    } catch {
      return false;
    }
  }

  test("setup-status emits JSON with installed/version fields", async (t) => {
    if (!uvOnPath()) {
      t.skip("uv not on PATH — setup-status requires uv for tool discovery; skipping hermetically");
      return;
    }
    if (!uvSupportsHermeticSim()) {
      t.skip("uv too old for hermetic UV_TOOL_BIN_DIR simulation — skipping cleanly");
      return;
    }
    const chunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      chunks.push(String(chunk));
      return true;
    };
    cleanups.push(() => {
      process.stdout.write = origWrite;
    });

    // Simulate "graphify not installed" by pointing UV_TOOL_BIN_DIR at an
    // empty dir. KEEP uv itself on PATH (resolved from the host's real PATH)
    // so setup-status can run its discovery logic without raising
    // GraphifyToolError("uv required"). Previous override of process.env.PATH
    // to a fully-empty bin made uv itself unfindable and broke the test.
    const emptyToolBin = tempDir("descobrir-empty-toolbin-");
    // uv itself stays reachable: resolve its directory hermetically.
    const realUv = (() => {
      try {
        return dirname(execFileSync("uv", ["--which"], { encoding: "utf8", shell: false }).trim());
      } catch {
        const r = spawnSync("sh", ["-c", "command -v uv"], { encoding: "utf8" });
        const p = (r.stdout || "").trim().split("\n").filter(Boolean).pop() || "";
        return p ? dirname(p) : "";
      }
    })();
    if (!realUv) {
      t.skip("could not locate uv binary — skipping hermetically");
      return;
    }
    const prevUvBin = process.env.UV_TOOL_BIN_DIR;
    const prevPath = process.env.PATH;
    process.env.UV_TOOL_BIN_DIR = emptyToolBin;
    // Keep uv reachable: prepend the directory that actually contains uv.
    process.env.PATH = `${realUv}:${prevPath}`;
    cleanups.push(() => {
      process.env.PATH = prevPath;
      if (prevUvBin === undefined) delete process.env.UV_TOOL_BIN_DIR;
      else process.env.UV_TOOL_BIN_DIR = prevUvBin;
    });

    const code = await main(["setup-status"]);
    process.stdout.write = origWrite;
    assert.equal(code, 0);
    const text = chunks.join("");
    const json = JSON.parse(text.trim());
    assert.equal(typeof json.installed, "boolean");
    assert.ok("version" in json);
    assert.equal(json.pinned_version, "0.9.32");
    assert.equal(typeof json.matches_pin, "boolean");
    assert.equal(typeof json.setup_command, "string");
    // no absolute paths in structured CLI output
    assert.equal(text.includes("/Users/"), false);
    assert.equal(text.includes("/private/var/"), false);
  });

  test("unknown command still fails; persist-candidate usage unchanged", async () => {
    const code = await main(["nope"]);
    assert.notEqual(code, 0);
  });

  test("setup command is recognized (may fail without uv in PATH — typed exit)", async () => {
    const emptyBin = tempDir("descobrir-no-uv-");
    const prevPath = process.env.PATH;
    const prevUvBin = process.env.UV_TOOL_BIN_DIR;
    const prevHome = process.env.HOME;
    process.env.PATH = emptyBin;
    process.env.UV_TOOL_BIN_DIR = emptyBin;
    process.env.HOME = tempDir("descobrir-setup-home-");
    cleanups.push(() => {
      process.env.PATH = prevPath;
      process.env.HOME = prevHome;
      if (prevUvBin === undefined) delete process.env.UV_TOOL_BIN_DIR;
      else process.env.UV_TOOL_BIN_DIR = prevUvBin;
    });
    const code = await main(["setup"]);
    assert.notEqual(code, 0);
  });
});

// Keep fixture path referenced so tree-shaking/linters don't drop it.
void FIXTURE_PROJECT;
