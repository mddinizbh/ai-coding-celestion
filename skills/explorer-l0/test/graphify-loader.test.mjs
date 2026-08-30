/**
 * Public seam: loadGraphifyOutput only.
 * Expected literals are independent of implementation where practical.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { GRAPHIFY_PINNED_VERSION } from "../src/graphify-contract.mjs";
import {
  GraphifyLoaderError,
  GraphifyVersionError,
  loadGraphifyOutput,
} from "../src/graphify-loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures", "graphify", "0.9.32");

const tempRoots = [];
after(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function loadFixtureGraph(name = "graph.json") {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
}

function assertNoMachinePath(text) {
  assert.equal(text.includes("/Users/"), false, text);
  assert.equal(text.includes("/private/"), false, text);
  assert.equal(text.includes("/var/folders/"), false, text);
  assert.equal(text.includes("IdeaProjects"), false, text);
}

describe("loadGraphifyOutput — real 0.9.32 fixture directory", () => {
  test("loads edges fixture with producer.json version", () => {
    const loaded = loadGraphifyOutput(FIXTURE_DIR);
    assert.equal(loaded.producerVersion, "0.9.32");
    assert.equal(loaded.relationsKey, "edges");
    assert.equal(loaded.nodes.length, 4);
    assert.equal(loaded.relations.length, 5);
    assert.equal(loaded.hyperedges.length, 0);
    assert.ok(Buffer.isBuffer(loaded.nativeBytes));
    assert.equal(loaded.nativeBytes.equals(readFileSync(join(FIXTURE_DIR, "graph.json"))), true);
  });

  test("loads synthetic links graph from object with same node count", () => {
    const graph = loadFixtureGraph("graph.links.json");
    const loaded = loadGraphifyOutput({ graph, producerVersion: GRAPHIFY_PINNED_VERSION });
    assert.equal(loaded.relationsKey, "links");
    assert.equal(loaded.nodes.length, 4);
    assert.equal(loaded.relations.length, 5);
  });
});

describe("loadGraphifyOutput — fail closed", () => {
  test("missing graph file yields GraphifyLoaderError without absolute path", () => {
    const dir = tempDir("gf-missing-");
    assert.throws(() => loadGraphifyOutput(dir), (err) => {
      assert.equal(err.name, "GraphifyLoaderError");
      assert.ok(err instanceof GraphifyLoaderError);
      assert.match(String(err.message), /missing/i);
      assertNoMachinePath(String(err.message));
      assert.equal(String(err.message).includes(dir), false);
      return true;
    });
  });

  test("unreadable graph.json yields GraphifyLoaderError without absolute path", () => {
    const dir = tempDir("gf-unreadable-");
    copyFileSync(join(FIXTURE_DIR, "graph.json"), join(dir, "graph.json"));
    copyFileSync(join(FIXTURE_DIR, "producer.json"), join(dir, "producer.json"));
    const graphPath = join(dir, "graph.json");
    chmodSync(graphPath, 0o000);
    try {
      assert.throws(() => loadGraphifyOutput(dir), (err) => {
        assert.equal(err.name, "GraphifyLoaderError");
        assert.ok(err instanceof GraphifyLoaderError);
        assert.match(String(err.message), /unreadable/i);
        assertNoMachinePath(String(err.message));
        assert.equal(String(err.message).includes(dir), false);
        assert.equal(String(err.message).includes(graphPath), false);
        assert.equal(String(err.message).includes("EACCES"), false);
        return true;
      });
    } finally {
      try {
        chmodSync(graphPath, 0o600);
      } catch {
        /* ignore */
      }
    }
  });

  test("unsupported producer version 0.10 yields GraphifyVersionError", () => {
    const graph = loadFixtureGraph();
    assert.throws(
      () => loadGraphifyOutput({ graph, producerVersion: "0.10" }),
      (err) => {
        assert.equal(err.name, "GraphifyVersionError");
        assert.ok(err instanceof GraphifyVersionError);
        assert.match(String(err.message), /0\.10|version/i);
        return true;
      },
    );
  });

  test("graphify_version field 0.10 on bare graph fails closed", () => {
    const graph = { ...loadFixtureGraph(), graphify_version: "0.10" };
    assert.throws(() => loadGraphifyOutput(graph), GraphifyVersionError);
  });

  test("malformed edge endpoint fails closed", () => {
    const graph = loadFixtureGraph();
    graph.edges = [{ source: "main", target: "", relation: "calls" }];
    assert.throws(
      () => loadGraphifyOutput({ graph, producerVersion: "0.9.32" }),
      GraphifyLoaderError,
    );
  });

  test("missing edge source fails closed", () => {
    const graph = loadFixtureGraph();
    graph.edges = [{ target: "main", relation: "calls" }];
    assert.throws(
      () => loadGraphifyOutput({ graph, producerVersion: "0.9.32" }),
      GraphifyLoaderError,
    );
  });

  test("absolute source_file fails closed without leaking path into message", () => {
    const graph = loadFixtureGraph();
    graph.nodes = graph.nodes.map((n, i) =>
      i === 0 ? { ...n, source_file: "/Users/secret/main.go" } : n,
    );
    assert.throws(
      () => loadGraphifyOutput({ graph, producerVersion: "0.9.32" }),
      (err) => {
        assert.ok(err instanceof GraphifyLoaderError);
        assertNoMachinePath(String(err.message));
        assert.equal(String(err.message).includes("/Users/secret"), false);
        return true;
      },
    );
  });

  test("source_file traversal variants fail closed before any output", () => {
    for (const bad of ["../etc/passwd", "foo/../bar", "foo//bar", "foo\\bar", "foo/./bar", ".."]) {
      const graph = loadFixtureGraph();
      graph.nodes = graph.nodes.map((n, i) =>
        i === 0 ? { ...n, source_file: bad } : n,
      );
      assert.throws(
        () => loadGraphifyOutput({ graph, producerVersion: "0.9.32" }),
        GraphifyLoaderError,
        `expected reject for source_file=${bad}`,
      );
    }
  });

  test("source_location path material fails closed", () => {
    const graph = loadFixtureGraph();
    graph.nodes = graph.nodes.map((n, i) =>
      i === 0 ? { ...n, source_location: "../L1" } : n,
    );
    assert.throws(
      () => loadGraphifyOutput({ graph, producerVersion: "0.9.32" }),
      GraphifyLoaderError,
    );
  });

  test("banned raw source field fails closed", () => {
    const graph = loadFixtureGraph();
    graph.nodes = graph.nodes.map((n, i) =>
      i === 0 ? { ...n, raw_source: "package main\nfunc main() {}" } : n,
    );
    assert.throws(
      () => loadGraphifyOutput({ graph, producerVersion: "0.9.32" }),
      GraphifyLoaderError,
    );
  });

  test("token field on edge is rejected at load", () => {
    const graph = loadFixtureGraph();
    graph.edges = graph.edges.map((e, i) =>
      i === 0 ? { ...e, token: "sk-leak" } : e,
    );
    assert.throws(
      () => loadGraphifyOutput({ graph, producerVersion: "0.9.32" }),
      GraphifyLoaderError,
    );
  });

  test("unrecognized hyperedge shape fails closed", () => {
    const graph = loadFixtureGraph();
    graph.hyperedges = [{ label: "no-id-or-nodes" }];
    assert.throws(
      () => loadGraphifyOutput({ graph, producerVersion: "0.9.32" }),
      GraphifyLoaderError,
    );
  });

  test("recognized hyperedge is preserved", () => {
    const graph = loadFixtureGraph();
    graph.hyperedges = [
      {
        id: "cluster_main",
        nodes: ["main", "main_main"],
        relation: "groups",
        source_file: "main.go",
      },
    ];
    const loaded = loadGraphifyOutput({ graph, producerVersion: "0.9.32" });
    assert.equal(loaded.hyperedges.length, 1);
    assert.equal(loaded.hyperedges[0].id, "cluster_main");
  });

  test("temp dir with absolute path in graph.json fails and cleans", () => {
    const dir = tempDir("gf-abs-");
    const graph = loadFixtureGraph();
    graph.nodes[0] = { ...graph.nodes[0], source_file: "/Users/x/main.go" };
    writeFileSync(join(dir, "graph.json"), JSON.stringify(graph));
    writeFileSync(join(dir, "producer.json"), JSON.stringify({ version: "0.9.32" }));
    assert.throws(() => loadGraphifyOutput(dir), GraphifyLoaderError);
  });

  test("empty nodes+edges still loads", () => {
    const loaded = loadGraphifyOutput({
      graph: { nodes: [], edges: [] },
      producerVersion: "0.9.32",
    });
    assert.equal(loaded.nodes.length, 0);
    assert.equal(loaded.relations.length, 0);
  });

  test("nested relative file labels from Graphify AST are accepted", () => {
    const graph = loadFixtureGraph();
    graph.nodes = graph.nodes.map((n, i) =>
      i === 0
        ? {
            ...n,
            label: "agent/client/client.go",
            source_file: "domains/agent/client/client.go",
          }
        : n,
    );
    const loaded = loadGraphifyOutput({ graph, producerVersion: "0.9.32" });
    assert.equal(loaded.nodes[0].label, "agent/client/client.go");
    assert.equal(loaded.nodes[0].source_file, "domains/agent/client/client.go");
  });

  test("empty source_file/source_location on external symbols are treated as absent", () => {
    const graph = loadFixtureGraph();
    graph.nodes = graph.nodes.map((n, i) =>
      i === 0
        ? {
            ...n,
            id: "external_context",
            label: "Context",
            source_file: "",
            source_location: "",
          }
        : n,
    );
    const loaded = loadGraphifyOutput({ graph, producerVersion: "0.9.32" });
    assert.equal(loaded.nodes[0].id, "external_context");
    assert.equal(Object.hasOwn(loaded.nodes[0], "source_file"), false);
    assert.equal(Object.hasOwn(loaded.nodes[0], "source_location"), false);
  });

  test("absolute and machine-root labels fail closed without leaking path", () => {
    for (const bad of [
      "/Users/secret/main.go",
      "/home/secret/main.go",
      "/private/tmp/main.go",
      "C:\\Users\\x\\main.go",
      "agent\\client.go",
      "http://evil.example/x",
      "foo/../bar.go",
      "foo//bar.go",
      "foo/./bar.go",
    ]) {
      const graph = loadFixtureGraph();
      graph.nodes = graph.nodes.map((n, i) =>
        i === 0 ? { ...n, label: bad } : n,
      );
      assert.throws(
        () => loadGraphifyOutput({ graph, producerVersion: "0.9.32" }),
        (err) => {
          assert.ok(err instanceof GraphifyLoaderError);
          assert.match(String(err.message), /label must not embed path material/);
          assertNoMachinePath(String(err.message));
          assert.equal(String(err.message).includes(bad), false);
          return true;
        },
        `expected reject for label=${bad}`,
      );
    }
  });
});
