import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, test } from "node:test";

// Seams under test (Todo 3): pure path/intent resolution vs directory creation.
import {
  RuntimeConfigError,
  resolveRuntimeConfig,
} from "../src/runtime-config.mjs";
import {
  RuntimeLayoutError,
  createRuntimeLayout,
} from "../src/runtime-layout.mjs";

const temps = [];

function tempRoot(prefix = "descobrir-rt-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    rmSync(dir, { recursive: true, force: true });
  }
});

const VALID_THRESHOLD = {
  minimum_repository_verified_percentage: 0,
  require_schema_valid: true,
  require_repeatability_pass: true,
  require_mutation_equivalent: true,
  require_producer_reconciliation_pass: true,
};

const PINNED_REV = "633d3a5d16c165073ede2b2248bae708483f2efe";

/**
 * @param {Partial<Parameters<typeof resolveRuntimeConfig>[0]>} overrides
 * @param {Parameters<typeof resolveRuntimeConfig>[1]} [options]
 */
function baseInput(overrides = {}, options = {}) {
  const home = tempRoot("descobrir-home-");
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  const input = {
    namespace: "demo",
    logical_repo: "demo-cloud",
    project_path: project,
    source_revision: PINNED_REV,
    ...overrides,
  };
  const opts = {
    env: {
      HOME: home,
      XDG_DATA_HOME: join(home, "xdg-data"),
      XDG_CACHE_HOME: join(home, "xdg-cache"),
    },
    home,
    ...options,
  };
  return { input, opts, home, project };
}

describe("resolveRuntimeConfig — defaults (pure, no FS writes)", () => {
  test("resolves namespace-isolated default DB under XDG_DATA_HOME", () => {
    const { input, opts, home } = baseInput();
    const cfg = resolveRuntimeConfig(input, opts);
    assert.equal(
      cfg.db_path,
      join(home, "xdg-data", "descobrir", "demo.sqlite"),
    );
    assert.equal(cfg.namespace, "demo");
    assert.equal(cfg.logical_repo, "demo-cloud");
    assert.equal(cfg.source_revision, PINNED_REV);
    // Pure resolution must not create the data directory.
    assert.equal(existsSync(join(home, "xdg-data", "descobrir")), false);
  });

  test("falls back to ~/.local/share and ~/.cache when XDG_* unset", () => {
    const home = tempRoot("descobrir-home-fallback-");
    const project = join(home, "proj");
    mkdirSync(project, { recursive: true });
    const cfg = resolveRuntimeConfig(
      {
        namespace: "alpha",
        logical_repo: "repo-a",
        project_path: project,
        source_revision: PINNED_REV,
      },
      {
        home,
        env: { HOME: home },
      },
    );
    assert.equal(cfg.db_path, join(home, ".local", "share", "descobrir", "alpha.sqlite"));
    assert.ok(cfg.run_root.startsWith(join(home, ".cache", "descobrir", "runs", sep)));
  });

  test("two namespaces resolve distinct DB paths without touching disk", () => {
    const { opts, home, project } = baseInput();
    const a = resolveRuntimeConfig(
      {
        namespace: "ns-a",
        logical_repo: "repo",
        project_path: project,
        source_revision: PINNED_REV,
      },
      opts,
    );
    const b = resolveRuntimeConfig(
      {
        namespace: "ns-b",
        logical_repo: "repo",
        project_path: project,
        source_revision: PINNED_REV,
      },
      opts,
    );
    assert.notEqual(a.db_path, b.db_path);
    assert.equal(a.db_path, join(home, "xdg-data", "descobrir", "ns-a.sqlite"));
    assert.equal(b.db_path, join(home, "xdg-data", "descobrir", "ns-b.sqlite"));
    assert.equal(existsSync(join(home, "xdg-data")), false);
  });

  test("run root lives under XDG_CACHE_HOME/descobrir/runs/<run-id>", () => {
    const { input, opts, home } = baseInput({}, { createRunId: () => "run-fixed-1" });
    const cfg = resolveRuntimeConfig(input, opts);
    assert.equal(cfg.run_id, "run-fixed-1");
    assert.equal(cfg.run_root, join(home, "xdg-cache", "descobrir", "runs", "run-fixed-1"));
  });

  test("accepts optional threshold and normalizes the five gate fields", () => {
    const { input, opts } = baseInput({ threshold: { ...VALID_THRESHOLD } });
    const cfg = resolveRuntimeConfig(input, opts);
    assert.deepEqual(cfg.threshold, VALID_THRESHOLD);
  });

  test("accepts optional absolute db override", () => {
    const { input, opts, home } = baseInput();
    input.db = join(home, "custom", "store.sqlite");
    const cfg = resolveRuntimeConfig(input, opts);
    assert.equal(cfg.db_path, resolve(home, "custom", "store.sqlite"));
  });

  test("accepts optional absolute obsidian_root", () => {
    const { input, opts, home } = baseInput();
    input.obsidian_root = join(home, "vault", "proj");
    const cfg = resolveRuntimeConfig(input, opts);
    assert.equal(cfg.obsidian_root, resolve(home, "vault", "proj"));
  });

  test("package_intent omits machine paths (project/db/run/obsidian)", () => {
    const { input, opts, home } = baseInput();
    input.db = join(home, "custom.sqlite");
    input.obsidian_root = join(home, "vault");
    input.threshold = { ...VALID_THRESHOLD };
    const cfg = resolveRuntimeConfig(input, opts);
    const intent = cfg.package_intent;
    assert.deepEqual(Object.keys(intent).sort(), [
      "logical_repo",
      "namespace",
      "source_revision",
      "threshold",
    ]);
    assert.equal(intent.namespace, "demo");
    assert.equal(intent.logical_repo, "demo-cloud");
    assert.equal(intent.source_revision, PINNED_REV);
    const blob = JSON.stringify(intent);
    assert.equal(blob.includes(home), false);
    assert.equal(blob.includes(cfg.db_path), false);
    assert.equal(blob.includes(cfg.project_path), false);
  });
});

