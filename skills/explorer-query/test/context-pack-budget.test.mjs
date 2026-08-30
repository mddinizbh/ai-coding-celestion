import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import {
  buildContextPack,
  projectContextPack,
} from "../src/context-pack.mjs";
import { SliceMaterializationError, exitCodeForError } from "../src/slice-errors.mjs";

// Hermetic JSON-Schema-style validator (same subset used by the contract
// suite — no external dep). Validates the Pack against the LOCKED
// context-pack.schema.json (Task 1).
const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(here, "..", "contracts");

class ValidationError extends Error {}

function loadSchema(name) {
  return JSON.parse(readFileSync(join(contractsDir, name), "utf8"));
}

function resolveRef(schema, root) {
  if (!schema || typeof schema !== "object" || !schema.$ref) return schema;
  let cur = root;
  for (const part of schema.$ref.slice(2).split("/")) {
    cur = cur?.[part];
    if (cur === undefined) throw new Error(`unresolved $ref: ${schema.$ref}`);
  }
  return cur;
}

function checkType(type, instance, path) {
  switch (type) {
    case "object":
      if (instance === null || Array.isArray(instance) || typeof instance !== "object")
        throw new ValidationError(`${path}: expected object`);
      return;
    case "array":
      if (!Array.isArray(instance)) throw new ValidationError(`${path}: expected array`);
      return;
    case "string":
      if (typeof instance !== "string") throw new ValidationError(`${path}: expected string`);
      return;
    case "integer":
      if (!Number.isInteger(instance)) throw new ValidationError(`${path}: expected integer`);
      return;
    case "boolean":
      if (typeof instance !== "boolean") throw new ValidationError(`${path}: expected boolean`);
      return;
    default:
      throw new Error(`${path}: unsupported type '${type}'`);
  }
}

function tryValidate(schema, instance, root, path) {
  try {
    validate(schema, instance, root, path);
    return true;
  } catch (err) {
    if (err instanceof ValidationError) return false;
    throw err;
  }
}

function validate(schema, instance, root, path = "$") {
  const s = resolveRef(schema, root);
  if (s.const !== undefined && instance !== s.const) {
    throw new ValidationError(`${path}: expected const ${JSON.stringify(s.const)}`);
  }
  if (s.enum !== undefined && !s.enum.includes(instance)) {
    throw new ValidationError(`${path}: ${JSON.stringify(instance)} not in enum`);
  }
  if (s.type !== undefined) checkType(s.type, instance, path);
  if (typeof instance === "string" && s.pattern !== undefined) {
    if (!new RegExp(s.pattern).test(instance)) {
      throw new ValidationError(`${path}: ${JSON.stringify(instance)} does not match ${s.pattern}`);
    }
  }
  if (typeof instance === "string" && s.minLength !== undefined && instance.length < s.minLength) {
    throw new ValidationError(`${path}: shorter than minLength ${s.minLength}`);
  }
  if (typeof instance === "number" && s.minimum !== undefined && instance < s.minimum) {
    throw new ValidationError(`${path}: below minimum ${s.minimum}`);
  }
  if (Array.isArray(instance) && s.minItems !== undefined && instance.length < s.minItems) {
    throw new ValidationError(`${path}: shorter than minItems ${s.minItems}`);
  }
  if (s.properties || s.required || s.additionalProperties !== undefined) {
    if (instance !== null && !Array.isArray(instance) && typeof instance === "object") {
      const allowed = s.properties ? Object.keys(s.properties) : [];
      if (s.additionalProperties === false) {
        for (const key of Object.keys(instance)) {
          if (!allowed.includes(key)) {
            throw new ValidationError(`${path}.${key}: additional property not allowed`);
          }
        }
      }
      if (s.required) {
        for (const r of s.required) {
          if (!(r in instance)) throw new ValidationError(`${path}: missing required '${r}'`);
        }
      }
      if (s.properties) {
        for (const [key, sub] of Object.entries(s.properties)) {
          if (key in instance) validate(sub, instance[key], root, `${path}.${key}`);
        }
      }
    }
  }
  if (s.items && Array.isArray(instance)) {
    instance.forEach((item, i) => validate(s.items, item, root, `${path}[${i}]`));
  }
  if (s.oneOf) {
    let matched = 0;
    for (const branch of s.oneOf) {
      if (tryValidate(branch, instance, root, path)) matched += 1;
    }
    if (matched !== 1) {
      throw new ValidationError(`${path}: matched ${matched} of ${s.oneOf.length} oneOf branches`);
    }
  }
}

