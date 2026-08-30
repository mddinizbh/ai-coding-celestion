import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

// Hermetic JSON-Schema-style validator covering only the features used by the
// context-slice contracts (Draft 2020-12 subset). NOT a general validator.
// Lives inside the test module on purpose — no external dep, no node_modules.

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(here, "..", "contracts");

class ValidationError extends Error {}

function loadSchema(name) {
  const text = readFileSync(join(contractsDir, name), "utf8");
  return JSON.parse(text);
}

function resolveRef(schema, root) {
  if (!schema || typeof schema !== "object" || !schema.$ref) return schema;
  if (!schema.$ref.startsWith("#/")) {
    throw new Error(`unsupported external $ref: ${schema.$ref}`);
  }
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
      throw new Error(`${path}: unsupported type '${type}' in schema`);
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
  if (s === undefined) throw new Error(`${path}: unresolved schema`);

  if (s.const !== undefined && instance !== s.const) {
    throw new ValidationError(`${path}: expected const ${JSON.stringify(s.const)}, got ${JSON.stringify(instance)}`);
  }
  if (s.enum !== undefined && !s.enum.includes(instance)) {
    throw new ValidationError(`${path}: ${JSON.stringify(instance)} not in enum ${JSON.stringify(s.enum)}`);
  }
  if (s.type !== undefined) checkType(s.type, instance, path);
  if (typeof instance === "string" && s.pattern !== undefined) {
    if (!new RegExp(s.pattern).test(instance)) {
      throw new ValidationError(`${path}: ${JSON.stringify(instance)} does not match ${s.pattern}`);
    }
  }
  if (typeof instance === "string" && s.minLength !== undefined && instance.length < s.minLength) {
    throw new ValidationError(`${path}: string shorter than minLength ${s.minLength}`);
  }
  if (typeof instance === "number" && s.minimum !== undefined && instance < s.minimum) {
    throw new ValidationError(`${path}: number below minimum ${s.minimum}`);
  }
  if (Array.isArray(instance) && s.minItems !== undefined && instance.length < s.minItems) {
    throw new ValidationError(`${path}: array shorter than minItems ${s.minItems}`);
  }

  if (s.type === "object" || s.properties || s.required || s.additionalProperties !== undefined) {
    if (instance === null || Array.isArray(instance) || typeof instance !== "object") {
      if (s.type === "object") throw new ValidationError(`${path}: expected object`);
    } else {
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

  if (s.type === "array" || s.items) {
    if (!Array.isArray(instance)) {
      if (s.type === "array") throw new ValidationError(`${path}: expected array`);
    } else if (s.items) {
      instance.forEach((item, i) => validate(s.items, item, root, `${path}[${i}]`));
    }
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

function assertValid(schema, instance, label) {
  try {
    validate(schema, instance, schema);
  } catch (err) {
    if (err instanceof ValidationError) {
      assert.fail(`expected VALID ${label}, but validator rejected: ${err.message}`);
    }
    throw err;
  }
}

function assertInvalid(schema, instance, label, needle) {
  let caught = null;
  try {
    validate(schema, instance, schema);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ValidationError, `expected INVALID ${label}, but validator accepted it`);
  if (needle) {
    assert.ok(
      caught.message.includes(needle),
      `expected failure message to include '${needle}', got: ${caught.message}`,
    );
  }
}

// --- Shared fixture builders -------------------------------------------------

const H64 = "a".repeat(64);
const K64 = "b".repeat(64);
const OPT64 = "c".repeat(64);
const JHASH = "d".repeat(64);
const GHASH = "e".repeat(64);
const EHASH = "f".repeat(64);
const SEEDSET = "0".repeat(64);

function validPolicy(name = "journey") {
  return { name, version: "1.0.0", options_hash: OPT64 };
}

function l0FactSeed() {
  return {
    kind: "l0_fact",
    namespace: "demo-ns",
    logical_repo: "demo",
    candidate_id: "c1",
    source_revision: "rev1",
    record_id: "service:foo",
  };
}

function l2JourneySeed() {
  return { kind: "l2_journey", journey_id: "j1", journey_hash: JHASH };
}

function validSlice(overrides = {}) {
  return {
    slice_id: `slice:${H64}`,
    slice_hash: H64,
    derivation_key: K64,
    id_version: 2,
    engine_version: "context-slice-engine/v1",
    slice_schema_version: 2,
    system_namespace: "demo-ns",
    policy: validPolicy(),
    seeds: [l0FactSeed(), l2JourneySeed()],
    l0_baselines: [
      {
        namespace: "demo-ns",
        logical_repo: "demo",
        candidate_id: "c1",
        source_revision: "rev1",
        canonical_graph_hash: GHASH,
      },
    ],
    l1: { system_namespace: "demo-sys", edge_set_hash: EHASH },
    l2_bindings: [{ journey_id: "j1", bind_id: "b1", journey_hash: JHASH }],
    nodes: [
      { kind: "node", id: "service:foo", label: "Foo", layer: "l0", status: "comprovado" },
    ],
    edges: [],
    misses: [],
    coverage: { nodes_indexed: 1, nodes_visited: 1, edges_indexed: 0, edges_visited: 0 },
    provenance: { seed_set_hash: SEEDSET, baseline_count: 1, edge_count: 0 },
    ...overrides,
  };
}

function validPack(overrides = {}) {
  return {
    pack_id: `pack:${"1".repeat(64)}`,
    slice_hash: H64,
    derivation_summary: {
      derivation_key: K64,
      engine_version: "context-slice-engine/v1",
      slice_schema_version: 2,
      system_namespace: "demo-ns",
      policy: validPolicy(),
    },
    seeds: [l0FactSeed()],
    budget: { requested: 4096, used: 1024 },
    coverage_summary: { nodes: 1, edges: 0, misses: 0 },
    truncated: false,
    ...overrides,
  };
}

// --- Tests -------------------------------------------------------------------

describe("schema loading", () => {
  test("all three schemas parse as JSON objects", () => {
    for (const name of [
      "context-slice.schema.json",
      "context-slice-seed.schema.json",
      "context-pack.schema.json",
    ]) {
      const schema = loadSchema(name);
      assert.equal(typeof schema, "object");
      assert.ok(schema !== null);
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.ok(schema.$id.endsWith(name));
    }
  });
});

describe("context-slice canonical payload", () => {
  const schema = loadSchema("context-slice.schema.json");

  test("happy: complete Slice with all required fields validates", () => {
    assertValid(schema, validSlice(), "complete slice");
  });

  test("happy: audit envelope is optional but accepted when present", () => {
    assertValid(
      schema,
      validSlice({
        audit: {
          created_at: "2026-08-06T10:00:00Z",
          updated_at: "2026-08-06T10:00:01Z",
          materialization_ms: 42,
        },
      }),
      "slice with audit envelope",
    );
  });

  test("happy: empty misses/edges arrays accepted", () => {
    assertValid(schema, validSlice({ misses: [], edges: [] }), "slice with empty misses");
  });

  test("failure: timestamp inside canonical payload is rejected", () => {
    assertInvalid(
      schema,
      validSlice({ created_at: "2026-08-06T10:00:00Z" }),
      "slice with created_at at top level",
      "additional property",
    );
  });

  test("failure: updated_at inside canonical payload is rejected", () => {
    assertInvalid(
      schema,
      validSlice({ updated_at: "2026-08-06T10:00:00Z" }),
      "slice with updated_at at top level",
      "additional property",
    );
  });

  test("failure: unknown seed kind is rejected", () => {
    const slice = validSlice();
    slice.seeds[0] = { ...slice.seeds[0], kind: "unknown" };
    assertInvalid(schema, slice, "slice with unknown seed kind", "oneOf");
  });

  test("failure: unknown miss_reason is rejected", () => {
    const slice = validSlice({
      misses: [
        { kind: "miss", miss_reason: "bogus", target_id: "service:foo", detail: "x" },
      ],
    });
    assertInvalid(schema, slice, "slice with unknown miss_reason", "enum");
  });

  test("failure: malformed slice_hash is rejected", () => {
    assertInvalid(schema, validSlice({ slice_hash: "short" }), "slice with short hash", "does not match");
  });

  test("failure: malformed derivation_key is rejected", () => {
    assertInvalid(schema, validSlice({ derivation_key: "XYZ" }), "short derivation_key", "does not match");
  });

  test("failure: unknown policy name is rejected", () => {
    assertInvalid(
      schema,
      validSlice({ policy: validPolicy("bogus") }),
      "slice with unknown policy name",
      "enum",
    );
  });

  test("failure: slice_id without 'slice:' prefix is rejected", () => {
    assertInvalid(
      schema,
      validSlice({ slice_id: H64 }),
      "slice_id missing prefix",
      "does not match",
    );
  });

  test("failure: missing required field is rejected", () => {
    const slice = validSlice();
    delete slice.coverage;
    assertInvalid(schema, slice, "slice missing coverage", "missing required");
  });

  test("failure: missing id_version is rejected (ADR 0009)", () => {
    const slice = validSlice();
    delete slice.id_version;
    assertInvalid(schema, slice, "slice missing id_version", "missing required");
  });

  test("failure: id_version below minimum is rejected (ADR 0009)", () => {
    assertInvalid(
      schema,
      validSlice({ id_version: 0 }),
      "slice with id_version=0",
      "below minimum",
    );
  });

  test("regression (B1): runtime-shaped v2 slice with integer slice_schema_version validates", () => {
    // buildDerivationInputs emits SLICE_SCHEMA_VERSION=2 (integer), not a
    // string. The schema MUST accept the real runtime shape so persisted v2
    // payloads don't silently fail contract validation.
    const runtimeSlice = validSlice({
      engine_version: "context-slice-engine/v2-idv2",
      slice_schema_version: 2,
    });
    assertValid(schema, runtimeSlice, "runtime v2 slice with integer slice_schema_version");
  });

  test("regression (B1): runtime-shaped v2 pack derivation_summary validates", () => {
    const packSchema = loadSchema("context-pack.schema.json");
    assertValid(
      packSchema,
      validPack({
        derivation_summary: {
          derivation_key: K64,
          engine_version: "context-slice-engine/v2-idv2",
          slice_schema_version: 2,
          system_namespace: "demo-ns",
          policy: validPolicy(),
        },
      }),
      "v2 pack with integer slice_schema_version",
    );
  });
});

describe("context-slice-seed", () => {
  const schema = loadSchema("context-slice-seed.schema.json");

  test("happy: l0_fact seed validates", () => {
    assertValid(schema, l0FactSeed(), "l0_fact seed");
  });

  test("happy: l1_edge seed validates", () => {
    assertValid(
      schema,
      {
        kind: "l1_edge",
        system_namespace: "demo-sys",
        edge_id: "e1",
        edge_set_hash: EHASH,
      },
      "l1_edge seed",
    );
  });

  test("happy: l2_journey seed without bind_id validates", () => {
    assertValid(schema, l2JourneySeed(), "l2_journey seed (no bind_id)");
  });

  test("happy: l2_journey seed with bind_id validates", () => {
    assertValid(
      schema,
      { kind: "l2_journey", journey_id: "j1", journey_hash: JHASH, bind_id: "b1" },
      "l2_journey seed (with bind_id)",
    );
  });

  test("failure: unknown kind is rejected", () => {
    assertInvalid(
      schema,
      { kind: "l3_something", journey_id: "j1", journey_hash: JHASH },
      "unknown kind",
      "oneOf",
    );
  });

  test("failure: extra property on l0_fact seed is rejected", () => {
    // Seed schema top-level is oneOf, so the inner 'additional property' is masked
    // by the oneOf summary — verifying rejection is sufficient.
    const seed = { ...l0FactSeed(), surprise: true };
    assertInvalid(schema, seed, "l0_fact seed with extra prop");
  });

  test("failure: l1_edge seed missing edge_set_hash is rejected", () => {
    assertInvalid(
      schema,
      { kind: "l1_edge", system_namespace: "demo-sys", edge_id: "e1" },
      "l1_edge missing edge_set_hash",
    );
  });

  test("failure: malformed journey_hash is rejected", () => {
    assertInvalid(
      schema,
      { kind: "l2_journey", journey_id: "j1", journey_hash: "nope" },
      "l2_journey with bad hash",
    );
  });
});

describe("context-pack canonical payload", () => {
  const schema = loadSchema("context-pack.schema.json");

  test("happy: minimal Pack validates", () => {
    assertValid(schema, validPack(), "minimal pack");
  });

  test("happy: Pack derived from impact policy validates", () => {
    assertValid(
      schema,
      validPack({
        derivation_summary: {
          derivation_key: K64,
          engine_version: "context-slice-engine/v1",
          slice_schema_version: 2,
          system_namespace: "demo-ns",
          policy: validPolicy("impact"),
        },
      }),
      "impact pack",
    );
  });

  test("happy: truncated=true pack validates", () => {
    assertValid(schema, validPack({ truncated: true }), "truncated pack");
  });

  test("failure: generated_at inside canonical Pack payload is rejected", () => {
    assertInvalid(
      schema,
      validPack({ generated_at: "2026-08-06T10:00:00Z" }),
      "pack with generated_at at top level",
      "additional property",
    );
  });

  test("failure: materialization_ms inside canonical Pack payload is rejected", () => {
    assertInvalid(
      schema,
      validPack({ materialization_ms: 42 }),
      "pack with materialization_ms at top level",
      "additional property",
    );
  });

  test("failure: empty seeds array is rejected", () => {
    assertInvalid(schema, validPack({ seeds: [] }), "pack with no seeds", "minItems");
  });

  test("failure: pack_id without 'pack:' prefix is rejected", () => {
    assertInvalid(schema, validPack({ pack_id: H64 }), "pack_id missing prefix", "does not match");
  });

  test("failure: truncated must be boolean", () => {
    assertInvalid(schema, validPack({ truncated: "yes" }), "truncated string", "expected boolean");
  });

  test("failure: unknown policy name in derivation_summary is rejected", () => {
    const pack = validPack();
    pack.derivation_summary.policy = validPolicy("bogus");
    assertInvalid(schema, pack, "pack with unknown policy", "enum");
  });
});
