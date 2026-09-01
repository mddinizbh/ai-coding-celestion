import { execFileSync } from "node:child_process";
import {
  canonicalizeSignal,
  isCompleteSignal,
  makeObservationId,
  makeGapKey,
} from "./canonical-observation.mjs";
import { contractKey, normalizeHttpPath } from "../../explorer-l1/src/path-normalize.mjs";

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

function lineNumber(body, index) {
  return body.slice(0, index).split("\n").length;
}

function findMatchingBrace(body, openIndex) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = openIndex; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return index + 1;
  }
  return body.length;
}

function findFirstUnquotedBrace(text) {
  let quote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "{") return i;
  }
  return -1;
}

function collectTypes(body) {
  const types = [];
  const declaration = /(?:^|\n)((?:[ \t]*@[^\n]+\n)*)[ \t]*(?:(?:public|private|protected|internal|abstract|final|open|data|sealed|static)\s+)*(?:class|interface)\s+(\w+)[^{\n]*\{/g;
  let match;
  while ((match = declaration.exec(body)) !== null) {
    const openIndex = declaration.lastIndex - 1;
    const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
    const end = findMatchingBrace(body, openIndex);
    types.push({
      name: match[2],
      annotations: match[1],
      bodyStart: openIndex + 1,
      bodyEnd: end - 1,
      start,
    });
    declaration.lastIndex = end;
  }
  return types;
}

function collectMethodDeclarations(typeBody, bodyOffset) {
  const declarations = [];
  const patterns = [
    /(?:^|\n)((?:[ \t]*@[^\n]+\n)*)[ \t]*(?:(?:public|private|protected|internal|open|final|abstract|override|suspend|inline|operator|infix|tailrec|external)\s+)*fun\s+(\w+)\s*\([^)]*\)[^\n{=]*(?:\{|=|$)/gm,
    /(?:^|\n)((?:[ \t]*@[^\n]+\n)*)[ \t]*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)*(?:[\w$<>\[\],.?]+\s+)+(\w+)\s*\([^)]*\)\s*(?:throws\s+[^\n{;]+)?(?:\{|;|$)/gm,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(typeBody)) !== null) {
      const relativeStart = match.index + (match[0].startsWith("\n") ? 1 : 0);
      declarations.push({
        name: match[2],
        annotations: match[1],
        start: bodyOffset + relativeStart,
        signatureEnd: bodyOffset + pattern.lastIndex,
      });
    }
  }
  declarations.sort((left, right) => left.start - right.start);
  return declarations.filter((item, index) => index === 0 || item.start !== declarations[index - 1].start);
}

function collectMethods(body, type) {
  const typeBody = body.slice(type.bodyStart, type.bodyEnd);
  const declarations = collectMethodDeclarations(typeBody, type.bodyStart);
  return declarations.map((declaration, index) => {
    const nextStart = declarations[index + 1]?.start ?? type.bodyEnd;
    const signature = body.slice(declaration.start, Math.min(declaration.signatureEnd, nextStart));
    const openOffset = findFirstUnquotedBrace(signature);
    const end = openOffset < 0
      ? nextStart
      : Math.min(findMatchingBrace(body, declaration.start + openOffset), nextStart);
    return {
      ...declaration,
      end,
      slice: body.slice(declaration.start, end),
    };
  });
}

function quotedValue(raw) {
  const match = raw.trim().match(/^(["'])(.*?)\1$/);
  return match ? match[2] : "";
}

function signal(type, method, match, capability, fields, extra = {}) {
  const absoluteIndex = method.start + match.index;
  return {
    capability,
    fields,
    source_anchor: `${type.name}#${method.name}`,
    line: lineNumber(extra.body, absoluteIndex),
    evidence: method.slice.slice(match.index, match.index + match[0].length).slice(0, 160),
    ...extra.output,
  };
}

function extractSignals(body, type, method) {
  const signals = [];
  const mapping = method.slice.match(/@(Get|Post|Put|Delete|Patch|Request)Mapping\s*(?:\(([^)]*)\))?/);
  if (mapping) {
    const kind = mapping[1];
    const args = mapping[2] ?? "";
    const pathMatch = args.match(/(?:value|path)\s*=\s*(["'][^"']*["'])/) ?? args.match(/(["'][^"']*["'])/);
    const path = pathMatch ? quotedValue(pathMatch[1]) : "";
    if (type.annotations.includes("@FeignClient")) {
      signals.push(signal(type, method, mapping, "spring-feign", {
        client: type.name,
        method: kind === "Request" ? "" : kind.toUpperCase(),
        path,
      }, { body }));
    } else {
      signals.push(signal(type, method, mapping, "spring-controller", {
        annotation: kind === "Request" ? "" : `${kind}Mapping`,
        path,
        method: method.name,
      }, { body }));
    }
  }

  const listener = method.slice.match(/@KafkaListener\s*\(([^)]*)\)/);
  if (listener) {
    const topicMatch = listener[1].match(/topics\s*=\s*(?:\[\s*)?(["'][^"']*["'])/);
    signals.push(signal(type, method, listener, "kafka", {
      topic: topicMatch ? quotedValue(topicMatch[1]) : "",
      direction: "in",
      client: "listener",
    }, { body }));
  }

  const httpCall = /\b(RestTemplate|WebClient|RestClient)(?:\s*\(\s*\))?\s*\.\s*(getForObject|getForEntity|exchange|postForObject)\s*\(\s*([^,\n)]*)/g;
  let match;
  while ((match = httpCall.exec(method.slice)) !== null) {
    const path = quotedValue(match[3]);
    const httpMethod = match[2].startsWith("post") ? "POST" : "GET";
    signals.push(signal(type, method, match, "cross-repo-http", {
      from_logical_repo: "",
      to_contract_key: path,
    }, { body, output: { methodHint: httpMethod } }));
  }

  const kafkaSend = /\bKafkaTemplate(?:\s*<[^>]+>)?(?:\s*\(\s*\))?\s*\.\s*send\s*\(\s*([^,\n)]*)/g;
  while ((match = kafkaSend.exec(method.slice)) !== null) {
    signals.push(signal(type, method, match, "kafka", {
      topic: quotedValue(match[1]),
      direction: "out",
      client: "template",
    }, { body }));
  }

  const javaCall = /\b([A-Z]\w*)\s*\.\s*([a-z]\w*)\s*\(([^)]*)\)/g;
  const frameworkClasses = new Set(["RestTemplate", "WebClient", "RestClient", "KafkaTemplate"]);
  while ((match = javaCall.exec(method.slice)) !== null) {
    if (frameworkClasses.has(match[1])) continue;
    signals.push(signal(type, method, match, "java-call", {
      class: match[1],
      method: match[2],
      params: match[3].trim(),
    }, { body }));
  }
  return signals;
}

function extractAnchors(body) {
  const signals = [];
  for (const type of collectTypes(body)) {
    for (const method of collectMethods(body, type)) {
      signals.push(...extractSignals(body, type, method));
    }
  }
  return signals;
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
      let toContract = decl.fields.path || decl.fields.to_contract_key || "";
      if (decl.capability === "cross-repo-http" && toContract) {
        const method = decl.methodHint || "GET";
        toContract = contractKey(method, normalizeHttpPath(toContract));
      } else if (decl.capability === "cross-repo-http") {
        toContract = "";
      }
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
      const facts = (frontier_report && frontier_report.facts) || [];
      let processed = validateObservation({ observation: base, frontier_facts: facts });
      const frontier_complete =
        !!(frontier_report && frontier_report.source_revision === revision && frontier_report.files_scanned === frontier_report.files_total);
      processed = confirmObservation({
        observation: processed,
        frontier_facts: facts,
        frontier_complete,
        repo_path,
      });
      observations.push(processed);
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
    return { ...observation, confirmation_status: "NEEDS_REVIEW" };
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
      f.logical_repo === observation.logical_repo &&
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
  if (observation.coverage_classification !== "POSSIBLE_OMISSION") {
    return observation;
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
    (f) =>
      f.logical_repo === observation.logical_repo &&
      f.contract_key === observation.signal_key.fields.to_contract_key
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
