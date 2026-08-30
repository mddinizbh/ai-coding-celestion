/**
 * Seam: finalizeRun — deterministic finalize verification and persistence.
 *
 * Pipeline: loadRunDescriptor → verifyPreparedArtifacts → listExplorerPayloadFiles
 * → mergeExplorerPayloads → map opaque keys to evidence → bindReadAtRevision
 * → repositorySnapshot post → canonicalize/recompute coverage → persistCandidate.
 *
 * On semantic/guardrail failure: exit 2 with stable blockers, no DB write,
 * run artifacts preserved for retry. On success: candidate_id/hash/coverage
 * emitted and ephemeral run removed per retention (unless overridden).
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

import {
  bindReadAtRevision,
  repositorySnapshot,
} from "../src/git-reader.mjs";
import { buildGraphifyArtifactManifest } from "../src/manifest-builder.mjs";
import { chunkArtifactPath } from "../src/manifest-builder.mjs";
import {
  FINALIZE_EXIT_BLOCKED,
  FINALIZE_EXIT_OK,
  FinalizeRunError,
  finalizeRun,
} from "../src/finalize-run.mjs";
import {
  RUN_PATHS,
  buildRunDescriptor,
  explorerPayloadPath,
  writeRunDescriptor,
} from "../src/run-descriptor.mjs";
import { stablePretty } from "../src/stable-json.mjs";
import { openStore } from "../src/store.mjs";
import {
  ADAPTER,
  PRODUCER,
  projectFixture,
} from "./run-descriptor-fixtures.mjs";
import { NS, REPO } from "./fixtures.mjs";

const temps = [];
function tempRoot(prefix = "finalize-") {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

function fixtureGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", shell: false }).trim();
}

// main.go matches the Graphify fixture source_locations (L1, L3, L6, L11, L15, L17).
const MAIN_GO = `package main

import "fmt"

type Greeter struct {
	name string
}

func (g Greeter) Greet() string {
	return g.name
}

func (g Greeter) Wave() string {
	return "bye"
}

func main() {
	g := Greeter{name: "demo"}
	fmt.Println(g.Greet())
}
`;

/**
 * Build a tiny source repo with main.go committed; return cwd + HEAD + pre snapshot.
 */
function makeSourceRepo() {
  const cwd = mkdtempSync(join(tmpdir(), "finalize-src-"));
  temps.push(cwd);
  fixtureGit(cwd, ["init", "-q", "-b", "main"]);
  writeFileSync(join(cwd, "main.go"), MAIN_GO);
  fixtureGit(cwd, ["add", "."]);
  fixtureGit(cwd, [
    "-c", "user.email=test@example.com",
    "-c", "user.name=Test",
    "commit", "-q", "-m", "initial",
  ]);
  const head = fixtureGit(cwd, ["rev-parse", "HEAD"]);
  const mutationPre = repositorySnapshot({
    cwd,
    anchorRevision: head,
    timeoutMs: 5_000,
  });
  return { cwd, head, mutationPre };
}

/**
 * Build descriptor + parts using a real source revision (not the fixture REV).
 */
function buildPartsForRevisionESM(rev, mutationPre) {
  const { loaded, projection } = projectFixture();
  const manifest = buildGraphifyArtifactManifest({
    namespace: NS,
    logicalRepo: REPO,
    sourceRevision: rev,
    acquisitionMode: "fresh",
    loaded,
    projection,
  });
  return {
    loaded,
    projection,
    manifest,
    chunk_index: projection.chunk_index,
    mutationPre,
  };
}

/**
 * Materialize run root: descriptor, all prepared artifacts, and explorer payloads.
 */
function materializeRun(runRoot, src, opts = {}) {
  const parts = buildPartsForRevisionESM(src.head, src.mutationPre);
  const descriptorInput = {
    run_id: opts.run_id ?? "run-finalize-1",
    package_intent: {
      namespace: NS,
      logical_repo: REPO,
      source_revision: src.head,
      ...(opts.threshold
        ? { threshold: opts.threshold }
        : {}),
    },
    producer: PRODUCER,
    adapter: ADAPTER,
    acquisition_mode: "fresh",
    artifact_manifest: parts.manifest,
    chunk_index: parts.chunk_index,
    mutation_pre: src.mutationPre,
  };
  const descriptor = buildRunDescriptor(descriptorInput);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });

  const writes = [
    [RUN_PATHS.artifactManifest, stablePretty(parts.manifest)],
    [RUN_PATHS.mutationPre, stablePretty(src.mutationPre)],
    [RUN_PATHS.graphifyNative, parts.loaded.nativeBytes],
    [RUN_PATHS.graphifyFacts, parts.projection.jsonl],
    [RUN_PATHS.graphifyChunkIndex, parts.projection.chunk_index_json],
    [RUN_PATHS.graphifyKeyMap, parts.projection.key_map_json],
  ];
  for (const [rel, content] of writes) {
    const abs = join(runRoot, rel);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    if (Buffer.isBuffer(content)) writeFileSync(abs, content, { mode: 0o600 });
    else writeFileSync(abs, content, { encoding: "utf8", mode: 0o600 });
    chmodSync(abs, 0o600);
  }
  for (const chunk of parts.projection.chunks) {
    const rel = chunkArtifactPath(chunk.chunk_key);
    const abs = join(runRoot, rel);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    writeFileSync(abs, chunk.jsonl, { encoding: "utf8", mode: 0o600 });
    chmodSync(abs, 0o600);
  }
  mkdirSync(join(runRoot, RUN_PATHS.explorerPayloads), {
    recursive: true,
    mode: 0o700,
  });
  writeRunDescriptor(runRoot, descriptor);
  return { runRoot, descriptor, parts };
}

