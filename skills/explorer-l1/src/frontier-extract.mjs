/**
 * Deterministic frontier extraction from a Git repo at a pinned revision.
 *
 * Sources (no LLM):
 * - Spring MVC annotations → HTTP inbound
 * - RestTemplate/WebClient URL string templates + @Value base URL → HTTP outbound
 * - application.yml keys that look like service base URLs → config bindings
 * - crontab curl commands → scheduled HTTP outbound facts
 *
 * Each fact points at file:line evidence in the source repo.
 *
 * ADR 0009 (id_version=2): every FrontierFact id is built by the shared
 * `makeFrontierFactId` from explorer-l0/layered-id.mjs — the same builder L0
 * export uses. The two generators are unified; no duplicate logic, no
 * file/name matching, no divergent 32-bit hash.
 */

import { execFileSync } from "node:child_process";
import { makeFrontierFactId, compareRaw } from "../../explorer-l0/src/layered-id.mjs";
import { adapterFor, describeAdapters, isAdapterFile } from "./adapters/index.mjs";
import { FrontierError } from "./errors.mjs";
import { contractKey, normalizeHttpPath, normalizeMethod } from "./path-normalize.mjs";

export { describeAdapters };

/**
 * @typedef {{
 *   kind: "http_inbound" | "http_outbound" | "config_binding" | "topic_publish" | "topic_consume",
 *   namespace: string,
 *   logical_repo: string,
 *   source_revision: string,
 *   method?: string,
 *   path?: string,
 *   contract_key?: string,
 *   config_key?: string,
 *   trigger?: "http-sync" | "queue" | "cron" | "webhook" | "internal",
 *   interaction?: "http" | "webhook" | "topic",
 *   schedule?: string,
 *   pipeline_id?: string,
 *   operation_index?: number,
 *   messaging_system?: "kafka" | "sqs" | "sns" | "rabbit" | "jms",
 *   file: string,
 *   line: number,
 *   evidence_snippet: string,
 *   id: string,
 * }} FrontierFact
 */

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
 * @param {string} repoPath
 * @param {string} revision
 * @returns {string[]}
 */
function listSourceFiles(repoPath, revision) {
  const out = execFileSync(
    "git",
    ["-C", repoPath, "ls-tree", "-r", "--name-only", revision],
    { encoding: "utf8", shell: false, maxBuffer: 32 * 1024 * 1024 },
  );
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(
      (p) =>
        p &&
        !p.includes("src/test/") &&
        !p.includes("/test/") &&
        (/\.(kt|java|yml|yaml|properties)$/i.test(p) ||
          /application.*\.(yml|yaml|properties)$/i.test(p) ||
          isAdapterFile(p) ||
          /(^|\/)(cron\.d\/[^/]+|crontab|[^/]+\.cron)$/i.test(p)),
    );
}

/** @param {string} file */
function isCronSource(file) {
  return /(^|\/)(cron\.d\/[^/]+|crontab|[^/]+\.cron)$/i.test(file);
}

/**
 * Extract every curl operation from active crontab entries. A poll GET and its
 * fan-out POST remain separate facts, linked by one deterministic pipeline id.
 *
 * @param {string} text
 * @param {string} file
 * @param {{ namespace: string, logical_repo: string, source_revision: string }} meta
 * @returns {FrontierFact[]}
 */
