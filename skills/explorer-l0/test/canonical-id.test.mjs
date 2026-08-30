import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CanonicalIdError,
  canonicalRecordId,
  canonicalRecordIdV1,
  canonicalRelationId,
  canonicalRelationIdV1,
} from "../src/canonical-id.mjs";
import { ID_VERSION } from "../src/layered-id.mjs";

describe("ID_VERSION stamp", () => {
  test("is v2 (id_version=2)", () => {
    assert.equal(ID_VERSION, 2);
  });
});

describe("canonicalRecordId (v2)", () => {
  test("derives layer-prefixed id from type + natural_key: l0:<kind>:<key>", () => {
    assert.equal(canonicalRecordId("Service", "Billing API"), "l0:service:billing-api");
  });

  test("is environment-independent (NFC, trim, lowercase, collapse space)", () => {
    // whitespace runs collapse to a single '-'; '/' is preserved
    assert.equal(canonicalRecordId("  Endpoint ", " Get  /orders "), "l0:endpoint:get-/orders");
  });

  test("rejects empty segments after normalization", () => {
    assert.throws(() => canonicalRecordId("   ", "x"), CanonicalIdError);
    assert.throws(() => canonicalRecordId("Service", "   "), CanonicalIdError);
  });
});

describe("canonicalRelationId (v2)", () => {
  test("derives relation id from NATURAL KEYS (not record ids): l0:rel:<TYPE>:<from>-><to>", () => {
    // Plan MUST DO: relation IDs contain canonical natural keys while
    // relation endpoints continue storing full L0 record IDs.
    assert.equal(
      canonicalRelationId("EXPOSES", "billing", "get:/billing"),
      "l0:rel:EXPOSES:billing->get:/billing",
    );
  });

  test("rejects empty parts", () => {
    assert.throws(() => canonicalRelationId("", "a", "b"), CanonicalIdError);
  });
});

describe("canonicalRecordIdV1 / canonicalRelationIdV1 (migration helpers)", () => {
  test("v1 record id preserves legacy unprefixed shape", () => {
    assert.equal(canonicalRecordIdV1("Service", "Billing"), "service:billing");
  });

  test("v1 relation id preserves legacy shape with record ids in body", () => {
    assert.equal(
      canonicalRelationIdV1("EXPOSES", "service:billing", "endpoint:get:/billing"),
      "exposes:service:billing->endpoint:get:/billing",
    );
  });
});
