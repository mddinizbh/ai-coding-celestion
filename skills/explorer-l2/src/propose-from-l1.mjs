/**
 * Bottom-up L2 step 1: propose JourneySpec skeleton from L1 system edges only.
 * Does NOT invent domain narrative (partner defaults, plate rules, etc.).
 * Names/descriptions aim to be human-readable integration indexes.
 */

/**
 * @typedef {import("./journey-bind.mjs").JourneySpec} JourneySpec
 */

/**
 * @param {object[]} edges
 * @param {{
 *   system_namespace: string,
 *   journey_id?: string,
 *   title?: string,
 *   from_repo?: string,
 *   to_repo?: string,
 *   min_score?: number,
 *   group_by?: "edge" | "contract_prefix",
 * }} opts
 */
export function proposeFromL1(edges, opts) {
  if (!opts?.system_namespace) {
    throw new Error("proposeFromL1: system_namespace required");
  }
  if (!Array.isArray(edges)) {
    throw new Error("proposeFromL1: edges must be an array");
  }

  const minScore = typeof opts.min_score === "number" ? opts.min_score : 0.0;
  let list = edges.filter((e) => (e.score ?? 0) >= minScore);
  if (opts.from_repo) {
    list = list.filter((e) => e.from?.logical_repo === opts.from_repo);
  }
  if (opts.to_repo) {
    list = list.filter((e) => e.to?.logical_repo === opts.to_repo);
  }

  list = [...list].sort((a, b) => {
    const ak = `${a.from?.logical_repo || ""}\0${a.to?.logical_repo || ""}\0${a.contract_key || ""}`;
    const bk = `${b.from?.logical_repo || ""}\0${b.to?.logical_repo || ""}\0${b.contract_key || ""}`;
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });

  const members = new Set();
  for (const e of list) {
    if (e.from?.logical_repo) members.add(e.from.logical_repo);
    if (e.to?.logical_repo) members.add(e.to.logical_repo);
  }

  const groupBy = opts.group_by || "contract_prefix";
  /** @type {Map<string, object[]>} */
  const groups = new Map();

  for (const e of list) {
    const from = e.from?.logical_repo || "unknown";
    const to = e.to?.logical_repo || "unknown";
    const trigger = triggerOfEdge(e);
    let gkey;
    if (groupBy === "edge") {
      gkey = e.edge_id || `${from}->${to}:${e.contract_key}`;
    } else {
      const prefix = contractPrefix(e.method, e.path || e.contract_key);
      gkey = `${from}->${to}::${trigger}::${prefix}`;
    }
    if (!groups.has(gkey)) groups.set(gkey, []);
    groups.get(gkey).push(e);
  }

  const steps = [];
  let i = 0;
  for (const [, groupEdges] of groups) {
    i += 1;
    const head = groupEdges[0];
    const from = head.from?.logical_repo;
    const to = head.to?.logical_repo;
    const prefix = contractPrefix(head.method, head.path || head.contract_key);
    const pathHint = pathTopic(head.path || head.contract_key);
    const trigger = triggerOfEdge(head);
    const scores = groupEdges.map((e) => e.score ?? 0);
    const minS = Math.min(...scores);
    const maxS = Math.max(...scores);
    const scoreLabel = minS === maxS ? String(maxS) : `${minS}–${maxS}`;
    const cfg = [
      ...new Set(groupEdges.map((e) => e.config_key).filter(Boolean)),
    ];
    const stepId = humanStepId(from, to, pathHint, i);
    const title = humanStepTitle(from, to, pathHint, head.method);

    steps.push({
      id: stepId,
      title,
      trigger,
      from,
      to,
      contract_prefix: prefix,
      description: humanStepDescription({
        from,
        to,
        pathHint,
        method: head.method,
        prefix,
        edgeCount: groupEdges.length,
        scoreLabel,
        configKeys: cfg,
        evidence: flattenEvidence(groupEdges),
      }),
      provenance: {
        source: "l1",
        kind: "integration-hop",
        edge_ids: groupEdges.map((e) => e.edge_id).filter(Boolean),
        match_kinds: [
          ...new Set(groupEdges.map((e) => e.match_kind).filter(Boolean)),
        ],
        config_keys: cfg,
        trigger,
        interactions: [
          ...new Set(groupEdges.map((e) => e.interaction).filter(Boolean)),
        ],
        schedules: [
          ...new Set(groupEdges.map((e) => e.schedule).filter(Boolean)),
        ],
        pipeline_ids: [
          ...new Set(groupEdges.map((e) => e.pipeline_id).filter(Boolean)),
        ],
        evidence: flattenEvidence(groupEdges),
      },
    });
  }

  const fromR = opts.from_repo;
  const toR = opts.to_repo;
  const journeyId =
    opts.journey_id || defaultJourneyId(opts.system_namespace, fromR, toR);
  const title =
    opts.title || defaultJourneyTitle(fromR, toR, [...members].sort());

  /** @type {JourneySpec & { title?: string, pipeline?: object }} */
  const spec = {
    id: journeyId,
    title,
    system_namespace: opts.system_namespace,
    members: [...members].sort(),
    description: humanJourneyDescription({
      title,
      fromR,
      toR,
      edgeCount: list.length,
      stepCount: steps.length,
      minScore,
    }),
    steps,
    pipeline: {
      stage: "propose-from-l1",
      kind: "integration-index",
      edge_count: list.length,
      step_count: steps.length,
      min_score: minScore,
      group_by: groupBy,
      filters: {
        from_repo: opts.from_repo || null,
        to_repo: opts.to_repo || null,
      },
    },
  };

  return {
    spec,
    stats: {
      input_edges: edges.length,
      filtered_edges: list.length,
      steps: steps.length,
      members: spec.members,
    },
  };
}