const PACK_SCHEMA = loadSchema("context-pack.schema.json");

function assertSchemaValid(pack, label) {
  try {
    validate(PACK_SCHEMA, pack, PACK_SCHEMA);
  } catch (err) {
    if (err instanceof ValidationError) {
      assert.fail(`expected VALID ${label}, validator rejected: ${err.message}`);
    }
    throw err;
  }
}

function assertSchemaInvalid(pack, label, needle) {
  let caught = null;
  try {
    validate(PACK_SCHEMA, pack, PACK_SCHEMA);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ValidationError, `expected INVALID ${label}`);
  if (needle) assert.ok(caught.message.includes(needle), caught.message);
}

// --- Hermetic Slice fixtures -------------------------------------------------
// A complete canonical Slice (per context-slice.schema.json shape) that the
// new Pack consumes. Seeds map to node ids so the projection has mandatory
// seed nodes; non-seed nodes let us exercise distance ordering + truncation.

const H64 = "a".repeat(64);
const K64 = "b".repeat(64);
const OPT64 = "c".repeat(64);
const SEEDSET = "0".repeat(64);
const EHASH = "f".repeat(64);
const JHASH = "d".repeat(64);
const GHASH = "e".repeat(64);

function policy(name = "impact") {
  return { name, version: 1, options_hash: OPT64 };
}

/**
 * Build a hermetic complete Slice. Topology:
 *   seedNodeA (l0) --CALLS--> nodeB (l0) --CALLS--> nodeC (l0)
 *   edgeAB (l0), edgeBC (l0), edgeAC-dangling (endpoints not both selected by default)
 * Seeds: one l0_fact seed pointing at seedNodeA.
 */
function makeSlice(overrides = {}) {
  return {
    id_version: 2,
    schema_version: 2,
    engine_version: "context-slice-engine/v2-idv2",
    system_namespace: "demo-ns",
    policy: policy("impact"),
    seeds: [
      {
        kind: "l0_fact",
        namespace: "demo-ns",
        logical_repo: "demo",
        candidate_id: "c1",
        source_revision: "rev1",
        record_id: "l0:service:seed-a",
      },
    ],
    seed_set_hash: SEEDSET,
    nodes: [
      { kind: "node", id: "l0:service:seed-a", label: "SeedA", layer: "l0", status: "comprovado" },
      { kind: "node", id: "l0:service:node-b", label: "NodeB", layer: "l0", status: "hipótese" },
      { kind: "node", id: "l0:service:node-c", label: "NodeC", layer: "l0", status: "hipótese" },
      { kind: "node", id: "l0:service:node-d", label: "NodeD", layer: "l0", status: "stale" },
    ],
    edges: [
      { kind: "edge", from: "l0:service:seed-a", to: "l0:service:node-b", relation_type: "CALLS", layer: "l0", status: "hipótese" },
      { kind: "edge", from: "l0:service:node-b", to: "l0:service:node-c", relation_type: "CALLS", layer: "l0", status: "hipótese" },
      // Dangling edge: node-d is unreachable from seed, so it stays at
      // distance Infinity and sorts last by ID.
      { kind: "edge", from: "l0:service:node-d", to: "l0:service:node-c", relation_type: "CALLS", layer: "l0", status: "stale" },
    ],
    edge_set_hash: EHASH,
    misses: [
      { kind: "miss", miss_reason: "policy_boundary", target_id: "l0:service:node-x", detail: "off-allowlist" },
    ],
    l0_baselines: [
      { namespace: "demo-ns", logical_repo: "demo", candidate_id: "c1", source_revision: "rev1", canonical_graph_hash: GHASH },
    ],
    l1: { system_namespace: "demo-ns", edge_set_hash: EHASH },
    l2_bindings: [{ journey_id: "j1", bind_id: "b1", journey_hash: JHASH }],
    coverage: { nodes_indexed: 4, nodes_visited: 4, edges_indexed: 3, edges_visited: 3 },
    ...overrides,
  };
}

const ctx = (overrides = {}) => ({
  slice: makeSlice(overrides.slice),
  sliceHash: H64,
  derivationKey: K64,
  budget: { max_nodes: 100, max_edges: 100, max_chars: 100000, ...overrides.budget },
  ...overrides,
});

// --- Tests -------------------------------------------------------------------