function extractFromCron(text, file, meta) {
  const facts = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const source = lines[i];
    if (!source.trim() || source.trimStart().startsWith("#")) continue;
    const entry = source.match(/^\s*(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+\S+\s+(.+)$/);
    if (!entry) continue;
    const schedule = entry[1];
    const command = entry[2];
    const starts = [...command.matchAll(/\bcurl\b/g)].map((match) => match.index ?? 0);
    const placeholder = command.match(/(?:^|\s)-I\s+([^\s]+)/)?.[1];
    const pipelineId = `cron:${meta.logical_repo}:${file}:${i + 1}`;

    for (let operationIndex = 0; operationIndex < starts.length; operationIndex += 1) {
      const segment = command.slice(starts[operationIndex], starts[operationIndex + 1] ?? command.length);
      const rawUrl = findCurlUrl(segment);
      if (!rawUrl) continue;
      const method = normalizeMethod(segment.match(/(?:^|\s)-X\s+([A-Za-z]+)/)?.[1] || "GET");
      const configKey = rawUrl.match(/^\$\{?([A-Z][A-Z0-9_]*)\}?/)?.[1];
      let pathPart = rawUrl.replace(/^\$\{?[A-Z][A-Z0-9_]*\}?/, "");
      if (placeholder) {
        const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        pathPart = pathPart.replace(new RegExp(`/${escaped}(?=/|\\?|$)`, "g"), "/{param}");
      }
      const path = normalizeHttpPath(pathPart);
      const ck = contractKey(method, path);
      facts.push({
        kind: "http_outbound",
        namespace: meta.namespace,
        logical_repo: meta.logical_repo,
        source_revision: meta.source_revision,
        method,
        path,
        contract_key: ck,
        ...(configKey ? { config_key: configKey } : {}),
        trigger: "cron",
        interaction: isWebhookPath(path) ? "webhook" : "http",
        schedule,
        pipeline_id: pipelineId,
        operation_index: operationIndex,
        file,
        line: i + 1,
        evidence_snippet: segment.trim().slice(0, 200),
        id: factId("http_outbound", meta, file, i + 1, `${ck}|cron:${operationIndex}`),
      });
    }
  }
  return facts;
}

/** @param {string} segment */
function findCurlUrl(segment) {
  const tokens = [...segment.matchAll(/["']([^"']+)["']|(\S+)/g)].map(
    (match) => match[1] || match[2],
  );
  return tokens.find(
    (token) =>
      /^https?:\/\//i.test(token) || /^\$\{?[A-Z][A-Z0-9_]*\}?\//.test(token),
  );
}

/** @param {string} path */
function isWebhookPath(path) {
  return /\/(webhook|notification)(?:\/|$)/i.test(path);
}

/**
 * Common JVM messaging seams. Dynamic channel names are represented by their
 * configuration key (`config:KEY`) rather than guessed runtime values.
 *
 * @param {string} line
 * @param {string} file
 * @param {number} lineNumber
 * @param {Map<string, string>} valueBindings
 * @param {{ namespace: string, logical_repo: string, source_revision: string }} meta
 * @returns {FrontierFact[]}
 */
