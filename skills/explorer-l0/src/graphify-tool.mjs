/**
 * Managed Graphify tool setup and production extract runner.
 * Explicit setup installs graphifyy==0.9.32 via `uv tool`; status/run never install.
 * Child processes: argv arrays, shell:false, timeout, AbortSignal, bounded I/O.
 */

import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

import {
  GRAPHIFY_PACKAGE_SPEC,
  GRAPHIFY_PINNED_VERSION,
  GraphifyContractError,
  assertGraphifyExtractionContract,
} from "./graphify-contract.mjs";
import { GraphifyToolError } from "./errors.mjs";

export { GraphifyToolError };
export { GRAPHIFY_PACKAGE_SPEC, GRAPHIFY_PINNED_VERSION };

export const GRAPHIFY_SETUP_COMMAND =
  "node skills/descobrir/cli.mjs setup";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const LOG_CAP = 8 * 1024;
const VERSION_RE = /(\d+\.\d+\.\d+)/;

/**
 * @param {string} message
 * @param {{ cause?: unknown, code?: string }} [options]
 * @returns {never}
 */
function fail(message, options = {}) {
  throw new GraphifyToolError(sanitizeProcessText(message), options);
}

/**
 * Strip absolute paths and bound length for logs/errors.
 * @param {unknown} text
 * @param {number} [max]
 */