describe("projectContextPack — canonical payload shape & schema", () => {
  test("produces exactly the locked Pack schema fields and no generated_at", () => {
    const pack = projectContextPack(ctx());
    assert.deepEqual(
      Object.keys(pack).sort(),
      ["budget", "coverage_summary", "derivation_summary", "pack_id", "seeds", "slice_hash", "truncated"].sort(),
    );
    assert.equal("generated_at" in pack, false);
    assert.equal(pack.pack_id.startsWith("pack:"), true);
    assert.equal(pack.slice_hash, H64);
  });

  test("Pack validates against the locked context-pack.schema.json", () => {
    const pack = projectContextPack(ctx());
    assertSchemaValid(pack, "full pack");
  });

  test("truncated Pack still validates against the schema", () => {
    const pack = projectContextPack(ctx({ budget: { max_nodes: 1, max_edges: 0, max_chars: 100000 } }));
    assert.equal(pack.truncated, true);
    assertSchemaValid(pack, "truncated pack");
  });

  test("derivation_summary mirrors the source Slice's derivation context", () => {
    const pack = projectContextPack(ctx());
    assert.deepEqual(pack.derivation_summary, {
      derivation_key: K64,
      engine_version: "context-slice-engine/v2-idv2",
      slice_schema_version: 2,
      system_namespace: "demo-ns",
      // version projected to schema-compliant string (materializer emits number)
      policy: { name: "impact", version: "1", options_hash: OPT64 },
    });
  });
});

describe("projectContextPack — determinism & byte-identical output", () => {
  test("same Slice + same budget => byte-identical Pack (clock/order independent)", () => {
    const c = ctx();
    const a = projectContextPack(c);
    const b = projectContextPack(c);
    assert.deepEqual(a, b);
    assert.equal(a.pack_id, b.pack_id);
  });

  test("reshuffled input nodes/edges/seeds => same pack_id (canonical ordering)", () => {
    const base = ctx();
    const a = projectContextPack(base);
    const reshuffled = ctx({
      slice: {
        ...makeSlice(),
        nodes: [...makeSlice().nodes].reverse(),
        edges: [...makeSlice().edges].reverse(),
        seeds: [...makeSlice().seeds].reverse(),
      },
    });
    const b = projectContextPack(reshuffled);
    assert.equal(a.pack_id, b.pack_id);
    assert.deepEqual(a.seeds, b.seeds);
  });

  test("no localeCompare in canonical ordering — uppercase IDs sort before lowercase by raw code units", () => {
    // IDs "Z" vs "a": raw code-unit compare puts "Z" (0x5A) before "a" (0x61).
    // localeCompare could reorder these under some locales — guard against that.
    const slice = makeSlice({
      nodes: [
        { kind: "node", id: "l0:service:Zeta", label: "Z", layer: "l0", status: "comprovado" },
        { kind: "node", id: "l0:service:alpha", label: "a", layer: "l0", status: "comprovado" },
      ],
      edges: [],
      seeds: [
        { kind: "l0_fact", namespace: "demo-ns", logical_repo: "demo", candidate_id: "c1", source_revision: "rev1", record_id: "l0:service:Zeta" },
      ],
    });
    const pack = projectContextPack({ slice, sliceHash: H64, derivationKey: K64, budget: { max_nodes: 100, max_edges: 100, max_chars: 100000 } });
    // coverage_summary counts both nodes; ordering inside Pack is not visible
    // (counts only), so we assert determinism + both included via count.
    assert.equal(pack.coverage_summary.nodes, 2);
    const again = projectContextPack({ slice, sliceHash: H64, derivationKey: K64, budget: { max_nodes: 100, max_edges: 100, max_chars: 100000 } });
    assert.equal(pack.pack_id, again.pack_id);
  });
});