/** @param {object} edge */
function triggerOfEdge(edge) {
  if (edge?.trigger) return edge.trigger;
  if (edge?.interaction === "topic") return "queue";
  if (edge?.interaction === "webhook") return "webhook";
  return "http-sync";
}

/**
 * @param {string|undefined} method
 * @param {string|undefined} pathOrContract
 */
export function contractPrefix(method, pathOrContract) {
  const raw = pathOrContract || "";
  let path = raw;
  let m = method || "";
  const sp = raw.indexOf(" ");
  if (sp > 0 && /^[A-Z]+$/.test(raw.slice(0, sp))) {
    m = raw.slice(0, sp);
    path = raw.slice(sp + 1);
  }
  const parts = path.split("/").filter(Boolean);
  const keep = parts.slice(0, Math.min(3, parts.length));
  const pref = "/" + keep.join("/");
  return m ? `${m} ${pref}` : pref;
}

/**
 * Short topic from path for ids/titles: bradesco-mg-debits, api-debits, etc.
 * @param {string|undefined} pathOrContract
 */
export function pathTopic(pathOrContract) {
  const raw = pathOrContract || "";
  let path = raw;
  const sp = raw.indexOf(" ");
  if (sp > 0 && /^[A-Z]+$/.test(raw.slice(0, sp))) {
    path = raw.slice(sp + 1);
  }
  const parts = path
    .split("/")
    .filter(Boolean)
    .filter((p) => p !== "{param}" && !p.startsWith("{"));
  // drop noisy prefixes
  const skip = new Set(["private", "api", "v1", "v2"]);
  const meaningful = parts.filter((p) => !skip.has(p.toLowerCase()));
  const take = (meaningful.length ? meaningful : parts).slice(0, 3);
  return take.join("-") || "http";
}

/**
 * @param {object} p
 */
function humanStepTitle(from, to, pathHint, method) {
  const m = method || "HTTP";
  const topic = pathHint.replace(/-/g, " ");
  return `${shortRepo(from)} → ${shortRepo(to)}: ${m} ${topic}`;
}

/**
 * @param {{
 *   from?: string,
 *   to?: string,
 *   pathHint: string,
 *   method?: string,
 *   prefix: string,
 *   edgeCount: number,
 *   scoreLabel: string,
 *   configKeys: string[],
 *   evidence: object[],
 * }} p
 */
