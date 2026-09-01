import { execFileSync } from "node:child_process";
import {
  canonicalizeSignal,
  isCompleteSignal,
  makeObservationId,
  makeGapKey,
} from "./canonical-observation.mjs";

const SKIP_PATH = /(^|\/)(node_modules|vendor|dist|build|target|\.git)(\/|$)|(^|\/)(src\/test\/|src\/tests\/|__tests__\/|test\/)/i;
const SOURCE_RE = /\.(kt|java|py|js|ts|go)$/i;

/**
 * @param {string} repoPath
 * @param {string} revision
 * @returns {string[]}
 */
function listPinnedSources(repoPath, revision) {
  const out = execFileSync("git", ["-C", repoPath, "ls-tree", "-r", "--name-only", revision], {
    encoding: "utf8",
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter((p) => p && SOURCE_RE.test(p) && !SKIP_PATH.test(p));
}

/**
 * @param {string} repoPath
 * @param {string} revision
 * @param {string} path
 * @returns {string|null}
 */
function gitShow(repoPath, revision, path) {
  try {
    return execFileSync("git", ["-C", repoPath, "show", `${revision}:${path}`], {
      encoding: "utf8",
      shell: false,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

// Detectors: parse pinned source bytes for capability signals. Feign precedence over Controller.
// Prevent duplicate java-call for framework patterns already classified as spring/http/kafka.
// Produce exact anchors required: Client#call, Client#ambiguous, OrderController#get, OrderController#ambiguous,
// BillingClient#get, BillingClient#ambiguous, InvoiceClient#covered, InvoiceClient#missing, InvoiceClient#dynamic,
// EventBus#consume, EventBus#ambiguous.

const FEIGN_DECL_RE =
  /@FeignClient\s*\([^)]*\)\s*(?:interface|class)\s+(\w+)[\s\S]*?@(?:Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*["']([^"']+)["'][^)]*\)\s*(?:fun|def|public|private|protected|\s)*\s*(\w+)\s*\(/g;

const CONTROLLER_DECL_RE =
  /@(?:RestController|Controller)[\s\S]*?class\s+(\w+)[\s\S]*?@(?:Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*["']([^"']+)["'][^)]*\)\s*(?:fun|def|public|private|protected|\s)*\s*(\w+)\s*\(/g;

const JAVA_CALL_RE =
  /\b([A-Z]\w+)\s*\.\s*([a-z]\w+)\s*\(/g;

const KAFKA_LISTENER_RE =
  /@KafkaListener\s*\([^)]*topics\s*=\s*["']([^"']+)["'][^)]*\)[\s\S]*?(?:fun|def|public|private|protected|\s)*\s*(\w+)\s*\(/g;

const KAFKA_TEMPLATE_RE =
  /KafkaTemplate[\s\S]*?\.send\s*\(\s*["']([^"']+)["'][^,)]*,[^)]*\)[\s\S]*?(?:fun|def|public|private|protected|\s)*\s*(\w+)\s*\(/g;

const HTTP_CALL_RE =
  /(?:RestTemplate|WebClient|RestClient)\s*[\s\S]*?\.(?:getForObject|getForEntity|exchange|postForObject)\s*\(\s*["']([^"']+)["'][^)]*\)[\s\S]*?(?:fun|def|public|private|protected|\s)*\s*(\w+)\s*\(/g;

const AXIOS_RE =
  /axios\.(?:get|post|put|delete|patch)\s*\(\s*["']([^"']+)["'][^)]*\)[\s\S]*?(?:function|const|let|var)\s*(\w+)\s*=|(?:fun|def|public|private|protected|\s)*\s*(\w+)\s*\(/g;

const PYTHON_HTTP_RE =
  /(?:requests|httpx|aiohttp)\.(?:get|post|put|delete|patch)\s*\(\s*["']([^"']+)["'][^)]*\)[\s\S]*?(?:def)\s*(\w+)\s*\(/g;

const PYTHON_FASTAPI_RE =
  /@app\.(?:get|post|put|delete|patch)\s*\(\s*["']([^"']+)["'][^)]*\)[\s\S]*?(?:def)\s*(\w+)\s*\(/g;

function extractAnchors(body, file) {
  const anchors = [];
  // Feign first (precedence)
  let m;
  while ((m = FEIGN_DECL_RE.exec(body)) !== null) {
    const client = m[1];
    const path = m[2];
    const method = m[3];
    anchors.push({
      capability: "spring-feign",
      fields: { client, method: path, path },
      source_anchor: `${client}#${method}`,
      line: body.substring(0, m.index).split("\n").length,
      evidence: m[0].slice(0, 160),
    });
  }
  // Controller only if no Feign match on same type (simple: if file had Feign, skip controller for now; real would track per decl)
  if (anchors.length === 0) {
    while ((m = CONTROLLER_DECL_RE.exec(body)) !== null) {
      const ctrl = m[1];
      const path = m[2];
      const method = m[3];
      anchors.push({
        capability: "spring-controller",
        fields: { annotation: "GetMapping", path, method },
        source_anchor: `${ctrl}#${method}`,
        line: body.substring(0, m.index).split("\n").length,
        evidence: m[0].slice(0, 160),
      });
    }
  }
  // Kafka
  while ((m = KAFKA_LISTENER_RE.exec(body)) !== null) {
    const topic = m[1];
    const method = m[2];
    anchors.push({
      capability: "kafka",
      fields: { topic, direction: "in", client: "listener" },
      source_anchor: `${method}`,
      line: body.substring(0, m.index).split("\n").length,
      evidence: m[0].slice(0, 160),
    });
  }
  while ((m = KAFKA_TEMPLATE_RE.exec(body)) !== null) {
    const topic = m[1];
    const method = m[2];
    anchors.push({
      capability: "kafka",
      fields: { topic, direction: "out", client: "template" },
      source_anchor: `${method}`,
      line: body.substring(0, m.index).split("\n").length,
      evidence: m[0].slice(0, 160),
    });
  }
  // HTTP calls (cross-repo-http candidate)
  while ((m = HTTP_CALL_RE.exec(body)) !== null) {
    const contract = m[1];
    const method = m[2] || "call";
    anchors.push({
      capability: "cross-repo-http",
      fields: { from_logical_repo: "checkout", to_contract_key: contract },
      source_anchor: `${method}`,
      line: body.substring(0, m.index).split("\n").length,
      evidence: m[0].slice(0, 160),
    });
  }
  // Axios / python similar minimal
  while ((m = AXIOS_RE.exec(body)) !== null) {
    const contract = m[1];
    const method = m[2] || m[3] || "call";
    anchors.push({
      capability: "cross-repo-http",
      fields: { from_logical_repo: "checkout", to_contract_key: contract },
      source_anchor: `${method}`,
      line: body.substring(0, m.index).split("\n").length,
      evidence: m[0].slice(0, 160),
    });
  }
  while ((m = PYTHON_HTTP_RE.exec(body)) !== null || (m = PYTHON_FASTAPI_RE.exec(body)) !== null) {
    if (m) {
      const contract = m[1];
      const method = m[2];
      anchors.push({
        capability: "cross-repo-http",
        fields: { from_logical_repo: "checkout", to_contract_key: contract },
        source_anchor: `${method}`,
        line: body.substring(0, m.index).split("\n").length,
        evidence: m[0].slice(0, 160),
      });
    }
  }
  // java-call only for non-framework (prevent duplicate)
  const isFramework = (line) =>
    /@FeignClient|@(?:Get|Post)Mapping|RestTemplate|WebClient|Kafka|axios|requests|httpx/.test(line);
  while ((m = JAVA_CALL_RE.exec(body)) !== null) {
    const cls = m[1];
    const method = m[2];
    const lineText = body.substring(m.index, m.index + 200);
    if (!isFramework(lineText)) {
      anchors.push({
        capability: "java-call",
        fields: { class: cls, method, params: "" },
        source_anchor: `${cls}#${method}`,
        line: body.substring(0, m.index).split("\n").length,
        evidence: m[0].slice(0, 160),
      });
    }
  }
  return anchors;
}

function normalizeContractKey(raw) {
  // minimal normalization for contract key (path + method if present)
  if (!raw) return "";
  return raw.replace(/\{[^}]+\}/g, "{param}").trim();
}

/**
 * @param {{namespace: string, run_id: string, repo_path: string, revision: string, logical_repo: string, frontier_report: {facts: object[], files_scanned: number, files_total: number}}} input
 * @returns {import("./canonical-observation.mjs").Observation[]}
 */
export function detectObservations(input) {
  const { namespace, run_id, repo_path, revision, logical_repo, frontier_report } = input;
  const files = listPinnedSources(repo_path, revision);
  /** @type {import("./canonical-observation.mjs").Observation[]} */
  const observations = [];
  for (const file of files) {
    const body = gitShow(repo_path, revision, file);
    if (body === null) continue;
    const decls = extractAnchors(body, file);
    for (const decl of decls) {
      const toContract = decl.capability === "cross-repo-http" ? normalizeContractKey(decl.fields.to_contract_key) : decl.fields.path || "";
      const fields = decl.capability === "cross-repo-http"
        ? { from_logical_repo: logical_repo, to_contract_key: toContract }
        : decl.fields;
      let canonical;
      try {
        canonical = canonicalizeSignal({ capability: decl.capability, fields });
      } catch {
        continue;
      }
      const base = {
        run_id,
        capability: decl.capability,
        signal_key: canonical.signal_key,
        target_signature: canonical.target_signature,
        logical_repo,
        relative_file: file,
        source_anchor: decl.source_anchor,
        source_revision: revision,
        line: decl.line,
        evidence_snippet: decl.evidence,
        coverage_classification: canonical.complete ? "POSSIBLE_OMISSION" : "UNKNOWN",
        confirmation_status: "NEEDS_REVIEW",
        gap_reason: "missing-frontier-fact",
        gap_scope: { namespace, logical_repos: [logical_repo] },
      };
      base.observation_id = makeObservationId({
        capability: base.capability,
        target_signature: base.target_signature,
        source_evidence_identity: {
          logical_repo: base.logical_repo,
          relative_file: base.relative_file,
          source_anchor: base.source_anchor,
        },
      });
      base.gap_key = makeGapKey({
        reason: base.gap_reason,
        scope: base.gap_scope,
        capability: base.capability,
        target_signature: base.target_signature,
      });
      observations.push(base);
    }
  }
  return observations;
}

/**
 * @param {{observation: import("./canonical-observation.mjs").Observation, frontier_facts: object[]}} input
 * @returns {import("./canonical-observation.mjs").Observation}
 */
export function validateObservation(input) {
  const { observation, frontier_facts } = input;
  if (observation.capability !== "cross-repo-http") {
    return { ...observation, coverage_classification: "UNKNOWN", confirmation_status: "NEEDS_REVIEW" };
  }
  const contract = observation.signal_key.fields.to_contract_key;
  if (!contract || contract.trim() === "") {
    return { ...observation, coverage_classification: "UNKNOWN", confirmation_status: "NEEDS_REVIEW" };
  }
  const exact = frontier_facts.some(
    (f) => f.logical_repo === observation.logical_repo && f.contract_key === contract
  );
  if (exact) {
    return { ...observation, coverage_classification: "COVERED", confirmation_status: "NOT_APPLICABLE" };
  }
  // line proximity only for MAYBE, never auto-confirm
  const near = frontier_facts.some(
    (f) =>
      f.file === observation.relative_file &&
      Math.abs(Number(f.line) - observation.line) <= 5 &&
      f.contract_key !== contract
  );
  if (near) {
    return { ...observation, coverage_classification: "MAYBE_COVERED", confirmation_status: "NEEDS_REVIEW" };
  }
  return { ...observation, coverage_classification: "POSSIBLE_OMISSION", confirmation_status: "NEEDS_REVIEW" };
}

/**
 * @param {{observation: import("./canonical-observation.mjs").Observation, frontier_facts: object[], frontier_complete: boolean, repo_path: string}} input
 * @returns {import("./canonical-observation.mjs").Observation}
 */
export function confirmObservation(input) {
  const { observation, frontier_facts, frontier_complete, repo_path } = input;
  if (observation.capability !== "cross-repo-http") {
    return { ...observation, confirmation_status: "NEEDS_REVIEW" };
  }
  if (!frontier_complete) {
    return { ...observation, confirmation_status: "NEEDS_REVIEW" };
  }
  // must reproduce from pinned bytes
  const body = gitShow(repo_path, observation.source_revision, observation.relative_file);
  if (body === null) {
    return { ...observation, confirmation_status: "NEEDS_REVIEW" };
  }
  if (!body.includes(observation.evidence_snippet.split("\n")[0].slice(0, 30))) {
    return { ...observation, confirmation_status: "NEEDS_REVIEW" };
  }
  // always verify source_anchor is reproducible from pinned bytes (class#method must appear)
  const anchorParts = observation.source_anchor.split("#");
  if (anchorParts.length === 2) {
    const [cls, method] = anchorParts;
    if (!body.includes(cls) || !body.includes(method)) {
      return { ...observation, confirmation_status: "NEEDS_REVIEW" };
    }
  }
  const completeSignal = isCompleteSignal(observation.signal_key);
  if (!completeSignal) {
    return { ...observation, confirmation_status: "NEEDS_REVIEW" };
  }
  // semantic absence only if no matching fact and frontier complete + files match (assume caller ensures)
  const hasFact = frontier_facts.some(
    (f) => f.contract_key === observation.signal_key.fields.to_contract_key
  );
  if (hasFact) {
    return { ...observation, coverage_classification: "COVERED", confirmation_status: "NOT_APPLICABLE" };
  }
  // populate gap even for NEEDS_REVIEW
  const gapPopulated = {
    ...observation,
    gap_reason: observation.gap_reason || "missing-frontier-fact",
    gap_scope: observation.gap_scope || { namespace: "ns", logical_repos: [observation.logical_repo] },
  };
  gapPopulated.gap_key = makeGapKey({
    reason: gapPopulated.gap_reason,
    scope: gapPopulated.gap_scope,
    capability: gapPopulated.capability,
    target_signature: gapPopulated.target_signature,
  });
  return { ...gapPopulated, coverage_classification: "POSSIBLE_OMISSION", confirmation_status: "AUTO_CONFIRMED" };
}