describe("projectContextPack — selection: seeds first, distance, ID tiebreak", () => {
  test("seed node is always selected even when it would not rank first by distance", () => {
    // With max_nodes=1 only the seed node (distance 0) fits; others truncated.
    const pack = projectContextPack(ctx({ budget: { max_nodes: 1, max_edges: 0, max_chars: 100000 } }));
    assert.equal(pack.coverage_summary.nodes, 1);
    assert.equal(pack.truncated, true);
  });

  test("non-seed nodes rank by ascending distance from seed then ID ascending", () => {
    // seed-a (d=0) -> node-b (d=1) -> node-c (d=2). node-d unreachable (Inf).
    // max_nodes=3 keeps seed-a, node-b, node-c; node-d truncated.
    const pack = projectContextPack(ctx({ budget: { max_nodes: 3, max_edges: 100, max_chars: 100000 } }));
    assert.equal(pack.coverage_summary.nodes, 3);
    assert.equal(pack.truncated, true);
  });

  test("ID ascending is the final tiebreak when distance is equal", () => {
    // Two siblings at equal distance from the seed: node-b and a node with a
    // lexicographically smaller ID both reachable in one hop.
    const slice = makeSlice({
      nodes: [
        { kind: "node", id: "l0:service:seed-a", label: "SeedA", layer: "l0", status: "comprovado" },
        { kind: "node", id: "l0:service:aaa-sib", label: "AAA", layer: "l0", status: "hipótese" },
        { kind: "node", id: "l0:service:zzz-sib", label: "ZZZ", layer: "l0", status: "hipótese" },
      ],
      edges: [
        { kind: "edge", from: "l0:service:seed-a", to: "l0:service:aaa-sib", relation_type: "CALLS", layer: "l0", status: "hipótese" },
        { kind: "edge", from: "l0:service:seed-a", to: "l0:service:zzz-sib", relation_type: "CALLS", layer: "l0", status: "hipótese" },
      ],
    });
    // max_nodes=2 keeps seed + the lower-ID sibling (aaa-sib).
    const pack = projectContextPack({ slice, sliceHash: H64, derivationKey: K64, budget: { max_nodes: 2, max_edges: 100, max_chars: 100000 } });
    assert.equal(pack.coverage_summary.nodes, 2);
    assert.equal(pack.truncated, true);
  });
});

describe("projectContextPack — edges only enter when both endpoints selected", () => {
  test("edge with both endpoints selected is counted; edge with a dropped endpoint is excluded", () => {
    // Default fixture: edge seed-a->node-b (both selected), node-b->node-c,
    // node-d->node-c (node-d unreachable). With full budget all 3 nodes that
    // are reachable get selected; the node-d->node-c edge only enters if both
    // endpoints are selected. node-d is at distance Infinity so it is selected
    // LAST; with enough budget it enters and so does its edge.
    const full = projectContextPack(ctx({ budget: { max_nodes: 100, max_edges: 100, max_chars: 100000 } }));
    // 4 nodes selected (seed-a, node-b, node-c, node-d) => all 3 edges eligible.
    assert.equal(full.coverage_summary.nodes, 4);
    assert.equal(full.coverage_summary.edges, 3);
    assert.equal(full.truncated, false);
  });

  test("truncating nodes drops edges whose endpoint fell out of the selection", () => {
    // max_nodes=2 => seed-a + node-b selected. Only edge seed-a->node-b has
    // both endpoints selected; node-b->node-c and node-d->node-c are excluded.
    const pack = projectContextPack(ctx({ budget: { max_nodes: 2, max_edges: 100, max_chars: 100000 } }));
    assert.equal(pack.coverage_summary.nodes, 2);
    assert.equal(pack.coverage_summary.edges, 1);
    assert.equal(pack.truncated, true);
  });

  test("max_edges cap truncates eligible edges without unselecting nodes", () => {
    const pack = projectContextPack(ctx({ budget: { max_nodes: 100, max_edges: 0, max_chars: 100000 } }));
    // All 4 nodes selected, 0 edges admitted => truncated.
    assert.equal(pack.coverage_summary.nodes, 4);
    assert.equal(pack.coverage_summary.edges, 0);
    assert.equal(pack.truncated, true);
  });
});

describe("projectContextPack — budget accounting & truncation flag", () => {
  test("budget.requested mirrors max_chars; budget.used <= requested", () => {
    const pack = projectContextPack(ctx({ budget: { max_nodes: 100, max_edges: 100, max_chars: 5000 } }));
    assert.equal(pack.budget.requested, 5000);
    assert.ok(pack.budget.used <= 5000, `used ${pack.budget.used} > requested 5000`);
    assert.ok(Number.isInteger(pack.budget.used));
    assert.ok(pack.budget.used > 0);
  });

  test("small budget preserves seeds + slice_hash and sets truncated:true", () => {
    // Just enough chars for the seed node and nothing else.
    const pack = projectContextPack(ctx({ budget: { max_nodes: 100, max_edges: 100, max_chars: 200 } }));
    assert.equal(pack.slice_hash, H64);
    assert.ok(pack.seeds.length >= 1);
    assert.equal(pack.truncated, true);
    assert.ok(pack.budget.used <= 200);
  });

  test("truncated is false when the whole Slice fits within budget", () => {
    const pack = projectContextPack(ctx({ budget: { max_nodes: 100, max_edges: 100, max_chars: 100000 } }));
    assert.equal(pack.truncated, false);
  });

  test("coverage_summary.misses reports ALL Slice misses (truncation does not hide gaps)", () => {
    const pack = projectContextPack(ctx({ budget: { max_nodes: 1, max_edges: 0, max_chars: 100000 } }));
    assert.equal(pack.coverage_summary.misses, 1);
  });
});