/**
 * Pick a node_key from a chunk and emit one explorer record referencing it.
 * Chunks without node facts get a valid empty payload (no semantic claims).
 */
function writePayloadForChunk(runRoot, chunk, projection, overrides = {}) {
  const nodeKey = chunk.fact_keys.find((k) => k.startsWith("n:"));
  const payload =
    nodeKey === undefined
      ? { chunk_key: chunk.chunk_key, records: [], relations: [] }
      : {
          chunk_key: chunk.chunk_key,
          records: [
            {
              node_key: nodeKey,
              type: "Service",
              natural_key: `svc-${nodeKey}`,
              name: `Service ${nodeKey}`,
              summary: `Service derived from ${nodeKey}`,
              attributes: { layer: "domain" },
              ...overrides.record,
            },
          ],
          relations: [],
          ...overrides.payload,
        };
  const rel = explorerPayloadPath(chunk.chunk_key);
  const abs = join(runRoot, rel);
  mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
  writeFileSync(abs, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(abs, 0o600);
  return payload;
}

describe("finalizeRun — success path", () => {
  test("happy: persists candidate with verified repository evidence and coverage > 0", () => {
    const src = makeSourceRepo();
    const runRoot = tempRoot();
    const dbPath = join(tempRoot("finalize-db-"), "store.sqlite");
    const ctx = materializeRun(runRoot, src);
    for (const chunk of ctx.parts.projection.chunks) {
      writePayloadForChunk(runRoot, chunk, ctx.parts.projection);
    }

    const result = finalizeRun({
      runRoot,
      dbPath,
      sourceRepoPath: src.cwd,
      timeoutMs: 5_000,
      retainRun: true,
    });

    assert.equal(result.status, "finalized");
    assert.equal(result.exit_code, FINALIZE_EXIT_OK);
    assert.equal(typeof result.candidate_id, "string");
    assert.ok(result.candidate_id.length > 0);
    assert.equal(result.created, true);
    assert.match(result.canonical_graph_hash, /^[a-f0-9]{64}$/);
    assert.ok(
      result.coverage.repository_verified_percentage > 0,
      "repository_verified_percentage must be > 0 with verified repo evidence",
    );
    assert.equal(result.coverage.mutation_equivalent, true);
    assert.equal(result.coverage.passed, true);

    // candidate row exists
    const store = openStore(dbPath);
    try {
      const rows = store._db
        .prepare(`SELECT COUNT(*) AS n FROM l0_candidate_packages`)
        .get();
      assert.equal(rows.n, 1);
    } finally {
      store.close();
    }
  });

  test("idempotent: identical second finalize returns created:false with same candidate_id", () => {
    const src = makeSourceRepo();
    const runRoot = tempRoot();
    const dbPath = join(tempRoot("finalize-db-"), "store.sqlite");
    const ctx = materializeRun(runRoot, src);
    for (const chunk of ctx.parts.projection.chunks) {
      writePayloadForChunk(runRoot, chunk, ctx.parts.projection);
    }

    const first = finalizeRun({
      runRoot,
      dbPath,
      sourceRepoPath: src.cwd,
      timeoutMs: 5_000,
      retainRun: true,
    });
    const second = finalizeRun({
      runRoot,
      dbPath,
      sourceRepoPath: src.cwd,
      timeoutMs: 5_000,
      retainRun: true,
    });

    assert.equal(second.status, "finalized");
    assert.equal(second.candidate_id, first.candidate_id);
    assert.equal(second.created, false);
    const store = openStore(dbPath);
    try {
      const rows = store._db
        .prepare(`SELECT COUNT(*) AS n FROM l0_candidate_packages`)
        .get();
      assert.equal(rows.n, 1);
    } finally {
      store.close();
    }
  });

  test("default retention: success removes ephemeral run artifacts", () => {
    const src = makeSourceRepo();
    const runRoot = tempRoot();
    const dbPath = join(tempRoot("finalize-db-"), "store.sqlite");
    const ctx = materializeRun(runRoot, src);
    for (const chunk of ctx.parts.projection.chunks) {
      writePayloadForChunk(runRoot, chunk, ctx.parts.projection);
    }

    finalizeRun({
      runRoot,
      dbPath,
      sourceRepoPath: src.cwd,
      timeoutMs: 5_000,
      // retainRun defaults to false → run root removed
    });

    assert.equal(existsSync(runRoot), false);
  });
});

describe("finalizeRun — semantic blockers (exit 2, no DB write)", () => {
  test("missing payload for one chunk: blocked with retryable missing_payload", () => {
    const src = makeSourceRepo();
    const runRoot = tempRoot();
    const dbPath = join(tempRoot("finalize-db-"), "store.sqlite");
    const ctx = materializeRun(runRoot, src);
    const chunks = ctx.parts.projection.chunks;
    // Write payloads for all but the last chunk
    for (let i = 0; i < chunks.length - 1; i += 1) {
      writePayloadForChunk(runRoot, chunks[i], ctx.parts.projection);
    }

    const result = finalizeRun({
      runRoot,
      dbPath,
      sourceRepoPath: src.cwd,
      timeoutMs: 5_000,
      retainRun: true,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.exit_code, FINALIZE_EXIT_BLOCKED);
    assert.ok(result.blockers.length > 0);
    assert.ok(
      result.blockers.some(
        (b) => b.code === "missing_payload" && b.retryable === true,
      ),
    );
    assert.equal(existsSync(runRoot), true);

    const store = openStore(dbPath);
    try {
      const rows = store._db
        .prepare(`SELECT COUNT(*) AS n FROM l0_candidate_packages`)
        .get();
      assert.equal(rows.n, 0, "no DB write on semantic blocker");
    } finally {
      store.close();
    }
  });

  test("explorer references unknown node_key: blocked with retryable blockers, no DB write", () => {
    const src = makeSourceRepo();
    const runRoot = tempRoot();
    const dbPath = join(tempRoot("finalize-db-"), "store.sqlite");
    const ctx = materializeRun(runRoot, src);
    const chunks = ctx.parts.projection.chunks;
    // First chunk emits a record with a node_key not present in the chunk index.
    const firstChunk = chunks[0];
    const payload = {
      chunk_key: firstChunk.chunk_key,
      records: [
        {
          node_key: "n:does_not_exist",
          type: "Service",
          natural_key: "ghost",
          name: "Ghost",
          summary: "unknown node key",
          attributes: {},
        },
      ],
      relations: [],
    };
    const rel = explorerPayloadPath(firstChunk.chunk_key);
    writeFileSync(join(runRoot, rel), `${JSON.stringify(payload)}\n`, {
      mode: 0o600,
    });
    // Other chunks emit valid payloads
    for (let i = 1; i < chunks.length; i += 1) {
      writePayloadForChunk(runRoot, chunks[i], ctx.parts.projection);
    }

    const result = finalizeRun({
      runRoot,
      dbPath,
      sourceRepoPath: src.cwd,
      timeoutMs: 5_000,
      retainRun: true,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.exit_code, FINALIZE_EXIT_BLOCKED);
    assert.ok(
      result.blockers.some((b) => b.code === "unknown_node_key"),
      "unknown node key must surface unknown_node_key blocker",
    );
    const store = openStore(dbPath);
    try {
      const rows = store._db
        .prepare(`SELECT COUNT(*) AS n FROM l0_candidate_packages`)
        .get();
      assert.equal(rows.n, 0);
    } finally {
      store.close();
    }
  });

  test("corrupt payload with banned authority field: blocked, no DB write", () => {
    const src = makeSourceRepo();
    const runRoot = tempRoot();
    const dbPath = join(tempRoot("finalize-db-"), "store.sqlite");
    const ctx = materializeRun(runRoot, src);
    const chunks = ctx.parts.projection.chunks;
    const firstChunk = chunks[0];
    const payload = {
      chunk_key: firstChunk.chunk_key,
      records: [
        {
          node_key: firstChunk.fact_keys.find((k) => k.startsWith("n:")),
          type: "Service",
          natural_key: "billing",
          name: "Billing",
          summary: "smuggled",
          attributes: {},
          // Banned authority field — never allowed from Explorer.
          canonical_graph_hash: "d".repeat(64),
        },
      ],
      relations: [],
    };
    const rel = explorerPayloadPath(firstChunk.chunk_key);
    writeFileSync(join(runRoot, rel), `${JSON.stringify(payload)}\n`, {
      mode: 0o600,
    });
    for (let i = 1; i < chunks.length; i += 1) {
      writePayloadForChunk(runRoot, chunks[i], ctx.parts.projection);
    }

    const result = finalizeRun({
      runRoot,
      dbPath,
      sourceRepoPath: src.cwd,
      timeoutMs: 5_000,
      retainRun: true,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.exit_code, FINALIZE_EXIT_BLOCKED);
    assert.ok(result.blockers.some((b) => b.code === "banned_field"));
    const store = openStore(dbPath);
    try {
      const rows = store._db
        .prepare(`SELECT COUNT(*) AS n FROM l0_candidate_packages`)
        .get();
      assert.equal(rows.n, 0);
    } finally {
      store.close();
    }
  });

  test("prepared artifact tampered after prepare: typed FinalizeRunError, no DB write", () => {
    const src = makeSourceRepo();
    const runRoot = tempRoot();
    const dbPath = join(tempRoot("finalize-db-"), "store.sqlite");
    const ctx = materializeRun(runRoot, src);
    for (const chunk of ctx.parts.projection.chunks) {
      writePayloadForChunk(runRoot, chunk, ctx.parts.projection);
    }
    // Mutate one prepared artifact byte → hash drift detected before merge.
    const factsPath = join(runRoot, RUN_PATHS.graphifyFacts);
    const buf = readFileSync(factsPath);
    buf[0] = (buf[0] + 1) % 256;
    writeFileSync(factsPath, buf);

    assert.throws(
      () =>
        finalizeRun({
          runRoot,
          dbPath,
          sourceRepoPath: src.cwd,
          timeoutMs: 5_000,
          retainRun: true,
        }),
      FinalizeRunError,
    );
    const store = openStore(dbPath);
    try {
      const rows = store._db
        .prepare(`SELECT COUNT(*) AS n FROM l0_candidate_packages`)
        .get();
      assert.equal(rows.n, 0);
    } finally {
      store.close();
    }
  });
});

describe("finalizeRun — mutation gate (post snapshot)", () => {
  test("source mutation makes mutation.equivalent:false and gate fail; candidate still persisted", () => {
    const src = makeSourceRepo();
    const runRoot = tempRoot();
    const dbPath = join(tempRoot("finalize-db-"), "store.sqlite");
    const ctx = materializeRun(runRoot, src);
    for (const chunk of ctx.parts.projection.chunks) {
      writePayloadForChunk(runRoot, chunk, ctx.parts.projection);
    }

    // Dirty the source working tree AFTER prepare (descriptor's mutation_pre is fixed).
    writeFileSync(join(src.cwd, "extra.txt"), "dirty-after-prepare\n");

    const result = finalizeRun({
      runRoot,
      dbPath,
      sourceRepoPath: src.cwd,
      timeoutMs: 5_000,
      retainRun: true,
    });

    assert.equal(result.status, "finalized");
    assert.equal(result.exit_code, FINALIZE_EXIT_OK);
    assert.equal(result.coverage.mutation_equivalent, false);
    assert.equal(result.coverage.passed, false);
    // candidate is still persisted (gate failure ≠ semantic blocker).
    const store = openStore(dbPath);
    try {
      const rows = store._db
        .prepare(`SELECT COUNT(*) AS n FROM l0_candidate_packages`)
        .get();
      assert.equal(rows.n, 1);
    } finally {
      store.close();
    }
  });
});

describe("finalizeRun — invalid inputs", () => {
  test("non-absolute runRoot rejected with FinalizeRunError", () => {
    assert.throws(
      () =>
        finalizeRun({
          runRoot: "relative",
          dbPath: "/tmp/x.sqlite",
          sourceRepoPath: "/tmp",
        }),
      FinalizeRunError,
    );
  });

  test("missing runRoot rejected", () => {
    const src = makeSourceRepo();
    const runRoot = tempRoot();
    assert.throws(
      () =>
        finalizeRun({
          runRoot,
          dbPath: join(tempRoot(), "x.sqlite"),
          sourceRepoPath: src.cwd,
          timeoutMs: 5_000,
        }),
      FinalizeRunError,
    );
  });
});

describe("finalizeRun — facade exports", () => {
  test("public surface", () => {
    assert.equal(typeof finalizeRun, "function");
    assert.equal(FINALIZE_EXIT_OK, 0);
    assert.equal(FINALIZE_EXIT_BLOCKED, 2);
    assert.equal(new FinalizeRunError("x").name, "FinalizeRunError");
  });
});