describe("resolveRuntimeConfig — revision intent", () => {
  test("uses explicit source_revision when provided (no HEAD probe)", () => {
    let called = 0;
    const { input, opts } = baseInput(
      { source_revision: PINNED_REV },
      {
        resolveHead: () => {
          called += 1;
          return "deadbeef";
        },
      },
    );
    const cfg = resolveRuntimeConfig(input, opts);
    assert.equal(cfg.source_revision, PINNED_REV);
    assert.equal(called, 0);
  });

  test("defaults missing revision via injected resolveHead immediately", () => {
    const { input, opts } = baseInput(
      {},
      { resolveHead: (projectPath) => {
        assert.ok(typeof projectPath === "string" && projectPath.length > 0);
        return "abcdef1";
      } },
    );
    delete input.source_revision;
    const cfg = resolveRuntimeConfig(input, opts);
    assert.equal(cfg.source_revision, "abcdef1");
  });

  test("rejects dirty revision placeholder without resolving HEAD", () => {
    const { input, opts } = baseInput({ source_revision: "<HEAD>" });
    assert.throws(
      () => resolveRuntimeConfig(input, opts),
      (err) => err instanceof RuntimeConfigError && /placeholder|revision/i.test(err.message),
    );
  });

  test("rejects non-hex revision strings", () => {
    const { input, opts } = baseInput({ source_revision: "not-a-sha" });
    assert.throws(() => resolveRuntimeConfig(input, opts), RuntimeConfigError);
  });

  test("missing Git repo (resolveHead failure) yields typed error", () => {
    const { input, opts } = baseInput(
      {},
      {
        resolveHead: () => {
          throw new Error("not a git repository");
        },
      },
    );
    delete input.source_revision;
    assert.throws(
      () => resolveRuntimeConfig(input, opts),
      (err) => err instanceof RuntimeConfigError && /git|revision|repository/i.test(err.message),
    );
  });
});

/**
 * @param {string} dir
 * @param {string[]} args
 */