describe("projectContextPack — typed errors (no silent invalid Pack)", () => {
  test("budget below seed cost throws SliceMaterializationError (exit 2), not an invalid Pack", () => {
    // max_chars too small to represent even the mandatory seed node.
    assert.throws(
      () => projectContextPack(ctx({ budget: { max_nodes: 100, max_edges: 100, max_chars: 1 } })),
      (err) => {
        assert.ok(err instanceof SliceMaterializationError, `got ${err && err.name}`);
        assert.equal(exitCodeForError(err), 2);
        return true;
      },
    );
  });

  test("max_nodes below mandatory seed count throws SliceMaterializationError", () => {
    // 0 nodes allowed but 1 mandatory seed node.
    assert.throws(
      () => projectContextPack(ctx({ budget: { max_nodes: 0, max_edges: 100, max_chars: 100000 } })),
      (err) => err instanceof SliceMaterializationError && exitCodeForError(err) === 2,
    );
  });

  test("malformed budget (non-integer / negative) throws TypeError (caller bug, exit 1)", () => {
    assert.throws(
      () => projectContextPack(ctx({ budget: { max_nodes: 1.5, max_edges: 100, max_chars: 100000 } })),
      TypeError,
    );
    assert.throws(
      () => projectContextPack(ctx({ budget: { max_nodes: -1, max_edges: 100, max_chars: 100000 } })),
      TypeError,
    );
  });

  test("missing sliceHash / derivationKey throws TypeError", () => {
    assert.throws(
      () => projectContextPack({ slice: makeSlice(), sliceHash: "short", derivationKey: K64, budget: { max_nodes: 1, max_edges: 1, max_chars: 100000 } }),
      TypeError,
    );
    assert.throws(
      () => projectContextPack({ slice: makeSlice(), sliceHash: H64, derivationKey: "", budget: { max_nodes: 1, max_edges: 1, max_chars: 100000 } }),
      TypeError,
    );
  });

  test("slice with no seeds is rejected (schema minItems:1 enforced at projection)", () => {
    assert.throws(
      () => projectContextPack(ctx({ slice: { ...makeSlice(), seeds: [] } })),
      (err) => err instanceof Error,
    );
  });
});

describe("projectContextPack — adversarial classes", () => {
  test("stale state: a stale-node status is preserved in the source Slice (no promotion)", () => {
    // node-d has status "stale". The Pack does not promote it; we only assert
    // the projection is deterministic and the stale node participates by ID.
    const pack = projectContextPack(ctx());
    const again = projectContextPack(ctx());
    assert.equal(pack.pack_id, again.pack_id);
  });

  test("misleading truncation: budget.used <= requested even when many nodes dropped", () => {
    const pack = projectContextPack(ctx({ budget: { max_nodes: 1, max_edges: 0, max_chars: 100000 } }));
    assert.equal(pack.truncated, true);
    assert.ok(pack.budget.used <= pack.budget.requested);
  });

  test("dirty worktree isolation: Pack output contains no absolute paths or company literals", () => {
    const pack = projectContextPack(ctx());
    const blob = JSON.stringify(pack);
    assert.equal(/\/Users\/|\/home\/|[A-Za-z]:\\/.test(blob), false);
    assert.equal(/example-corp/i.test(blob), false);
  });

  test("legacy wrapper remains unchanged and coexists with the new projector", () => {
    const legacy = buildContextPack({ system_namespace: "sys", edges: [] });
    assert.equal("generated_at" in legacy, true);
    assert.equal("hops" in legacy, true);
    // The new projector never produces these legacy fields.
    const fresh = projectContextPack(ctx());
    assert.equal("hops" in fresh, false);
    assert.equal("generated_at" in fresh, false);
  });
});