function extractMessagingFromLine(line, file, lineNumber, valueBindings, meta) {
  const facts = [];
  const listener = line.match(
    /@(KafkaListener|SqsListener|RabbitListener|JmsListener)\s*\((.*)\)/,
  );
  if (listener) {
    const raw = [...listener[2].matchAll(/["']([^"']+)["']/g)][0]?.[1];
    const channel = resolveChannel(raw, valueBindings);
    if (channel) {
      facts.push(
        messageFact(
          "topic_consume",
          channel,
          messagingSystem(listener[1]),
          line,
          file,
          lineNumber,
          meta,
        ),
      );
    }
  }

  const publisher = line.match(
    /\b([A-Za-z_][A-Za-z0-9_]*(?:Kafka|Rabbit|Jms|Sns|Sqs)[A-Za-z0-9_]*|kafkaTemplate|rabbitTemplate|jmsTemplate|sns|sqs)\.(send|publish|sendMessage|convertAndSend)\s*\(\s*(?:PublishRequest\s*\(\s*)?(["'][^"']+["']|[A-Za-z_][A-Za-z0-9_]*)/i,
  );
  if (publisher) {
    const channel = resolveChannel(publisher[3], valueBindings);
    if (channel) {
      facts.push(
        messageFact(
          "topic_publish",
          channel,
          messagingSystem(publisher[1]),
          line,
          file,
          lineNumber,
          meta,
        ),
      );
    }
  }
  return facts;
}

/** @param {string|undefined} raw @param {Map<string, string>} valueBindings */
function resolveChannel(raw, valueBindings) {
  if (!raw) return null;
  const token = raw.replace(/^["']|["']$/g, "");
  const property = token.match(/^\\?\$\{([^}]+)\}$/)?.[1];
  if (property) return { topic: `config:${property}`, config_key: property };
  const bound = valueBindings.get(token);
  if (bound) return { topic: `config:${bound}`, config_key: bound };
  return { topic: token };
}

/** @param {string} label */
function messagingSystem(label) {
  const value = label.toLowerCase();
  if (value.includes("kafka")) return "kafka";
  if (value.includes("rabbit")) return "rabbit";
  if (value.includes("jms")) return "jms";
  if (value.includes("sqs")) return "sqs";
  return "sns";
}

/**
 * @param {"topic_publish"|"topic_consume"} kind
 * @param {{topic: string, config_key?: string}} channel
 * @param {"kafka"|"sqs"|"sns"|"rabbit"|"jms"} system
 * @param {string} line
 * @param {string} file
 * @param {number} lineNumber
 * @param {{ namespace: string, logical_repo: string, source_revision: string }} meta
 * @returns {FrontierFact}
 */
function messageFact(kind, channel, system, line, file, lineNumber, meta) {
  return {
    kind,
    namespace: meta.namespace,
    logical_repo: meta.logical_repo,
    source_revision: meta.source_revision,
    topic: channel.topic,
    ...(channel.config_key ? { config_key: channel.config_key } : {}),
    trigger: "queue",
    interaction: "topic",
    messaging_system: system,
    file,
    line: lineNumber,
    evidence_snippet: line.trim().slice(0, 200),
    id: factId(kind, meta, file, lineNumber, channel.topic),
  };
}

/**
 * @param {string} text
 * @param {string} file
 * @param {{ namespace: string, logical_repo: string, source_revision: string }} meta
 * @returns {FrontierFact[]}
 */
/**
 * True when a Spring/Kotlin property key looks like a service base URL binding.
 * @param {string} key
 */
function isServiceUrlConfigKey(key) {
  return /URL|URI|HOST|ENDPOINT|BASE/i.test(key);
}

/**
 * Map local field/param names → config keys from @Value in this file.
 * Handles Kotlin constructor params and Java fields.
 * @param {string[]} lines
 * @returns {Map<string, string>}
 */
/** Match @Value("${KEY}") allowing Kotlin string escape \${KEY}. */
const VALUE_PROP_RE = /@Value\s*\(\s*["']\\?\$\{([^}]+)\}["']\s*\)/;

function collectValueBindings(lines) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // @Value("${KEY}") ... name  OR same-line Kotlin constructor param
    const same = line.match(
      /@Value\s*\(\s*["']\\?\$\{([^}]+)\}["']\s*\)\s*(?:private\s+|val\s+|var\s+|final\s+)*(?:[\w.<>,?\s]+?\s+)?(\w+)\s*[,)=:]/,
    );
    if (same) {
      map.set(same[2], same[1]);
      continue;
    }
    const valueOnly = line.match(VALUE_PROP_RE);
    if (!valueOnly) continue;
    // look ahead a few lines for the identifier
    for (let j = i; j < Math.min(lines.length, i + 4); j += 1) {
      const id =
        lines[j].match(
          /(?:private\s+|val\s+|var\s+|final\s+)*(?:[\w.<>,?\s]+?\s+)?(\w+)\s*[,)=:;]/,
        ) || lines[j].match(/(\w+)\s*[:=]/);
      if (id && !["String", "val", "var", "private", "final"].includes(id[1])) {
        map.set(id[1], valueOnly[1]);
        break;
      }
    }
  }
  return map;
}

/**
 * Resolve config_key for an outbound URL line using $var / ${var} base prefix.
 * @param {string} line
 * @param {Map<string, string>} valueBindings
 * @returns {string|undefined}
 */
function resolveOutboundConfigKey(line, valueBindings) {
  // Prefer longest matching bound field name appearing as $name in the line
  /** @type {string|undefined} */
  let best;
  let bestLen = 0;
  for (const [varName, configKey] of valueBindings) {
    if (!isServiceUrlConfigKey(configKey)) continue;
    const re = new RegExp(`\\$${varName}\\b`);
    if (re.test(line) && varName.length > bestLen) {
      best = configKey;
      bestLen = varName.length;
    }
  }
  if (best) return best;
  // direct ${PROVIDERCONTROLLER_API_URL} in string
  for (const m of line.matchAll(/\$\{([A-Z][A-Z0-9_]+)\}/g)) {
    if (isServiceUrlConfigKey(m[1])) return m[1];
  }
  return undefined;
}

function extractFromSource(text, file, meta) {
  if (isCronSource(file)) return extractFromCron(text, file, meta);
  const adapter = adapterFor(file);
  if (adapter) {
    // Adapter owns the language rules; identity stays here so every fact id in
    // the system is stamped by the same builder (ADR 0009).
    return adapter
      .extract(text, file, meta, { contractKey, normalizeHttpPath, normalizeMethod })
      .map((fact) => {
        // identity key mirrors the inline JVM rules: contract for HTTP facts,
        // config key for bindings, topic for messaging.
        const identity = fact.contract_key || fact.config_key || fact.topic;
        if (!identity) {
          throw new FrontierError(
            `adapter ${adapter.id} emitted a fact without contract_key/config_key/topic (${file}:${fact.line})`,
          );
        }
        return { ...fact, id: factId(fact.kind, meta, fact.file, fact.line, identity) };
      });
  }
  /** @type {FrontierFact[]} */
  const facts = [];
  const lines = text.split(/\r?\n/);
  const valueBindings = collectValueBindings(lines);

  // Pass with classPrefix tracking (Spring @RequestMapping + Micronaut @Controller)
  let classPrefix = "";
  let pendingClassMap = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    facts.push(...extractMessagingFromLine(line, file, i + 1, valueBindings, meta));
    const rm = line.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/);
    if (rm) pendingClassMap = rm[1];
    const ctrl = line.match(/@Controller\s*\(\s*(?:value\s*=\s*|uri\s*=\s*)?["']([^"']+)["']/);
    if (ctrl) pendingClassMap = ctrl[1];
    if (pendingClassMap && /\b(class|interface)\b/.test(line)) {
      classPrefix = pendingClassMap;
      pendingClassMap = null;
    }

    // Spring *Mapping first; then Micronaut @Get/@Post (negative lookahead avoids @GetMapping)
    const methodAnns = [
      ["GET", /@GetMapping\s*(?:\((?:value\s*=\s*)?["']([^"']*)["']\))?/],
      ["POST", /@PostMapping\s*(?:\((?:value\s*=\s*)?["']([^"']*)["']\))?/],
      ["PUT", /@PutMapping\s*(?:\((?:value\s*=\s*)?["']([^"']*)["']\))?/],
      ["DELETE", /@DeleteMapping\s*(?:\((?:value\s*=\s*)?["']([^"']*)["']\))?/],
      ["PATCH", /@PatchMapping\s*(?:\((?:value\s*=\s*)?["']([^"']*)["']\))?/],
      ["GET", /@Get(?!Mapping)\s*(?:\(\s*(?:uri\s*=\s*|value\s*=\s*)?["']([^"']*)["']\s*\))?/],
      ["POST", /@Post(?!Mapping)\s*(?:\(\s*(?:uri\s*=\s*|value\s*=\s*)?["']([^"']*)["']\s*\))?/],
      ["PUT", /@Put(?!Mapping)\s*(?:\(\s*(?:uri\s*=\s*|value\s*=\s*)?["']([^"']*)["']\s*\))?/],
      ["DELETE", /@Delete(?!Mapping)\s*(?:\(\s*(?:uri\s*=\s*|value\s*=\s*)?["']([^"']*)["']\s*\))?/],
      ["PATCH", /@Patch(?!Mapping)\s*(?:\(\s*(?:uri\s*=\s*|value\s*=\s*)?["']([^"']*)["']\s*\))?/],
    ];
    for (const [method, re] of methodAnns) {
      const m = line.match(re);
      if (!m) continue;
      const sub = m[1] || "";
      const full = joinPaths(classPrefix, sub);
      if (!full || full === "/") continue;
      const ck = contractKey(method, full);
      facts.push({
        kind: "http_inbound",
        namespace: meta.namespace,
        logical_repo: meta.logical_repo,
        source_revision: meta.source_revision,
        method: normalizeMethod(method),
        path: normalizeHttpPath(full),
        contract_key: ck,
        file,
        line: i + 1,
        evidence_snippet: line.trim().slice(0, 200),
        id: factId("http_inbound", meta, file, i + 1, ck),
      });
    }

    // RequestMapping on method with method= RequestMethod.POST
    const rmMethod = line.match(
      /@RequestMapping\s*\([^)]*value\s*=\s*["']([^"']+)["'][^)]*method\s*=\s*RequestMethod\.([A-Z]+)/,
    );
    if (rmMethod) {
      const full = joinPaths(classPrefix, rmMethod[1]);
      const method = rmMethod[2];
      const ck = contractKey(method, full);
      facts.push({
        kind: "http_inbound",
        namespace: meta.namespace,
        logical_repo: meta.logical_repo,
        source_revision: meta.source_revision,
        method: normalizeMethod(method),
        path: normalizeHttpPath(full),
        contract_key: ck,
        file,
        line: i + 1,
        evidence_snippet: line.trim().slice(0, 200),
        id: factId("http_inbound", meta, file, i + 1, ck),
      });
    }

    // @Value base URL → config_binding fact (Kotlin may escape \${...})
    const valueUrl = line.match(VALUE_PROP_RE);
    if (valueUrl && isServiceUrlConfigKey(valueUrl[1])) {
      facts.push({
        kind: "config_binding",
        namespace: meta.namespace,
        logical_repo: meta.logical_repo,
        source_revision: meta.source_revision,
        config_key: valueUrl[1],
        file,
        line: i + 1,
        evidence_snippet: line.trim().slice(0, 200),
        id: factId("config_binding", meta, file, i + 1, valueUrl[1]),
      });
    }

    // Outbound path templates: "$base/api/..." or url = "$x/path"
    const outPaths = [
      ...line.matchAll(/["'`](\$\{?[\w.]+\}?\/[^"'`]+)["'`]/g),
      ...line.matchAll(/["'`](\/api\/[^"'`]+)["'`]/g),
      ...line.matchAll(/["'`](\/private\/[^"'`]+)["'`]/g),
    ];
    for (const om of outPaths) {
      const raw = om[1];
      // strip $var prefix for path part
      const pathPart = raw.replace(/^\$\{?[\w.]+\}?/, "") || raw;
      if (!pathPart.startsWith("/")) continue;
      if (pathPart.length < 4) continue;
      if (/\.(css|js|png|jpg)$/i.test(pathPart)) continue;
      const method = inferMethodNearby(lines, i);
      const ck = contractKey(method, pathPart);
      const configKey = resolveOutboundConfigKey(line, valueBindings);
      facts.push({
        kind: "http_outbound",
        namespace: meta.namespace,
        logical_repo: meta.logical_repo,
        source_revision: meta.source_revision,
        method: normalizeMethod(method),
        path: normalizeHttpPath(pathPart),
        contract_key: ck,
        ...(configKey ? { config_key: configKey } : {}),
        file,
        line: i + 1,
        evidence_snippet: line.trim().slice(0, 200),
        id: factId("http_outbound", meta, file, i + 1, ck),
      });
    }
  }

  // yaml config keys
  if (/\.(yml|yaml)$/i.test(file)) {
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(/^\s*([A-Z][A-Z0-9_]*(?:URL|URI|HOST|ENDPOINT))\s*:/);
      if (m) {
        facts.push({
          kind: "config_binding",
          namespace: meta.namespace,
          logical_repo: meta.logical_repo,
          source_revision: meta.source_revision,
          config_key: m[1],
          file,
          line: i + 1,
          evidence_snippet: lines[i].trim().slice(0, 200),
          id: factId("config_binding", meta, file, i + 1, m[1]),
        });
      }
    }
  }

  return facts;
}

/**
 * @param {string[]} lines
 * @param {number} i
 */
function inferMethodNearby(lines, i) {
  const windows = [
    lines.slice(i, Math.min(lines.length, i + 6)).join(" "),
    lines.slice(Math.max(0, i - 5), i + 1).join(" "),
  ];
  for (const window of windows) {
    if (/\.postFor|PostMapping|HttpMethod\.POST|\bPOST\b|\.post\(/.test(window)) return "POST";
    if (/\.put\(|PutMapping|HttpMethod\.PUT|\bPUT\b/.test(window)) return "PUT";
    if (/\.delete\(|DeleteMapping|HttpMethod\.DELETE|\bDELETE\b/.test(window)) return "DELETE";
    if (/\.patch\(|PatchMapping|HttpMethod\.PATCH|\bPATCH\b/.test(window)) return "PATCH";
  }
  return "GET";
}

/**
 * @param {string} a
 * @param {string} b
 */
function joinPaths(a, b) {
  const left = (a || "").replace(/\/$/, "");
  const right = (b || "").replace(/^\//, "");
  if (!left && !right) return "/";
  if (!left) return `/${right}`.replace(/\/{2,}/g, "/");
  if (!right) return left.startsWith("/") ? left : `/${left}`;
  return `${left.startsWith("/") ? left : `/${left}`}/${right}`.replace(/\/{2,}/g, "/");
}

/**
 * FrontierFact id via the shared builder (plan MUST DO: L0 export and L1
 * extraction call ONE deterministic builder with identical normalized inputs).
 * `kind` MUST be the canonical FrontierFact kind (http_inbound|http_outbound|
 * config_binding|topic_publish|topic_consume); never the short alias.
 *
 * @param {string} kind  canonical kind name
 * @param {{ namespace: string, logical_repo: string, source_revision: string }} meta
 * @param {string} file
 * @param {number} line
 * @param {string} key
 */
function factId(kind, meta, file, line, key) {
  return makeFrontierFactId({
    kind,
    namespace: meta.namespace,
    logical_repo: meta.logical_repo,
    source_revision: meta.source_revision,
    identity_key: key,
    file,
    line,
  });
}

/**
 * @param {{
 *   repoPath: string,
 *   revision: string,
 *   namespace: string,
 *   logical_repo: string,
 * }} input
 * @returns {FrontierFact[]}
 */
export function extractFrontierFromGit(input) {
  if (!input?.repoPath || !input.revision || !input.namespace || !input.logical_repo) {
    throw new FrontierError("repoPath, revision, namespace, logical_repo are required");
  }
  const meta = {
    namespace: input.namespace,
    logical_repo: input.logical_repo,
    source_revision: input.revision,
  };
  let files;
  try {
    files = listSourceFiles(input.repoPath, input.revision);
  } catch (err) {
    throw new FrontierError(`failed to list files at ${input.revision}`, { cause: err });
  }

  /** @type {FrontierFact[]} */
  const all = [];
  for (const file of files) {
    const text = gitShow(input.repoPath, input.revision, file);
    if (!text) continue;
    all.push(...extractFromSource(text, file, meta));
  }

  // dedupe by id
  const byId = new Map();
  for (const f of all) byId.set(f.id, f);
  return [...byId.values()].sort((a, b) => compareRaw(a.id, b.id));
}

/**
 * Coverage inspection for one repo: what was scanned, what was skipped, which
 * adapters fired and what came out. Feeds `frontier report`, whose whole job is
 * to answer "can I trust an empty answer from this repo?".
 *
 * @param {{ repoPath: string, revision: string, namespace: string, logical_repo: string }} input
 */
export function inspectRepoFrontier(input) {
  if (!input?.repoPath || !input.revision || !input.namespace || !input.logical_repo) {
    throw new FrontierError("repoPath, revision, namespace, logical_repo are required");
  }
  const allFiles = execFileSync(
    "git",
    ["-C", input.repoPath, "ls-tree", "-r", "--name-only", input.revision],
    { encoding: "utf8", shell: false, maxBuffer: 32 * 1024 * 1024 },
  )
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const selected = listSourceFiles(input.repoPath, input.revision);
  const selectedSet = new Set(selected);

  /** @param {string} p */
  const ext = (p) => {
    const base = p.split("/").pop() || p;
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot).toLowerCase() : "(no-ext)";
  };

  /** @type {Record<string, number>} */
  const skippedByExt = {};
  for (const f of allFiles) {
    if (selectedSet.has(f)) continue;
    const e = ext(f);
    skippedByExt[e] = (skippedByExt[e] || 0) + 1;
  }

  /** @type {Record<string, number>} */
  const adapters = {};
  for (const f of selected) {
    const a = adapterFor(f);
    const key = a ? a.id : "jvm-inline";
    adapters[key] = (adapters[key] || 0) + 1;
  }

  const facts = extractFrontierFromGit({
    repoPath: input.repoPath,
    revision: input.revision,
    namespace: input.namespace,
    logical_repo: input.logical_repo,
  });

  /** @type {Record<string, number>} */
  const byKind = {};
  for (const f of facts) byKind[f.kind] = (byKind[f.kind] || 0) + 1;

  const topSkipped = Object.entries(skippedByExt)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([extension, count]) => ({ extension, count }));

  return {
    logical_repo: input.logical_repo,
    source_revision: input.revision,
    files_total: allFiles.length,
    files_scanned: selected.length,
    files_skipped: allFiles.length - selected.length,
    skipped_top_extensions: topSkipped,
    files_by_extractor: adapters,
    fact_count: facts.length,
    facts_by_kind: byKind,
    trust:
      facts.length === 0
        ? "no-coverage"
        : byKind.http_inbound
          ? "has-inbound"
          : "outbound-or-config-only",
    facts,
  };
}

/**
 * Optional: also accept pre-built facts (tests).
 * @param {FrontierFact[]} facts
 */
export function dedupeFrontier(facts) {
  const byId = new Map();
  for (const f of facts) byId.set(f.id, f);
  return [...byId.values()].sort((a, b) => compareRaw(a.id, b.id));
}
