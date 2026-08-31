/**
 * Class C: signatures in pinned git that L1 frontier extract did not emit.
 * Records omission only — never invents an edge.
 */

import { execFileSync } from "node:child_process";
import { inspectRepoFrontier } from "../../explorer-l1/src/frontier-extract.mjs";

const SKIP_PATH = /(^|\/)(node_modules|vendor|dist|build|target|\.git)(\/|$)|(^|\/)(src\/test\/|src\/tests\/|__tests__\/|test\/)/i;

const HTTP_RE =
  /@(Get|Post|Put|Delete|Patch|Request)Mapping\b|\b(RestTemplate|WebClient|FeignClient)\b|@FeignClient\b|\bfetch\s*\(|\baxios\.(get|post|put|delete|patch)\b|\b(requests|httpx|aiohttp)\./;
const KAFKA_RE =
  /\bKafkaTemplate\b|@KafkaListener\b|\bstreamBridge\.send\s*\(|\bKafkaProducer\b|\bKafkaConsumer\b|\bConsumerRecord\b|\b(aiokafka|KafkaProducer|KafkaConsumer)\b/;
const PYTHON_HTTP_RE =
  /\b(requests|httpx|aiohttp)\.|\bFastAPI\b|@app\.(get|post|put|delete|patch)\b|\bFlask\b/;
const PYTHON_KAFKA_RE = /\b(aiokafka|kafka)\b/;

const SOURCE_RE = /\.(kt|java|py|js|ts|go)$/i;

/**
 * @param {string} file
 * @param {string} line
 * @returns {"http" | "kafka" | "python" | null}
 */
export function classifyHit(file, line) {
  const py = /\.py$/i.test(file);
  if (py && (PYTHON_HTTP_RE.test(line) || PYTHON_KAFKA_RE.test(line) || HTTP_RE.test(line) || KAFKA_RE.test(line))) {
    return "python";
  }
  if (KAFKA_RE.test(line)) return "kafka";
  if (HTTP_RE.test(line)) return "http";
  return null;
}

/**
 * @param {string} repoPath
 * @param {string} revision
 * @returns {string[]}
 */
export function listPinnedSources(repoPath, revision) {
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

/**
 * @param {{ file: string, line: number }[]} facts
 * @param {string} file
 * @param {number} line
 */
export function coveredByFact(facts, file, line) {
  return facts.some((f) => f.file === file && Math.abs(Number(f.line) - line) <= 5);
}

/**
 * @param {{
 *   logical_repo: string,
 *   repo_path: string,
 *   revision: string,
 *   facts?: { file: string, line: number }[],
 * }} repo
 * @param {{ limitPerFamily?: number }} [opts]
 */
export function scanRepoOmissions(repo, opts = {}) {
  const limit = Number.isInteger(opts.limitPerFamily) && opts.limitPerFamily > 0 ? opts.limitPerFamily : 40;
  const facts = Array.isArray(repo.facts) ? repo.facts : [];
  const files = listPinnedSources(repo.repo_path, repo.revision);
  /** @type {Record<"http"|"kafka"|"python", object[]>} */
  const found = { http: [], kafka: [], python: [] };
  for (const file of files) {
    const body = gitShow(repo.repo_path, repo.revision, file);
    if (body === null) continue;
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const family = classifyHit(file, lines[i]);
      if (!family) continue;
      const line = i + 1;
      if (coveredByFact(facts, file, line)) continue;
      const bucket = found[family];
      if (bucket.length >= limit) continue;
      bucket.push({
        family,
        logical_repo: repo.logical_repo,
        file,
        line,
        revision: repo.revision,
        snippet: lines[i].trim().slice(0, 160),
      });
    }
  }
  return found;
}

/**
 * @param {{
 *   namespace: string,
 *   repos: { logical_repo: string, repo_path: string, revision: string }[],
 *   factsForRepo?: (repo: { logical_repo: string, repo_path: string, revision: string }) => { file: string, line: number }[],
 *   limitPerFamily?: number,
 * }} input
 */
export function scanOmissions(input) {
  const extract =
    input.factsForRepo ||
    ((repo) => {
      const report = inspectRepoFrontier({
        repoPath: repo.repo_path,
        revision: repo.revision,
        namespace: input.namespace,
        logical_repo: repo.logical_repo,
      });
      return (report.facts || []).map((f) => ({ file: f.file, line: f.line }));
    });
  const merged = { http: [], kafka: [], python: [] };
  for (const repo of input.repos) {
    const facts = extract(repo);
    const found = scanRepoOmissions({ ...repo, facts }, { limitPerFamily: input.limitPerFamily });
    merged.http.push(...found.http);
    merged.kafka.push(...found.kafka);
    merged.python.push(...found.python);
  }
  return {
    counts: {
      http: merged.http.length,
      kafka: merged.kafka.length,
      python: merged.python.length,
    },
    omissions: merged,
  };
}