function git(dir, args) {
  const r = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    shell: false,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout || r.status}`);
  }
  return (r.stdout || "").trim();
}

/**
 * Temp Git repo with two commits; returns { repo, head }.
 * @returns {{ repo: string, head: string }}
 */
function makeTwoCommitRepo() {
  const repo = tempRoot("descobrir-git-");
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "descobrir-test@example.com"]);
  git(repo, ["config", "user.name", "Descobrir Test"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-m", "first"]);
  writeFileSync(join(repo, "b.txt"), "two\n");
  git(repo, ["add", "b.txt"]);
  git(repo, ["commit", "-m", "second"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  assert.match(head, /^[a-f0-9]{40}$/);
  return { repo, head };
}

describe("resolveRuntimeConfig — automatic Git HEAD (integration)", () => {
  test("omitted source_revision equals git rev-parse HEAD of project_path", () => {
    // Given a real Git repo with two commits
    // When resolveRuntimeConfig is called without source_revision and without resolveHead inject
    // Then source_revision is exactly the current HEAD SHA
    const { repo, head } = makeTwoCommitRepo();
    const home = tempRoot("descobrir-home-git-");
    const cfg = resolveRuntimeConfig(
      {
        namespace: "demo",
        logical_repo: "demo-cloud",
        project_path: repo,
        // source_revision intentionally omitted
      },
      {
        home,
        env: {
          HOME: home,
          XDG_DATA_HOME: join(home, "xdg-data"),
          XDG_CACHE_HOME: join(home, "xdg-cache"),
        },
        createRunId: () => "run-from-head",
      },
    );
    assert.equal(cfg.source_revision, head);
    assert.equal(cfg.package_intent.source_revision, head);
    // Pure resolution still creates no layout/DB.
    assert.equal(existsSync(join(home, "xdg-data")), false);
  });

  test("non-Git project_path fails typed before any layout/DB creation", () => {
    const home = tempRoot("descobrir-home-nongit-");
    const project = join(home, "not-a-repo");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "readme.txt"), "no git here\n");

    assert.throws(
      () =>
        resolveRuntimeConfig(
          {
            namespace: "demo",
            logical_repo: "demo-cloud",
            project_path: project,
          },
          {
            home,
            env: {
              HOME: home,
              XDG_DATA_HOME: join(home, "xdg-data"),
              XDG_CACHE_HOME: join(home, "xdg-cache"),
            },
            createRunId: () => "should-not-run",
          },
        ),
      (err) =>
        err instanceof RuntimeConfigError &&
        err.name === "RuntimeConfigError" &&
        /git|repository|revision/i.test(err.message) &&
        !/resolveHead is not provided/i.test(err.message),
    );

    assert.equal(existsSync(join(home, "xdg-data")), false);
    assert.equal(existsSync(join(home, "xdg-cache")), false);
    assert.equal(existsSync(join(home, "xdg-data", "descobrir", "demo.sqlite")), false);
  });

  test("explicit invalid revision still fails typed without calling layout", () => {
    const { repo } = makeTwoCommitRepo();
    const home = tempRoot("descobrir-home-badrev-");
    assert.throws(
      () =>
        resolveRuntimeConfig(
          {
            namespace: "demo",
            logical_repo: "demo-cloud",
            project_path: repo,
            source_revision: "not-a-sha",
          },
          {
            home,
            env: {
              HOME: home,
              XDG_DATA_HOME: join(home, "xdg-data"),
              XDG_CACHE_HOME: join(home, "xdg-cache"),
            },
          },
        ),
      RuntimeConfigError,
    );
    assert.equal(existsSync(join(home, "xdg-data")), false);
  });
});

describe("resolveRuntimeConfig — invalid / escaping identifiers", () => {
  test("rejects namespace with path traversal '../other' before any write", () => {
    const { input, opts, home } = baseInput({ namespace: "../other" });
    assert.throws(() => resolveRuntimeConfig(input, opts), RuntimeConfigError);
    assert.equal(existsSync(join(home, "xdg-data")), false);
  });

  test("rejects namespace '.' and '..'", () => {
    const { input, opts } = baseInput({ namespace: ".." });
    assert.throws(() => resolveRuntimeConfig(input, opts), RuntimeConfigError);
    const again = baseInput({ namespace: "." });
    assert.throws(() => resolveRuntimeConfig(again.input, again.opts), RuntimeConfigError);
  });

  test("rejects namespace with whitespace or '@'", () => {
    const a = baseInput({ namespace: "demo cloud" });
    assert.throws(() => resolveRuntimeConfig(a.input, a.opts), RuntimeConfigError);
    const b = baseInput({ namespace: "demo@cloud" });
    assert.throws(() => resolveRuntimeConfig(b.input, b.opts), RuntimeConfigError);
  });

  test("rejects logical_repo with '/' (display form)", () => {
    const { input, opts } = baseInput({ logical_repo: "demo/cloud" });
    assert.throws(() => resolveRuntimeConfig(input, opts), RuntimeConfigError);
  });

  test("rejects empty namespace and logical_repo", () => {
    const a = baseInput({ namespace: "" });
    assert.throws(() => resolveRuntimeConfig(a.input, a.opts), RuntimeConfigError);
    const b = baseInput({ logical_repo: "" });
    assert.throws(() => resolveRuntimeConfig(b.input, b.opts), RuntimeConfigError);
  });

  test("rejects relative DB path that escapes via '..'", () => {
    const { input, opts } = baseInput({ db: "../escape.sqlite" });
    assert.throws(
      () => resolveRuntimeConfig(input, opts),
      (err) => err instanceof RuntimeConfigError && /db|escape|relative|\.\./i.test(err.message),
    );
  });

  test("rejects DB path containing NUL", () => {
    const { input, opts, home } = baseInput();
    input.db = `${home}/x\0y.sqlite`;
    assert.throws(() => resolveRuntimeConfig(input, opts), RuntimeConfigError);
  });

  test("rejects missing project_path", () => {
    const { input, opts } = baseInput();
    delete input.project_path;
    assert.throws(() => resolveRuntimeConfig(input, opts), RuntimeConfigError);
  });

  test("rejects invalid threshold shape", () => {
    const { input, opts } = baseInput({
      threshold: { minimum_repository_verified_percentage: 0 },
    });
    assert.throws(() => resolveRuntimeConfig(input, opts), RuntimeConfigError);
  });

  test("all rejections are RuntimeConfigError", () => {
    const { input, opts } = baseInput({ namespace: "../x" });
    assert.throws(
      () => resolveRuntimeConfig(input, opts),
      (err) => err instanceof RuntimeConfigError && err.name === "RuntimeConfigError",
    );
  });
});

describe("createRuntimeLayout — directory creation and modes", () => {
  test("creates data and run directories with mode 0700 and db file parent ready", () => {
    const { input, opts, home } = baseInput({}, { createRunId: () => "run-perm-1" });
    const cfg = resolveRuntimeConfig(input, opts);
    const layout = createRuntimeLayout(cfg);
    assert.equal(layout.db_path, cfg.db_path);
    // Layout returns realpath; macOS may map /var -> /private/var.
    assert.equal(layout.run_root, realpathSync(cfg.run_root));

    const dataDir = join(home, "xdg-data", "descobrir");
    const runDir = join(home, "xdg-cache", "descobrir", "runs", "run-perm-1");
    assert.ok(existsSync(dataDir));
    assert.ok(existsSync(runDir));

    const dataMode = statSync(dataDir).mode & 0o777;
    const runMode = statSync(runDir).mode & 0o777;
    // Exact 0700 where platform mode bits support it (POSIX chmod after mkdir).
    assert.equal(dataMode, 0o700, `data dir mode ${dataMode.toString(8)}`);
    assert.equal(runMode, 0o700, `run dir mode ${runMode.toString(8)}`);
  });

  test("materializes empty db file with mode 0600 when ensureDbFile is true", () => {
    const { input, opts } = baseInput({}, { createRunId: () => "run-db-1" });
    const cfg = resolveRuntimeConfig(input, opts);
    const layout = createRuntimeLayout(cfg, { ensureDbFile: true });
    assert.ok(existsSync(layout.db_path));
    const mode = statSync(layout.db_path).mode & 0o777;
    assert.equal(mode, 0o600, `db mode ${mode.toString(8)}`);
  });

  test("two namespace layouts stay isolated on disk", () => {
    const home = tempRoot("descobrir-two-ns-");
    const project = join(home, "p");
    mkdirSync(project);
    const opts = {
      home,
      env: {
        HOME: home,
        XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"),
      },
      createRunId: () => "shared-run-id-should-differ-by-call",
    };
    let n = 0;
    const mk = (ns) => {
      n += 1;
      const cfg = resolveRuntimeConfig(
        {
          namespace: ns,
          logical_repo: "repo",
          project_path: project,
          source_revision: PINNED_REV,
        },
        { ...opts, createRunId: () => `run-${ns}-${n}` },
      );
      return createRuntimeLayout(cfg, { ensureDbFile: true });
    };
    const a = mk("alpha");
    const b = mk("beta");
    assert.notEqual(a.db_path, b.db_path);
    assert.ok(existsSync(a.db_path));
    assert.ok(existsSync(b.db_path));
    assert.notEqual(a.run_root, b.run_root);
  });

  test("rejects layout when run_root would escape cache root via symlink", () => {
    const home = tempRoot("descobrir-symlink-");
    const project = join(home, "p");
    mkdirSync(project);
    const cache = join(home, "cache");
    const outside = join(home, "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(cache, "descobrir", "runs"), { recursive: true });
    // Plant a symlink that would pull a run id outside the cache tree.
    symlinkSync(outside, join(cache, "descobrir", "runs", "evil-run"));

    const cfg = resolveRuntimeConfig(
      {
        namespace: "demo",
        logical_repo: "demo-cloud",
        project_path: project,
        source_revision: PINNED_REV,
      },
      {
        home,
        env: {
          HOME: home,
          XDG_DATA_HOME: join(home, "data"),
          XDG_CACHE_HOME: cache,
        },
        createRunId: () => "evil-run",
      },
    );
    // If evil-run already exists as symlink escaping cache, create must fail closed.
    assert.throws(
      () => createRuntimeLayout(cfg),
      (err) => err instanceof RuntimeLayoutError || err instanceof RuntimeConfigError,
    );
  });

  test("createRuntimeLayout is idempotent for the same config", () => {
    const { input, opts } = baseInput({}, { createRunId: () => "run-idem" });
    const cfg = resolveRuntimeConfig(input, opts);
    const first = createRuntimeLayout(cfg, { ensureDbFile: true });
    const second = createRuntimeLayout(cfg, { ensureDbFile: true });
    assert.equal(first.db_path, second.db_path);
    assert.equal(first.run_root, second.run_root);
    const mode = statSync(first.db_path).mode & 0o777;
    assert.equal(mode, 0o600, `db mode ${mode.toString(8)}`);
  });
});
