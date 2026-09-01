import { stableStringify, sha256Text } from "../../explorer-l0/src/stable-json.mjs";

const SIGNAL_FIELDS = Object.freeze({
  "java-call": ["class", "method", "params"],
  "spring-controller": ["annotation", "path", "method"],
  "spring-feign": ["client", "method", "path"],
  "cross-repo-http": ["from_logical_repo", "to_contract_key"],
  kafka: ["topic", "direction", "client"],
  "intentional-omission": ["reason", "scope"],
});

/** @param {{capability: string, fields: Record<string, string>}} input */
export function canonicalizeSignal(input) {
  const required = SIGNAL_FIELDS[input.capability];
  if (!required) throw new TypeError(`unknown capability: ${input.capability}`);
  const actual = Object.keys(input.fields).sort();
  const expected = [...required].sort();
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new TypeError(`${input.capability} expected fields ${expected.join(",")}`);
  }
  if (actual.some((key) => typeof input.fields[key] !== "string")) {
    throw new TypeError("signal fields must be strings");
  }
  const ordered = Object.fromEntries(expected.map((key) => [key, input.fields[key]]));
  const signal_key = {capability: input.capability, fields: ordered};
  const target_signature = stableStringify(signal_key);
  return {signal_key, target_signature, complete: isCompleteSignal(signal_key)};
}

/** @param {SignalKey} signalKey */
export function isCompleteSignal(signalKey) {
  return Object.values(signalKey.fields).every((value) => value.trim() !== "");
}

/** @param {{capability: string, target_signature: string, source_evidence_identity: {logical_repo: string, relative_file: string, source_anchor: string}, source_revision?: string, line?: number}} input */
export function makeObservationId(input) {
  const {capability, target_signature, source_evidence_identity} = input;
  const payload = stableStringify({capability, target_signature, source_evidence_identity});
  return sha256Text(payload);
}

/** @param {{reason: string, scope: GapScope, capability: string, target_signature: string}} input */
export function makeGapKey(input) {
  const scope = {
    namespace: input.scope.namespace,
    logical_repos: [...new Set(input.scope.logical_repos)].sort(),
  };
  return sha256Text(stableStringify({reason: input.reason, scope, capability: input.capability, target_signature: input.target_signature}));
}
