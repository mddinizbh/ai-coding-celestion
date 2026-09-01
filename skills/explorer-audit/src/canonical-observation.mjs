import { stableStringify, sha256Text } from "../../explorer-l0/src/stable-json.mjs";

/**
 * @typedef {Object} JavaCallSignal
 * @property {"java-call"} capability
 * @property {{class: string, method: string, params: string}} fields
 */

/**
 * @typedef {Object} SpringControllerSignal
 * @property {"spring-controller"} capability
 * @property {{annotation: string, path: string, method: string}} fields
 */

/**
 * @typedef {Object} SpringFeignSignal
 * @property {"spring-feign"} capability
 * @property {{client: string, method: string, path: string}} fields
 */

/**
 * @typedef {Object} CrossRepoHttpSignal
 * @property {"cross-repo-http"} capability
 * @property {{from_logical_repo: string, to_contract_key: string}} fields
 */

/**
 * @typedef {Object} KafkaSignal
 * @property {"kafka"} capability
 * @property {{topic: string, direction: string, client: string}} fields
 */

/**
 * @typedef {Object} IntentionalOmissionSignal
 * @property {"intentional-omission"} capability
 * @property {{reason: string, scope: string}} fields
 */

/**
 * @typedef {JavaCallSignal | SpringControllerSignal | SpringFeignSignal | CrossRepoHttpSignal | KafkaSignal | IntentionalOmissionSignal} SignalKey
 */

/**
 * @typedef {Object} SourceEvidenceIdentity
 * @property {string} logical_repo
 * @property {string} relative_file
 * @property {string} source_anchor
 */

/**
 * @typedef {Object} GapScope
 * @property {string} namespace
 * @property {string[]} logical_repos Sorted, unique logical repository names.
 */

/**
 * @typedef {Object} Observation
 * @property {string} observation_id
 * @property {string} run_id
 * @property {string} capability
 * @property {SignalKey} signal_key
 * @property {string} target_signature
 * @property {string} logical_repo
 * @property {string} relative_file
 * @property {string} source_anchor
 * @property {string} source_revision
 * @property {number} line
 * @property {string} evidence_snippet
 * @property {"COVERED"|"MAYBE_COVERED"|"POSSIBLE_OMISSION"|"UNKNOWN"} coverage_classification
 * @property {"NOT_APPLICABLE"|"AUTO_CONFIRMED"|"NEEDS_REVIEW"|"HUMAN_CONFIRMED"|"REJECTED"} confirmation_status
 * @property {string} [gap_reason]
 * @property {GapScope} [gap_scope]
 * @property {string} [gap_key]
 */

const SIGNAL_FIELDS = Object.freeze({
  "java-call": ["class", "method", "params"],
  "spring-controller": ["annotation", "path", "method"],
  "spring-feign": ["client", "method", "path"],
  "cross-repo-http": ["from_logical_repo", "to_contract_key"],
  kafka: ["topic", "direction", "client"],
  "intentional-omission": ["reason", "scope"],
});

/**
 * canonicalizeSignal({capability, fields}) -> {signal_key: SignalKey, target_signature: string, complete: boolean}
 * @param {{capability: string, fields: Record<string, string>}} input
 */
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

/**
 * isCompleteSignal(signal_key: SignalKey) -> boolean
 * @param {SignalKey} signalKey
 */
export function isCompleteSignal(signalKey) {
  return Object.values(signalKey.fields).every((value) => value.trim() !== "");
}

/**
 * makeObservationId({capability, target_signature, source_evidence_identity: SourceEvidenceIdentity, source_revision?: string, line?: number}) -> string
 * @param {{capability: string, target_signature: string, source_evidence_identity: SourceEvidenceIdentity, source_revision?: string, line?: number}} input
 */
export function makeObservationId(input) {
  const {capability, target_signature, source_evidence_identity} = input;
  const payload = stableStringify({capability, target_signature, source_evidence_identity});
  return sha256Text(payload);
}

/**
 * makeGapKey({reason, scope: GapScope, capability, target_signature}) -> string
 * @param {{reason: string, scope: GapScope, capability: string, target_signature: string}} input
 */
export function makeGapKey(input) {
  const scope = {
    namespace: input.scope.namespace,
    logical_repos: [...new Set(input.scope.logical_repos)].sort(),
  };
  return sha256Text(stableStringify({reason: input.reason, scope, capability: input.capability, target_signature: input.target_signature}));
}