function humanStepDescription(p) {
  const lines = [];
  lines.push(
    `Chamada HTTP ${p.method || ""}`.trim() +
      ` de **${shortRepo(p.from)}** para **${shortRepo(p.to)}**`,
  );
  lines.push(`rota (grupo): \`${p.prefix}\``);
  if (p.edgeCount > 1) {
    lines.push(`${p.edgeCount} contratos L1 neste grupo`);
  }
  lines.push(`confiança L1: score ${p.scoreLabel}`);
  if (p.configKeys.length) {
    lines.push(`config: ${p.configKeys.map((c) => `\`${c}\``).join(", ")}`);
  }
  const files = [
    ...new Set(
      (p.evidence || [])
        .map((e) => e.file)
        .filter(Boolean)
        .map((f) => f.split("/").slice(-2).join("/")),
    ),
  ].slice(0, 4);
  if (files.length) {
    lines.push(`evidência: ${files.join(", ")}`);
  }
  lines.push(
    "Índice de integração (não é fluxo de negócio completo); semântica de domínio só após enrich L0 + leitura de body nos hotspots",
  );
  return lines.join(". ") + ".";
}

/**
 * @param {{
 *   title: string,
 *   fromR?: string,
 *   toR?: string,
 *   edgeCount: number,
 *   stepCount: number,
 *   minScore: number,
 * }} p
 */
function humanJourneyDescription(p) {
  const pair =
    p.fromR && p.toR
      ? `entre **${shortRepo(p.fromR)}** e **${shortRepo(p.toR)}**`
      : p.fromR
        ? `a partir de **${shortRepo(p.fromR)}**`
        : p.toR
          ? `em direção a **${shortRepo(p.toR)}**`
          : "no system namespace";
  return (
    `${p.title}. ` +
    `Índice de hops HTTP ${pair}, gerado só a partir do L1 ` +
    `(${p.edgeCount} edges → ${p.stepCount} steps` +
    (p.minScore > 0 ? `, score ≥ ${p.minScore}` : "") +
    `). ` +
    `Não substitui jornada de domínio (consulta/liquidação/UF). ` +
    `Use para blast radius de contrato e como esqueleto antes do enrich L0.`
  );
}

/**
 * @param {string|undefined} systemNs
 * @param {string|undefined} fromR
 * @param {string|undefined} toR
 */
function defaultJourneyId(systemNs, fromR, toR) {
  if (fromR && toR) {
    return `integration-${slug(shortRepo(fromR))}-to-${slug(shortRepo(toR))}`;
  }
  if (fromR) return `integration-from-${slug(shortRepo(fromR))}`;
  if (toR) return `integration-to-${slug(shortRepo(toR))}`;
  return `integration-${slug(systemNs || "system")}`;
}

/**
 * @param {string|undefined} fromR
 * @param {string|undefined} toR
 * @param {string[]} members
 */
function defaultJourneyTitle(fromR, toR, members) {
  if (fromR && toR) {
    return `Integração ${shortRepo(fromR)} → ${shortRepo(toR)}`;
  }
  if (fromR) return `Integrações a partir de ${shortRepo(fromR)}`;
  if (toR) return `Integrações para ${shortRepo(toR)}`;
  if (members.length) {
    return `Integrações: ${members.map(shortRepo).join(", ")}`;
  }
  return "Índice de integrações L1";
}

/**
 * @param {string|undefined} from
 * @param {string|undefined} to
 * @param {string} pathHint
 * @param {number} i
 */
function humanStepId(from, to, pathHint, i) {
  // integration-tax-tpc-api-debits-01
  const a = slug(shortRepo(from || "src"));
  const b = slug(shortRepo(to || "dst"));
  const t = slug(pathHint).slice(0, 32);
  return `${a}-to-${b}-${t || "hop"}-${String(i).padStart(2, "0")}`;
}

/**
 * Short display name for a logical_repo.
 * tax-provider-controller → tpc; acme-tax → tax; tax-provider-alt → rj
 * @param {string|undefined} repo
 */
export function shortRepo(repo) {
  if (!repo) return "?";
  const r = String(repo);
  const aliases = {
    "tax-provider-controller": "tpc",
    "tax-provider-alt": "rj",
    "acme-tax": "tax",
  };
  if (aliases[r]) return aliases[r];
  // generic: last segment, strip common prefixes
  const base = r.split("/").pop() || r;
  return base
    .replace(/^tax-provider-/, "")
    .replace(/^acme-/, "")
    .replace(/-service$/, "")
    .replace(/-provider$/, "") || base;
}

/**
 * @param {object[]} edges
 */
function flattenEvidence(edges) {
  /** @type {object[]} */
  const out = [];
  for (const e of edges) {
    for (const ev of e.evidence || []) {
      out.push({
        edge_id: e.edge_id,
        side: ev.side,
        file: ev.file,
        line: ev.line,
        snippet: ev.snippet,
        logical_repo:
          ev.side === "from"
            ? e.from?.logical_repo
            : ev.side === "to"
              ? e.to?.logical_repo
              : undefined,
      });
    }
  }
  return out;
}

/**
 * @param {string} s
 */
function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}
