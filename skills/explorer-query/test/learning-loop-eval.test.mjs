import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  runFixture,
  runAllFixtures,
  metricsFromCounts,
  assertPerfectGate,
} from "../src/learning-loop-eval.mjs";

describe("learning-loop-eval — V1 gate", () => {
  for (const family of ["java-call", "spring-controller", "spring-feign", "cross-repo-http", "kafka", "intentional-omission"]) {
    test(`${family} matches exact outcomes and metrics`, () => {
      const result = runFixture(family);
      assert.deepEqual(result.outcomes, result.expected.outcomes);
      assert.deepEqual(result.metrics, result.expected.expected_metrics);
      assert.doesNotThrow(() => assertPerfectGate(result.metrics));
    });
  }

  test("aggregate sums confusion counts before calculating metrics", () => {
    const result = runAllFixtures();
    assert.deepEqual(result.metrics, metricsFromCounts(result.counts));
    assert.doesNotThrow(() => assertPerfectGate(result.metrics));
  });
});