export function sanitizeProcessText(text, max = LOG_CAP) {
  const raw = typeof text === "string" ? text : String(text ?? "");
  const scrubbed = raw
    .replace(/\/Users\/[^\s:'"]+/g, "<path>")
    .replace(/\/home\/[^\s:'"]+/g, "<path>")
    .replace(/\/private\/var\/[^\s:'"]+/g, "<path>")
    .replace(/\/var\/folders\/[^\s:'"]+/g, "<path>")
    .replace(/[A-Za-z]:\\[^\s:'"]+/g, "<path>");
  if (scrubbed.length <= max) return scrubbed;
  return `${scrubbed.slice(0, max)}…`;
}

/**
 * @typedef {object} ProcessRunResult
 * @property {number | null} status
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {boolean} aborted
 * @property {string} [errorCode]
 * @property {unknown} [signal]
 */

/**
 * @typedef {object} RunProcessOptions
 * @property {string} file
 * @property {string[]} args
 * @property {string} [cwd]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {number} [timeoutMs]
 * @property {number} [maxBuffer]
 * @property {AbortSignal} [signal]
 * @property {boolean} [shell]
 */

/**
 * Default process runner: argv array, shell:false, timeout, AbortSignal, maxBuffer.
 * @param {RunProcessOptions} opts
 * @returns {Promise<ProcessRunResult>}
 */
export function defaultRunProcess(opts) {
  if (opts.shell === true) {
    return Promise.reject(new GraphifyToolError("shell execution is forbidden"));
  }
  if (typeof opts.file !== "string" || opts.file === "") {
    return Promise.reject(new GraphifyToolError("process file is required"));
  }
  if (!Array.isArray(opts.args)) {
    return Promise.reject(new GraphifyToolError("process args must be an array"));
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const env = opts.env ?? process.env;
  const cwd = opts.cwd;

  return new Promise((resolvePromise) => {
    if (opts.signal?.aborted) {
      resolvePromise({
        status: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        aborted: true,
        signal: opts.signal.reason,
      });
      return;
    }

    /** @type {Buffer[]} */
    const outChunks = [];
    /** @type {Buffer[]} */
    const errChunks = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(opts.file, opts.args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(result);
    };

    const onAbort = () => {
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 1000).unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 1000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    if (opts.signal) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const cleanup = () => {
      clearTimeout(timer);
      if (opts.signal) {
        opts.signal.removeEventListener("abort", onAbort);
      }
    };

    const pushBounded = (/** @type {Buffer[]} */ chunks, /** @type {number} */ len, chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (len >= maxBuffer) return len;
      const room = maxBuffer - len;
      chunks.push(buf.length > room ? buf.subarray(0, room) : buf);
      return len + Math.min(buf.length, room);
    };

    child.stdout?.on("data", (chunk) => {
      outLen = pushBounded(outChunks, outLen, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      errLen = pushBounded(errChunks, errLen, chunk);
    });

    child.on("error", (err) => {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      finish({
        status: null,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: sanitizeProcessText(
          Buffer.concat(errChunks).toString("utf8") || err.message,
        ),
        timedOut: false,
        aborted: false,
        errorCode: typeof code === "string" ? code : undefined,
      });
    });

    child.on("close", (code, signal) => {
      finish({
        status: typeof code === "number" ? code : null,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        timedOut,
        aborted,
        signal: signal ?? undefined,
      });
    });
  });
}

/**
 * @param {NodeJS.ProcessEnv | undefined} env
 * @returns {string[]}
 */
function pathDirs(env = process.env) {
  const pathVal = env.PATH ?? env.Path ?? "";
  return pathVal.split(delimiter).filter(Boolean);
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
/**
 * Windows resolves executables by extension (PATHEXT). A bare `name` never
 * exists on disk there, so expand it into the concrete candidates.
 * @param {string} name
 * @returns {string[]}
 */
function executableNames(name) {
  if (process.platform !== "win32") return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
}

 function findOnPath(name, env = process.env) {
   for (const dir of pathDirs(env)) {
     for (const exeName of executableNames(name)) {
       const candidate = join(dir, exeName);
       try {
         accessSync(candidate, fsConstants.X_OK);
         return candidate;
       } catch {
         // continue
       }
     }
   }
   return null;
 }

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolveUvBin(env = process.env) {
  if (typeof env.UV_BIN === "string" && env.UV_BIN !== "") {
    return env.UV_BIN;
  }
  return findOnPath("uv", env) ?? "uv";
}

/**
 * Locate graphify executable without installing.
 * Prefers UV_TOOL_BIN_DIR, then PATH.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function defaultResolveGraphifyExecutable(env = process.env) {
  const candidates = [];
  if (typeof env.UV_TOOL_BIN_DIR === "string" && env.UV_TOOL_BIN_DIR !== "") {
    for (const exeName of executableNames("graphify")) {
      candidates.push(join(env.UV_TOOL_BIN_DIR, exeName));
    }
  }
  const home = env.HOME || env.USERPROFILE || homedir();
  if (home) {
    for (const exeName of executableNames("graphify")) {
      candidates.push(join(home, ".local", "bin", exeName));
    }
  }
  const fromPath = findOnPath("graphify", env);
  if (fromPath) candidates.push(fromPath);

  for (const c of candidates) {
    try {
      if (existsSync(c)) {
        accessSync(c, fsConstants.X_OK);
        return realpathSync(c);
      }
    } catch {
      // continue
    }
  }
  return null;
}

/**
 * @param {string} text
 * @returns {string | null}
 */
export function parseGraphifyVersion(text) {
  if (typeof text !== "string" || text === "") return null;
  // Prefer "graphify X.Y.Z" then any semver.
  const labeled = text.match(/graphify\s+(\d+\.\d+\.\d+)/i);
  if (labeled) return labeled[1];
  const m = text.match(VERSION_RE);
  return m ? m[1] : null;
}

/**
 * @typedef {object} GraphifyToolStatus
 * @property {boolean} installed
 * @property {string | null} version
 * @property {boolean} matches_pin
 * @property {string} pinned_version
 * @property {string} package
 * @property {boolean} uv_available
 * @property {string} setup_command
 */

/**
 * @param {{
 *   runProcess?: typeof defaultRunProcess,
 *   env?: NodeJS.ProcessEnv,
 *   resolveExecutable?: (env?: NodeJS.ProcessEnv) => string | null,
 *   uvBin?: string,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {Promise<GraphifyToolStatus>}
 */
export async function getGraphifyToolStatus(options = {}) {
  const runProcess = options.runProcess ?? defaultRunProcess;
  const env = options.env ?? process.env;
  const resolveExecutable =
    options.resolveExecutable ?? defaultResolveGraphifyExecutable;
  const uvBin = options.uvBin ?? resolveUvBin(env);
  const timeoutMs = options.timeoutMs ?? 15_000;

  let uvAvailable = false;
  const uvCheck = await runProcess({
    file: uvBin,
    args: ["--version"],
    env,
    timeoutMs,
    shell: false,
  });
  if (uvCheck.errorCode === "ENOENT") {
    uvAvailable = false;
  } else if (uvCheck.status === 0) {
    uvAvailable = true;
  } else if (!uvCheck.timedOut && !uvCheck.aborted && uvCheck.status !== null) {
    // uv exists but odd exit — still treat as available if stdout looks like uv
    uvAvailable = /uv/i.test(uvCheck.stdout);
  }

  const exe = resolveExecutable(env);
  if (!exe) {
    return {
      installed: false,
      version: null,
      matches_pin: false,
      pinned_version: GRAPHIFY_PINNED_VERSION,
      package: "graphifyy",
      uv_available: uvAvailable,
      setup_command: GRAPHIFY_SETUP_COMMAND,
    };
  }

  const ver = await runProcess({
    file: exe,
    args: ["--version"],
    env,
    timeoutMs,
    shell: false,
  });
  if (ver.errorCode === "ENOENT" || ver.status !== 0) {
    return {
      installed: false,
      version: null,
      matches_pin: false,
      pinned_version: GRAPHIFY_PINNED_VERSION,
      package: "graphifyy",
      uv_available: uvAvailable,
      setup_command: GRAPHIFY_SETUP_COMMAND,
    };
  }

  const version = parseGraphifyVersion(ver.stdout) ?? parseGraphifyVersion(ver.stderr);
  const matches = version === GRAPHIFY_PINNED_VERSION;
  return {
    installed: version !== null,
    version,
    matches_pin: matches,
    pinned_version: GRAPHIFY_PINNED_VERSION,
    package: "graphifyy",
    uv_available: uvAvailable,
    setup_command: GRAPHIFY_SETUP_COMMAND,
  };
}

/**
 * Explicit setup only: verify uv, install graphifyy==0.9.32, verify version.
 * @param {{
 *   runProcess?: typeof defaultRunProcess,
 *   env?: NodeJS.ProcessEnv,
 *   resolveExecutable?: (env?: NodeJS.ProcessEnv) => string | null,
 *   uvBin?: string,
 *   timeoutMs?: number,
 * }} [options]
 * @returns {Promise<GraphifyToolStatus>}
 */
export async function setupGraphifyTool(options = {}) {
  const runProcess = options.runProcess ?? defaultRunProcess;
  const env = options.env ?? process.env;
  const resolveExecutable =
    options.resolveExecutable ?? defaultResolveGraphifyExecutable;
  const uvBin = options.uvBin ?? resolveUvBin(env);
  const timeoutMs = options.timeoutMs ?? 300_000;

  const uvCheck = await runProcess({
    file: uvBin,
    args: ["--version"],
    env,
    timeoutMs: 15_000,
    shell: false,
  });
  if (
    uvCheck.errorCode === "ENOENT" ||
    (uvCheck.status !== 0 && !/uv/i.test(uvCheck.stdout))
  ) {
    fail(
      "uv is required for Graphify setup but was not found on PATH. Install uv, then re-run setup.",
      { code: "UV_MISSING" },
    );
  }

  const install = await runProcess({
    file: uvBin,
    args: ["tool", "install", GRAPHIFY_PACKAGE_SPEC],
    env,
    timeoutMs,
    shell: false,
  });
  if (install.timedOut) {
    fail(`uv tool install timed out (timeoutMs=${timeoutMs})`, {
      code: "SETUP_TIMEOUT",
    });
  }
  if (install.aborted) {
    fail("uv tool install aborted", { code: "SETUP_ABORTED" });
  }
  if (install.status !== 0) {
    fail(
      `uv tool install ${GRAPHIFY_PACKAGE_SPEC} failed (exit ${install.status}): ${sanitizeProcessText(install.stderr || install.stdout)}`,
      { code: "SETUP_INSTALL_FAILED" },
    );
  }

  // Re-resolve after install (bin dir may be new).
  const exe = resolveExecutable(env);
  if (!exe) {
    fail(
      `Graphify executable not found after installing ${GRAPHIFY_PACKAGE_SPEC}. Ensure UV_TOOL_BIN_DIR is on PATH.`,
      { code: "SETUP_BINARY_MISSING" },
    );
  }

  const ver = await runProcess({
    file: exe,
    args: ["--version"],
    env,
    timeoutMs: 15_000,
    shell: false,
  });
  if (ver.status !== 0) {
    fail(
      `graphify --version failed after setup (exit ${ver.status}): ${sanitizeProcessText(ver.stderr || ver.stdout)}`,
      { code: "SETUP_VERSION_FAILED" },
    );
  }
  const version = parseGraphifyVersion(ver.stdout) ?? parseGraphifyVersion(ver.stderr);
  if (version !== GRAPHIFY_PINNED_VERSION) {
    fail(
      `Graphify version mismatch after setup: got "${version ?? "unknown"}", require ${GRAPHIFY_PINNED_VERSION}. Re-run ${GRAPHIFY_SETUP_COMMAND}.`,
      { code: "SETUP_VERSION_MISMATCH" },
    );
  }

  return {
    installed: true,
    version,
    matches_pin: true,
    pinned_version: GRAPHIFY_PINNED_VERSION,
    package: "graphifyy",
    uv_available: true,
    setup_command: GRAPHIFY_SETUP_COMMAND,
  };
}

/**
 * Discover graph.json from graphifyy 0.9.32 --out layout.
 * Layout: `<out>/graphify-out/graph.json`
 * @param {string} outputDir
 * @returns {string | null}
 */
export function discoverGraphifyGraphPath(outputDir) {
  if (typeof outputDir !== "string" || outputDir === "" || !isAbsolute(outputDir)) {
    return null;
  }
  const primary = join(resolve(outputDir), "graphify-out", "graph.json");
  if (existsSync(primary)) return primary;
  const alt = join(resolve(outputDir), "graph.json");
  if (existsSync(alt)) return alt;
  return null;
}

/**
 * Production extract: never installs. Requires pinned tool.
 *
 * @param {{
 *   worktreePath: string,
 *   outputDir: string,
 *   runProcess?: typeof defaultRunProcess,
 *   env?: NodeJS.ProcessEnv,
 *   resolveExecutable?: (env?: NodeJS.ProcessEnv) => string | null,
 *   uvBin?: string,
 *   timeoutMs?: number,
 *   maxBuffer?: number,
 *   signal?: AbortSignal,
 * }} options
 */
export async function runGraphifyExtract(options) {
  const worktreePath = options.worktreePath;
  const outputDir = options.outputDir;
  if (typeof worktreePath !== "string" || worktreePath === "" || !isAbsolute(worktreePath)) {
    fail("worktreePath must be an absolute path");
  }
  if (typeof outputDir !== "string" || outputDir === "" || !isAbsolute(outputDir)) {
    fail("outputDir must be an absolute path");
  }

  const runProcess = options.runProcess ?? defaultRunProcess;
  const env = options.env ?? process.env;
  const resolveExecutable =
    options.resolveExecutable ?? defaultResolveGraphifyExecutable;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;

  if (options.signal?.aborted) {
    fail("graphify extract aborted", {
      code: "EXTRACT_ABORTED",
      cause: options.signal.reason,
    });
  }

  const status = await getGraphifyToolStatus({
    runProcess,
    env,
    resolveExecutable,
    uvBin: options.uvBin,
    timeoutMs: 15_000,
  });

  if (!status.uv_available) {
    fail(
      `uv is required but was not found. Install uv, then run: ${GRAPHIFY_SETUP_COMMAND}`,
      { code: "UV_MISSING" },
    );
  }
  if (!status.installed || !status.matches_pin) {
    const got = status.version ?? "missing";
    fail(
      `Graphify tool not ready (version=${got}, require ${GRAPHIFY_PINNED_VERSION}). Run: ${GRAPHIFY_SETUP_COMMAND}`,
      { code: "TOOL_NOT_READY" },
    );
  }

  const exe = resolveExecutable(env);
  if (!exe) {
    fail(
      `Graphify executable missing. Run: ${GRAPHIFY_SETUP_COMMAND}`,
      { code: "TOOL_NOT_READY" },
    );
  }

  const args = [
    "extract",
    worktreePath,
    "--code-only",
    "--no-cluster",
    "--out",
    outputDir,
  ];

  const result = await runProcess({
    file: exe,
    args,
    env,
    cwd: worktreePath,
    timeoutMs,
    maxBuffer,
    signal: options.signal,
    shell: false,
  });

  if (result.aborted || options.signal?.aborted) {
    fail("graphify extract aborted", { code: "EXTRACT_ABORTED" });
  }
  if (result.timedOut) {
    fail(`graphify extract timed out (timeoutMs=${timeoutMs})`, {
      code: "EXTRACT_TIMEOUT",
    });
  }
  if (result.errorCode === "ENOENT") {
    fail(
      `Graphify executable not found. Run: ${GRAPHIFY_SETUP_COMMAND}`,
      { code: "TOOL_NOT_READY" },
    );
  }
  if (result.status !== 0) {
    fail(
      `graphify extract failed (exit ${result.status}): ${sanitizeProcessText(result.stderr || result.stdout)}`,
      { code: "EXTRACT_EXIT" },
    );
  }

  const graphPath = discoverGraphifyGraphPath(outputDir);
  if (!graphPath) {
    fail(
      "graphify extract exited 0 but graph.json artifact is missing under output (expected graphify-out/graph.json)",
      { code: "EXTRACT_MISSING_ARTIFACT" },
    );
  }

  let graph;
  try {
    const raw = readFileSync(graphPath, "utf8");
    graph = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`graphify graph.json is malformed JSON: ${sanitizeProcessText(msg)}`, {
      code: "EXTRACT_MALFORMED_JSON",
      cause: err,
    });
  }

  let contract;
  try {
    contract = assertGraphifyExtractionContract(graph, {
      producerVersion: GRAPHIFY_PINNED_VERSION,
    });
  } catch (err) {
    if (err instanceof GraphifyContractError) {
      fail(err.message, { code: "EXTRACT_CONTRACT", cause: err });
    }
    throw err;
  }

  if (contract.nodes.length === 0) {
    fail("graphify extraction produced an empty nodes array", {
      code: "EXTRACT_EMPTY",
    });
  }

  return {
    producer_version: GRAPHIFY_PINNED_VERSION,
    package: "graphifyy",
    graph_path: graphPath,
    graph_file: basename(graphPath),
    nodes: contract.nodes,
    relationsKey: contract.relationsKey,
    relations: contract.relations,
    stdout: sanitizeProcessText(result.stdout),
    stderr: sanitizeProcessText(result.stderr),
  };
}
