# V1 Learning Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the V1 coverage-gap memory loop (Auditor C → Observation → Journal → CoverageGap) per the approved spec, closing the learning cycle with deterministic detection, validation, idempotent persistence, gap lifecycle, eval metrics at 1.0, and preserved CLI behavior.

**Architecture:** Seven cohesive tasks. Canonical Observation contract and identity helpers first (audit-owned, reusing only stable-json from explorer-l0). Detection/validation split from omissions.mjs into focused modules. Journal+GapOccurrence tables and store behavior extracted to dedicated learning-loop module wired into openOpsStore. Gap lifecycle via recordOutcome/resolveGap/loadContext. CLI/agent integration additive. Six eval fixture families with exact confusion formulas. Documentation alignment covers only shipped V1 contracts. No .claude/explorer/ KB exists; plan is grounded exclusively in the approved docs/spec/v1-learning-loop.md (commit b001e8b), ADR 0011, glossary, ROADMAP, AGENTS.md, and direct inspection of the listed source files.

**Tech Stack:** Node >=22, native node:test, ESM .mjs, node:sqlite, no added dependencies. Deterministic helpers from skills/explorer-l0/src/stable-json.mjs (stableStringify, sha256Text). Git-pinned byte validation for evidence.

**Spec:** docs/spec/v1-learning-loop.md (approved, Oracle PASS at b001e8b on docs/v1-learning-loop-spec).

## Global Constraints

- Node >=22, ESM .mjs, node:sqlite, node:test only. No new packages.
- Preserve shipped sample/omissions/show/log/list/challenges behavior exactly (user-facing commands).
- Split omissions.mjs; keep as orchestration/backward-compatible adapter. New focused modules for canonical contract and detection/validation.
- Canonical identity helpers stay in audit-owned module; reuse only stableStringify/sha256Text from explorer-l0 stable-json; never import private explorer-query canonical modules.
- Audit-domain and ops-store tracks run in parallel only after canonical Observation contract is merged. Overlapping files (schema.mjs, store.mjs, omissions.mjs, SKILL.md, explorer-auditor.md) force sequencing.
- Evidence validity tested against pinned Git bytes; incomplete FrontierFact coverage cannot auto-confirm.
- Additive SQLite tables only: ops_observations, ops_gap_occurrences, ops_coverage_gaps, ops_gap_status_history. UNIQUE(run_id, observation_id), UNIQUE(run_id, gap_key), durable gap_key, collision rejection, scrub rules, transactional writes, projection rebuild from GapOccurrence.
- recordOutcome: idempotent run retry, insert all valid Observations, promote only AUTO_CONFIRMED/HUMAN_CONFIRMED, no partial writes.
- resolveGap: enforce accepted evidence or explicit human closure.
- loadContext: bounded open/stale summary, never raw history dumps.
- Six eval fixture families (java-call, spring-controller, spring-feign, cross-repo-http, kafka, intentional-omission). Exact confusion-count formulas; N/A denominator when zero positives. Ambiguous outcomes in ground truth. Per-fixture and aggregate metrics = 1.0 or gate fails.
- Auditor C records Observations through explorer-ops; never mutates graph/Human Gate.
- Documentation alignment only for ADR 0011, glossary, explorer-audit SKILL, explorer-ops SKILL, explorer-auditor agent, command sources, and the existing installer acceptance test. README remains unchanged.
- Atomic commits in repository semantic English style.
- No placeholders. No re-opening approved decisions. No Hybrid LSP, Graphify replacement, automatic adapters, self-healing, runtime traces, complete MCP, advanced hooks, new graph DB, remote store, distributed memory, Kafka workflow.

---

## File Responsibility Map

**Audit track (explorer-audit):**
- skills/explorer-audit/src/canonical-observation.mjs (new) — Observation contract, canonicalizeSignal, makeObservationId, makeGapKey.
- skills/explorer-audit/src/detect-observations.mjs (new) — detectObservations, validateObservation, confirmObservation.
- skills/explorer-audit/src/omissions.mjs (modify, keep <160 LOC) — orchestration + backward-compatible report adapter for shipped CLI.
- skills/explorer-audit/test/canonical-observation.test.mjs (new), detect-observations.test.mjs (new) — direct unit tests.
- skills/explorer-audit/test/cli.test.mjs (new) — additive `observations` command tests.
- skills/explorer-audit/SKILL.md, skills/explorer-audit/commands/explorer-audit.md (modify) — additive V1 flow.

**Ops track (explorer-ops):**
- skills/explorer-ops/src/schema.mjs (modify) — additive tables only.
- skills/explorer-ops/src/learning-loop-store.mjs (new) — private persistence primitives + projection rebuild.
- skills/explorer-ops/src/store.mjs (modify) — wire learning-loop into openOpsStore; keep focused.
- skills/explorer-ops/src/learning-loop-api.mjs (new) — public recordOutcome, loadContext, resolveGap.
- skills/explorer-ops/test/learning-loop.test.mjs (new) — transactional/idempotent tests.
- skills/explorer-ops/test/cli.test.mjs (new) — CLI command tests for new ops commands.
- skills/explorer-ops/SKILL.md, skills/explorer-ops/commands/explorer-ops.md (modify) — new commands.

**Eval track (query/eval):**
- skills/explorer-query/src/learning-loop-eval.mjs (new) — six fixture families, confusion formulas, metric computation.
- skills/explorer-query/test/learning-loop-eval.test.mjs (new) — exact 1.0 gate.

**Agent/docs:**
- agents/opencode/explorer-auditor.md (modify) — Auditor C records via ops.
- docs/adr/0011-coverage-gap-memory.md, docs/domain/glossary.md (modify) — vocabulary/state alignment only.
- packages/explorer-skills/test/install.test.mjs (modify) — prove installed command bodies expose the additive flow.

## ASCII Dependency Graph

```
Task 1 (Canonical Observation contract)
  |
  +-- Task 2 (Detection/semantic validation)  [audit track]
  |     |
  |     +-- Task 5 (CLI/agent integration)  [depends on 2+4]
  |
  +-- Task 3 (Journal + projection persistence)  [ops track, parallel after Task 1]
        |
        +-- Task 4 (Gap lifecycle APIs: recordOutcome/resolveGap/loadContext)  [depends on 3]
              |
              +-- Task 6 (Blocking eval fixtures/metrics)  [depends on 2+4]
                    |
                    +-- Task 7 (Documentation + package acceptance)  [depends on 5+6]
```

**Parallelism rule:** Audit Task 2 and ops Task 3 may run in parallel worktrees ONLY after Task 1 merge. Task 4 depends on Task 3. Task 5 depends on Task 2 AND Task 4. Task 6 depends on Task 2 AND Task 4. Task 7 depends on Tasks 5 and 6. Files schema.mjs, store.mjs, omissions.mjs, SKILL.md, explorer-auditor.md overlap → sequential within track. No file overlap between clean audit modules and ops modules.

## Task 1: Canonical Observation Contract

**Files:**
- Create: skills/explorer-audit/src/canonical-observation.mjs
- Test: skills/explorer-audit/test/canonical-observation.test.mjs

**Interfaces (exact one-parameter JSDoc shapes):**

```js
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

/**
 * canonicalizeSignal({capability, fields}) -> {signal_key: SignalKey, target_signature: string, complete: boolean}
 * isCompleteSignal(signal_key: SignalKey) -> boolean
 * makeObservationId({capability, target_signature, source_evidence_identity: SourceEvidenceIdentity, source_revision?: string, line?: number}) -> string
 * makeGapKey({reason, scope: GapScope, capability, target_signature}) -> string
 */
```

- [ ] **Step 1: Write failing test for stable hash, canonical field order, exclusion of revision/line by destructuring extra metadata**

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeObservationId, canonicalizeSignal, makeGapKey } from "../src/canonical-observation.mjs";

test("canonicalizeSignal produces target_signature via stableStringify of signal_key", () => {
  const input = {capability: "java-call", fields: {class: "C", method: "m", params: "String"}};
  const out = canonicalizeSignal(input);
  assert.equal(out.target_signature, '{"capability":"java-call","fields":{"class":"C","method":"m","params":"String"}}');
  assert.equal(out.signal_key.capability, "java-call");
  assert.equal(out.complete, true);
});

test("canonicalizeSignal rejects unknown, missing and extra fields", () => {
  assert.throws(() => canonicalizeSignal({capability: "unknown", fields: {name: "x"}}), /unknown capability/);
  assert.throws(() => canonicalizeSignal({capability: "kafka", fields: {topic: "orders", direction: "publish"}}), /expected fields/);
  assert.throws(() => canonicalizeSignal({capability: "kafka", fields: {topic: "orders", direction: "publish", client: "bus", extra: "x"}}), /expected fields/);
});

test("canonicalizeSignal preserves an incomplete known signal for UNKNOWN classification", () => {
  const out = canonicalizeSignal({capability: "kafka", fields: {topic: "orders", direction: "publish", client: ""}});
  assert.equal(out.complete, false);
});

test("makeObservationId excludes revision and line from identity by destructuring only declared fields", () => {
  const base = {capability: "java-call", target_signature: '{"class":"C","method":"m"}', source_evidence_identity: {logical_repo: "r", relative_file: "f.java", source_anchor: "C.m"}};
  const id1 = makeObservationId(Object.assign({}, base, {source_revision: "abc", line: 42}));
  const id2 = makeObservationId(Object.assign({}, base, {source_revision: "def", line: 99}));
  assert.equal(id1, id2);
});

test("makeGapKey is deterministic hash of reason+scope+capability+target_signature", () => {
  const scope = {namespace: "ns", logical_repos: ["checkout"]};
  const k1 = makeGapKey({reason: "missing-frontier-fact", scope, capability: "kafka", target_signature: '{"topic":"t"}'});
  const k2 = makeGapKey({reason: "missing-frontier-fact", scope, capability: "kafka", target_signature: '{"topic":"t"}'});
  assert.equal(k1, k2);
});
```

Run: `node --test skills/explorer-audit/test/canonical-observation.test.mjs`

Expected: FAIL (function not defined)

- [ ] **Step 2: Implement pure canonicalizeSignal/makeObservationId/makeGapKey using only stableStringify + sha256Text; define exact closed signal variants; target_signature = stableStringify(signal_key)**

```js
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
```

- [ ] **Step 3: Run test to verify pass**

Run: `node --test skills/explorer-audit/test/canonical-observation.test.mjs`

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add skills/explorer-audit/src/canonical-observation.mjs skills/explorer-audit/test/canonical-observation.test.mjs
git commit -m "feat(audit): add canonical Observation contract with exact closed signal variants and pure identity helpers"
```

## Task 2: Detection and Semantic Validation

**Files:**
- Create: skills/explorer-audit/src/detect-observations.mjs
- Modify: skills/explorer-audit/src/omissions.mjs (split orchestration only, preserve shipped sample/omissions/show outputs)
- Test: skills/explorer-audit/test/detect-observations.test.mjs

**Interfaces:**

```js
/** @typedef {import("./canonical-observation.mjs").Observation} Observation */

/**
 * @param {{namespace: string, run_id: string, repo_path: string, revision: string, logical_repo: string, frontier_report: {facts: object[], files_scanned: number, files_total: number}}} input
 * @returns {Observation[]}
 */
export function detectObservations(input) {}

/**
 * @param {{observation: Observation, frontier_facts: object[]}} input
 * @returns {Observation}
 */
export function validateObservation(input) {}

/**
 * @param {{observation: Observation, frontier_facts: object[], frontier_complete: boolean, repo_path: string}} input
 * @returns {Observation}
 */
export function confirmObservation(input) {}
```

| Capability | Detecção em fonte pinada | Comparação semântica V1 | Auto-confirmação V1 |
|---|---|---|---|
| `java-call` | chamada estática `Classe.metodo(args)` | indisponível no FrontierFact atual | não |
| `spring-controller` | `*Mapping` + classe/método | incompleta: falta `annotation` | não |
| `spring-feign` | `@FeignClient` + mapping | incompleta: falta `client` | não |
| `cross-repo-http` | chamada HTTP + contract key normalizada | `logical_repo + contract_key` | sim |
| `kafka` | listener/template + tópico/direção/cliente | incompleta: falta `client` | não |
| `intentional-omission` | não é detector automático | decisão humana/eval | não |

`frontier_complete` só pode ser `true` quando `inspectRepoFrontier` terminou para
a mesma revisão pinada e entregou seu conjunto integral de `facts`. Falha de Git,
relatório ausente ou revisão divergente força `NEEDS_REVIEW`.

- [ ] **Step 1: Criar repo Git temporário e escrever testes falhando para detecção pinada**

Adicione estes helpers locais ao teste; eles inicializam `main`, escrevem os
arquivos, fazem commit e capturam `HEAD` sem depender de estado externo:

```js
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function git(cwd, args) {
  return execFileSync("git", args, {cwd, encoding: "utf8", shell: false}).trim();
}

function makeRepo(files) {
  const cwd = mkdtempSync(join(tmpdir(), "audit-observation-"));
  git(cwd, ["init", "-q", "-b", "main"]);
  for (const [relativeFile, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, relativeFile)), {recursive: true});
    writeFileSync(join(cwd, relativeFile), body);
  }
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.email=t@t", "-c", "user.name=T", "commit", "-q", "-m", "fixture"]);
  return {cwd, head: git(cwd, ["rev-parse", "HEAD"])};
}
```

Teste um arquivo por família:

```js
test("detectObservations derives source_revision and source_anchor from committed bytes", () => {
  const repo = makeRepo({
    "src/BillingClient.kt": '@FeignClient(name="billing")\ninterface BillingClient {\n@GetMapping("/invoices/{id}")\nfun get(id: String): Invoice\n}',
  });
  const observations = detectObservations({
    namespace: "ns",
    run_id: "run-1",
    repo_path: repo.cwd,
    revision: repo.head,
    logical_repo: "checkout",
    frontier_report: {facts: [], files_scanned: 1, files_total: 1},
  });
  const feign = observations.find((item) => item.capability === "spring-feign");
  assert.equal(feign.source_revision, repo.head);
  assert.equal(feign.relative_file, "src/BillingClient.kt");
  assert.equal(feign.source_anchor, "BillingClient#get");
});
```

Run: `node --test skills/explorer-audit/test/detect-observations.test.mjs`

Expected: FAIL com `detectObservations` ausente.

- [ ] **Step 2: Escrever a matriz de testes de validação e confirmação**

Defina o builder local usado pelos casos. O builder sempre recalcula identidade
e gap a partir dos campos efetivos, evitando fixtures internamente divergentes:

```js
function crossRepoObservation(overrides = {}) {
  const fields = overrides.fields ?? {
    from_logical_repo: "checkout",
    to_contract_key: "GET /invoices/{param}",
  };
  const canonical = canonicalizeSignal({capability: "cross-repo-http", fields});
  const gap_scope = {namespace: "ns", logical_repos: ["checkout"]};
  const base = {
    run_id: "run-1",
    capability: "cross-repo-http",
    signal_key: canonical.signal_key,
    target_signature: canonical.target_signature,
    logical_repo: "checkout",
    relative_file: "src/Client.kt",
    source_anchor: "Client#fetch",
    source_revision: "fixture-revision",
    line: 2,
    evidence_snippet: 'fun fetch() = RestTemplate().getForObject("/invoices/{id}", Invoice::class.java)',
    coverage_classification: canonical.complete ? "POSSIBLE_OMISSION" : "UNKNOWN",
    confirmation_status: "NEEDS_REVIEW",
    gap_reason: "missing-frontier-fact",
    gap_scope,
  };
  const merged = Object.assign({}, base, overrides, {signal_key: canonical.signal_key, target_signature: canonical.target_signature});
  merged.observation_id = makeObservationId({
    capability: merged.capability,
    target_signature: merged.target_signature,
    source_evidence_identity: {
      logical_repo: merged.logical_repo,
      relative_file: merged.relative_file,
      source_anchor: merged.source_anchor,
    },
  });
  merged.gap_key = makeGapKey({reason: merged.gap_reason, scope: merged.gap_scope, capability: merged.capability, target_signature: merged.target_signature});
  return merged;
}
```

Adicione casos separados, sem combinar falhas:

```js
test("exact cross-repo signal is COVERED and NOT_APPLICABLE", () => {
  const observation = crossRepoObservation({line: 12});
  const fact = {kind: "http_outbound", logical_repo: "checkout", contract_key: "GET /invoices/{param}", file: observation.relative_file, line: 40};
  const actual = validateObservation({observation, frontier_facts: [fact]});
  assert.equal(actual.coverage_classification, "COVERED");
  assert.equal(actual.confirmation_status, "NOT_APPLICABLE");
});

test("line proximity without target signature is MAYBE_COVERED and NEEDS_REVIEW", () => {
  const observation = crossRepoObservation({line: 12});
  const fact = {kind: "http_outbound", logical_repo: "checkout", contract_key: "POST /other", file: observation.relative_file, line: 10};
  const actual = validateObservation({observation, frontier_facts: [fact]});
  assert.equal(actual.coverage_classification, "MAYBE_COVERED");
  assert.equal(actual.confirmation_status, "NEEDS_REVIEW");
});

test("complete cross-repo semantic absence is AUTO_CONFIRMED", () => {
  const repo = makeRepo({"src/Client.kt": 'class Client {\n  fun fetch() = RestTemplate().getForObject("/invoices/{id}", Invoice::class.java)\n}\n'});
  const observation = crossRepoObservation({line: 2, source_revision: repo.head});
  const actual = confirmObservation({observation, frontier_facts: [], frontier_complete: true, repo_path: repo.cwd});
  assert.equal(actual.coverage_classification, "POSSIBLE_OMISSION");
  assert.equal(actual.confirmation_status, "AUTO_CONFIRMED");
  rmSync(repo.cwd, {recursive: true, force: true});
});
```

Acrescente quatro testes que esperam `NEEDS_REVIEW`: `frontier_complete=false`,
Git read falha, `source_anchor` não é reproduzível e capability é
`java-call`. Para o `cross-repo-http` conhecido com
`to_contract_key: ""`, espere `coverage_classification` `UNKNOWN` e
`confirmation_status` `NEEDS_REVIEW`.

Run: `node --test skills/explorer-audit/test/detect-observations.test.mjs`

Expected: FAIL até as três funções existirem.

- [ ] **Step 3: Implementar detectores fechados e classificação fail-closed**

Em `detect-observations.mjs`, mantenha um detector por capability no mesmo
módulo, normalize HTTP com `contractKey`/`normalizeHttpPath` existentes e use
`execFileSync("git", ["-C", repoPath, "show", `${revision}:${relativeFile}`])`
com argumentos separados. A sequência é:
detectar -> `canonicalizeSignal` -> `makeObservationId` ->
`validateObservation` -> `confirmObservation`. Nunca use nome parecido como
match e nunca transforme proximidade em confirmação. Quando a ausência for
semântica, preencha `gap_reason: "missing-frontier-fact"`,
`gap_scope: {namespace, logical_repos: [logical_repo]}` e derive `gap_key` com
`makeGapKey`. `confirmObservation` só retorna `AUTO_CONFIRMED` para
`cross-repo-http` quando o sinal está completo, o Git reproduz exatamente
capability/signal/source_anchor e `frontier_report.files_scanned ===
frontier_report.files_total` na mesma revisão; todas as demais capabilities
ficam `NEEDS_REVIEW` até decisão humana.

- [ ] **Step 4: Preservar o adapter existente**

Faça `omissions.mjs` chamar o novo detector apenas para o novo relatório de
Observations. Mantenha `classifyHit`, `coveredByFact`, `scanOmissions`, a shape
`{counts, omissions}` e os testes atuais sem alteração de saída.

Run: `node --test skills/explorer-audit/test/omissions.test.mjs skills/explorer-audit/test/detect-observations.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/explorer-audit/src/detect-observations.mjs skills/explorer-audit/src/omissions.mjs skills/explorer-audit/test/detect-observations.test.mjs
git commit -m "feat(audit): add semantic Observation detection"
```

## Task 3: Journal + Projection Persistence

**Files:**
- Modify: skills/explorer-ops/src/schema.mjs (additive tables only)
- Create: skills/explorer-ops/src/learning-loop-store.mjs (private primitives only)
- Modify: skills/explorer-ops/src/store.mjs (wire into openOpsStore)
- Create: skills/explorer-ops/test/learning-loop.test.mjs

**Exact additive DDL (no DROP, enough columns for all Observation/CoverageGap fields, FKs, CHECK, UNIQUE, canonical payload hash, source_revision metadata, observed_at, status history):**

```sql
CREATE TABLE IF NOT EXISTS ops_observations (
  run_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN ('java-call','spring-controller','spring-feign','cross-repo-http','kafka','intentional-omission')),
  signal_key_json TEXT NOT NULL,
  target_signature TEXT NOT NULL,
  logical_repo TEXT NOT NULL,
  relative_file TEXT NOT NULL,
  source_anchor TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  line INTEGER NOT NULL,
  evidence_snippet TEXT NOT NULL,
  coverage_classification TEXT NOT NULL CHECK (coverage_classification IN ('COVERED','MAYBE_COVERED','POSSIBLE_OMISSION','UNKNOWN')),
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('NOT_APPLICABLE','AUTO_CONFIRMED','NEEDS_REVIEW','HUMAN_CONFIRMED','REJECTED')),
  gap_reason TEXT,
  gap_scope_json TEXT,
  gap_key TEXT,
  canonical_payload_json TEXT NOT NULL,
  canonical_payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, observation_id),
  FOREIGN KEY (run_id) REFERENCES ops_runs(run_id)
);

CREATE TABLE IF NOT EXISTS ops_coverage_gaps (
  gap_key TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  capability TEXT NOT NULL,
  target_signature TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','stale','resolved','superseded')),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_gap_occurrences (
  run_id TEXT NOT NULL,
  gap_key TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (run_id, gap_key),
  FOREIGN KEY (run_id, observation_id)
    REFERENCES ops_observations(run_id, observation_id),
  FOREIGN KEY (gap_key) REFERENCES ops_coverage_gaps(gap_key)
);

CREATE TABLE IF NOT EXISTS ops_gap_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gap_key TEXT NOT NULL,
  run_id TEXT,
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('open','stale','resolved','superseded')),
  to_status TEXT NOT NULL CHECK (to_status IN ('open','stale','resolved','superseded')),
  source_revision TEXT,
  transition_reason TEXT NOT NULL,
  evidence_ref TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (gap_key) REFERENCES ops_coverage_gaps(gap_key),
  FOREIGN KEY (run_id) REFERENCES ops_runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_ops_observations_gap ON ops_observations(gap_key);
CREATE INDEX IF NOT EXISTS idx_ops_gap_occurrences_gap ON ops_gap_occurrences(gap_key);
CREATE INDEX IF NOT EXISTS idx_ops_coverage_gaps_status ON ops_coverage_gaps(status);
```

- [ ] **Step 1: Escrever testes falhando para schema, colisão e projeção**

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOpsStore, OpsStoreError } from "../src/store.mjs";
import { createLearningLoopPersistence } from "../src/learning-loop-store.mjs";
import { canonicalizeSignal, makeGapKey } from "../../explorer-audit/src/canonical-observation.mjs";

function persistedObservation(overrides = {}) {
  const canonical = canonicalizeSignal({
    capability: "cross-repo-http",
    fields: {
      from_logical_repo: "checkout",
      to_contract_key: overrides.to_contract_key ?? "GET /invoices/{param}",
    },
  });
  const base = {
    run_id: "run-1",
    observation_id: "obs-1",
    capability: "cross-repo-http",
    signal_key: canonical.signal_key,
    target_signature: canonical.target_signature,
    logical_repo: "checkout",
    relative_file: "src/Client.kt",
    source_anchor: "Client#fetch",
    source_revision: "rev-1",
    line: 10,
    evidence_snippet: "RestTemplate.getForObject",
    coverage_classification: "POSSIBLE_OMISSION",
    confirmation_status: "AUTO_CONFIRMED",
    gap_reason: "missing-frontier-fact",
    gap_scope: {namespace: "ns", logical_repos: ["checkout"]},
    observed_at: "2026-09-01T10:00:00.000Z",
  };
  const merged = Object.assign({}, base, overrides, {signal_key: canonical.signal_key, target_signature: canonical.target_signature});
  if (merged.confirmation_status === "AUTO_CONFIRMED" || merged.confirmation_status === "HUMAN_CONFIRMED") {
    merged.gap_key = makeGapKey({reason: merged.gap_reason, scope: merged.gap_scope, capability: merged.capability, target_signature: merged.target_signature});
  }
  return merged;
}

function seedTwoRunsForOneGap(store, persistence) {
  store.log({run_id: "run-1", namespace: "ns", phase: "audit", status: "ok", logical_repos: ["checkout"]});
  store.log({run_id: "run-2", namespace: "ns", phase: "audit", status: "ok", logical_repos: ["checkout"]});
  const first = persistedObservation({run_id: "run-1", observation_id: "obs-1", source_revision: "rev-1", observed_at: "2026-09-01T10:00:00.000Z"});
  const second = persistedObservation({run_id: "run-2", observation_id: "obs-2", source_revision: "rev-2", observed_at: "2026-09-01T11:00:00.000Z"});
  persistence.insertOrCompareObservation(first);
  persistence.insertOrCompareObservation(second);
  persistence.ensureCoverageGap({gap_key: first.gap_key, reason: first.gap_reason, scope: first.gap_scope, capability: first.capability, target_signature: first.target_signature, observed_at: first.observed_at});
  persistence.insertGapOccurrence({run_id: first.run_id, gap_key: first.gap_key, observation_id: first.observation_id, source_revision: first.source_revision, observed_at: first.observed_at});
  persistence.insertGapOccurrence({run_id: second.run_id, gap_key: second.gap_key, observation_id: second.observation_id, source_revision: second.source_revision, observed_at: second.observed_at});
  return first.gap_key;
}

test("additive tables created without dropping existing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-loop-"));
  const store = openOpsStore(join(dir, "ops.sqlite"));
  const tables = store._db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  assert.ok(tables.includes("ops_observations"));
  assert.ok(tables.includes("ops_runs"));
  assert.ok(tables.includes("ops_gap_occurrences"));
  assert.ok(tables.includes("ops_coverage_gaps"));
  assert.ok(tables.includes("ops_gap_status_history"));
  store.close();
});

test("same observation payload is idempotent and divergent payload collides", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-loop-"));
  const store = openOpsStore(join(dir, "ops.sqlite"));
  store.log({run_id: "run-1", phase: "audit", status: "ok"});
  const persistence = createLearningLoopPersistence(store._db);
  const observation = persistedObservation({run_id: "run-1", observation_id: "obs-1", line: 10});
  assert.equal(persistence.insertOrCompareObservation(observation).created, true);
  assert.equal(persistence.insertOrCompareObservation(observation).created, false);
  assert.throws(
    () => persistence.insertOrCompareObservation(Object.assign({}, observation, {line: 11})),
    OpsStoreError,
  );
  store.close();
});

test("projection is rebuilt only from GapOccurrence", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-loop-"));
  const store = openOpsStore(join(dir, "ops.sqlite"));
  const persistence = createLearningLoopPersistence(store._db);
  const gapKey = seedTwoRunsForOneGap(store, persistence);
  persistence.rebuildGapProjection(gapKey);
  const gap = store._db.prepare("SELECT first_seen, last_seen, occurrences FROM ops_coverage_gaps WHERE gap_key = ?").get(gapKey);
  assert.deepEqual(gap, {first_seen: "2026-09-01T10:00:00.000Z", last_seen: "2026-09-01T11:00:00.000Z", occurrences: 2});
  store.close();
});
```

Run: `node --test skills/explorer-ops/test/learning-loop.test.mjs`

Expected: FAIL

- [ ] **Step 2: Aplicar schema aditivo e ativar FKs**

Acrescente o DDL acima a `SCHEMA_SQL` e execute `PRAGMA foreign_keys = ON` em
`openOpsStore`. Não altere nem migre os campos de `ops_runs` e
`ops_challenges`.

- [ ] **Step 3: Implementar primitivas privadas**

`createLearningLoopPersistence(db)` retorna exatamente:
`insertOrCompareRun`, `insertOrCompareObservation`, `ensureCoverageGap`, `insertGapOccurrence`,
`rebuildGapProjection`, `appendGapHistory`, `markAffectedGapsStale`,
`getCoverageGap`, `updateGapStatus` e `listContextGaps`. Os parâmetros fechados
são:

```js
insertOrCompareRun({run_id, namespace, phase, status, logical_repos, source_revision, started_at})
insertOrCompareObservation(observation)
ensureCoverageGap({gap_key, reason, scope, capability, target_signature, observed_at})
insertGapOccurrence({run_id, gap_key, observation_id, source_revision, observed_at})
rebuildGapProjection(gap_key)
appendGapHistory({gap_key, run_id, from_status, to_status, source_revision, transition_reason, evidence_ref, created_at})
markAffectedGapsStale({run_id, scope, source_revision, observed_at})
getCoverageGap(gap_key)
updateGapStatus({gap_key, expected_statuses, to_status})
listContextGaps({scope, limit})
```

`insertOrCompareRun` persiste `source_revision` em
`detail_json = stableStringify({source_revision})` e compara, no retry, todos os
campos canônicos da run; não chama `store.log`, que continua insert-only para o
comando legado. Toda comparação de Observation usa `canonical_payload_json`
byte a byte depois de `stableStringify`; hash igual não substitui a comparação.
`insertGapOccurrence` usa `INSERT OR IGNORE` e retorna se criou a ocorrência.
`ensureCoverageGap` recalcula e verifica `gap_key` antes do insert. Os três
campos `gap_reason`, `gap_scope` e `gap_key` são obrigatórios para
`AUTO_CONFIRMED`/`HUMAN_CONFIRMED`; podem permanecer em `NEEDS_REVIEW` como
candidato auditável para decisão humana, mas jamais promovem gap nesse estado.
`recordOutcome` usa `run.started_at` como `created_at` da Observation e
`observed_at` da GapOccurrence, evitando timestamps diferentes em retries.

- [ ] **Step 4: Expor a factory ao store sem criar outro banco**

Instancie a persistência com o mesmo `DatabaseSync` aberto por `openOpsStore`.
Task 4 conectará os métodos públicos; Task 3 não expõe microsteps no CLI.

- [ ] **Step 5: Rodar os testes focados**

Run: `node --test skills/explorer-ops/test/learning-loop.test.mjs`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add skills/explorer-ops/src/schema.mjs skills/explorer-ops/src/learning-loop-store.mjs skills/explorer-ops/src/store.mjs skills/explorer-ops/test/learning-loop.test.mjs
git commit -m "feat(ops): persist Observations and gap occurrences"
```

## Task 4: Gap Lifecycle APIs

**Files:**
- Create: skills/explorer-ops/src/learning-loop-api.mjs
- Test: skills/explorer-ops/test/learning-loop.test.mjs (extend)

**Contratos públicos:**

```js
/**
 * @param {Object} input
 * @param {{run_id: string, namespace: string, phase: string, status: string, logical_repos: string[], source_revision: string, started_at: string}} input.run
 * @param {Observation[]} input.observations
 * @returns {{run_id: string, observations_created: number, observations_reused: number, gap_occurrences_created: number}}
 */
export function recordOutcome(input) {}

/**
 * @param {Object} input
 * @param {{namespace: string, logical_repos: string[]}} input.scope
 * @param {string} input.objective
 * @param {number} [input.limit]
 * @returns {{objective: string, gaps: Array<{gap_key: string, reason: string, capability: string, status: "open"|"stale", occurrences: number, last_seen: string}>}}
 */
export function loadContext(input) {}

/**
 * @param {Object} input
 * @param {string} input.gap_key
 * @param {"resolved"|"superseded"} input.resolution
 * @param {string} [input.accepted_evidence_ref]
 * @param {{actor: string, reason: string}} [input.human_closure]
 * @param {string} [input.replacement_gap_key]
 * @returns {{gap_key: string, previous_status: "open"|"stale", status: "resolved"|"superseded"}}
 */
export function resolveGap(input) {}
```

`openOpsStore` expõe esses três métodos ligados ao mesmo DB. `recordOutcome`
abre uma única `BEGIN IMMEDIATE`: compara/cria a run, persiste todas as
Observations, garante CoverageGap apenas para `AUTO_CONFIRMED` e
`HUMAN_CONFIRMED`, cria no máximo uma ocorrência por `(run_id, gap_key)`,
reconstrói a projeção e grava transições. Qualquer erro faz `ROLLBACK`.
Antes de inserir as Observations, `recordOutcome` chama
`markAffectedGapsStale`: para cada gap `open` cujo `scope_json.namespace` é o da
run, cujo `logical_repos` intersecta os da run e cuja última ocorrência tem
`source_revision` diferente, muda para `stale` e registra histórico. A mesma
transação reabre o gap se uma ocorrência confirmada for gravada. Uma run sem
ocorrência deixa o gap em `stale`; nunca resolve automaticamente.

- [ ] **Step 1: Escrever testes falhando para retry, rollback e promoção**

No topo do mesmo `learning-loop.test.mjs`, acrescente os builders exatos usados
pelos testes da Task 4:

```js
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "ops-loop-api-"));
  return openOpsStore(join(dir, "ops.sqlite"));
}

function reviewObservation(overrides = {}) {
  return persistedObservation(Object.assign({gap_reason: undefined, gap_scope: undefined, gap_key: undefined, coverage_classification: "MAYBE_COVERED", confirmation_status: "NEEDS_REVIEW"}, overrides));
}

function coveredObservation(overrides = {}) {
  return persistedObservation(Object.assign({observation_id: "obs-covered", gap_reason: undefined, gap_scope: undefined, gap_key: undefined, coverage_classification: "COVERED", confirmation_status: "NOT_APPLICABLE"}, overrides));
}

function confirmedObservation(overrides = {}) {
  return persistedObservation(Object.assign({coverage_classification: "POSSIBLE_OMISSION", confirmation_status: "AUTO_CONFIRMED"}, overrides));
}

function outcomeInput(overrides = {}) {
  const run_id = overrides.run_id ?? "run-1";
  return {
    run: {run_id, namespace: "ns", phase: "audit", status: "ok", logical_repos: ["checkout"], source_revision: overrides.source_revision ?? "rev-1", started_at: overrides.started_at ?? "2026-09-01T10:00:00.000Z"},
    observations: overrides.observations ?? [],
  };
}

function seededOpenGapStore() {
  const store = makeStore();
  const observation = confirmedObservation();
  store.recordOutcome(outcomeInput({observations: [observation]}));
  return {store, gap_key: observation.gap_key};
}

function seededContextStore(count) {
  const store = makeStore();
  const observations = Array.from({length: count}, (_, index) => confirmedObservation({
    observation_id: `obs-${index}`,
    to_contract_key: `GET /invoices/${index}`,
    source_anchor: `Client#fetch${index}`,
  }));
  store.recordOutcome(outcomeInput({observations}));
  return store;
}
```

```js
test("recordOutcome reuses identical retry without a second occurrence", () => {
  const store = makeStore();
  const input = outcomeInput({run_id: "run-1", observations: [confirmedObservation({observation_id: "obs-1"})]});
  const first = store.recordOutcome(input);
  const retry = store.recordOutcome(input);
  assert.equal(first.gap_occurrences_created, 1);
  assert.equal(retry.gap_occurrences_created, 0);
  assert.equal(store._db.prepare("SELECT COUNT(*) AS n FROM ops_gap_occurrences").get().n, 1);
  store.close();
});

test("divergent retry rolls back every row from that call", () => {
  const store = makeStore();
  store.recordOutcome(outcomeInput({run_id: "run-1", observations: [reviewObservation({observation_id: "obs-1", line: 10})]}));
  assert.throws(
    () => store.recordOutcome(outcomeInput({run_id: "run-1", observations: [reviewObservation({observation_id: "obs-1", line: 11}), reviewObservation({observation_id: "obs-2", line: 20})]})),
    OpsStoreError,
  );
  assert.equal(store._db.prepare("SELECT COUNT(*) AS n FROM ops_observations").get().n, 1);
  store.close();
});

test("only automatic or human confirmation creates gaps", () => {
  const store = makeStore();
  const confirmed = confirmedObservation({observation_id: "obs-auto"});
  store.recordOutcome(outcomeInput({run_id: "run-1", observations: [coveredObservation(), reviewObservation({observation_id: "obs-review", line: 8}), confirmed]}));
  const keys = store._db.prepare("SELECT gap_key FROM ops_coverage_gaps ORDER BY gap_key").all().map((row) => row.gap_key);
  assert.deepEqual(keys, [confirmed.gap_key]);
  store.close();
});
```

Run: `node --test skills/explorer-ops/test/learning-loop.test.mjs`

Expected: FAIL porque os métodos públicos ainda não existem.

- [ ] **Step 2: Escrever testes falhando para estados e contexto**

Cubra exatamente: novo gap `open`; nova revisão torna gap afetado `stale`;
ocorrência confirmada reabre `stale`, `resolved` ou `superseded`; ausência de
ocorrência não resolve; `resolved` exige evidência relativa aceita ou
`human_closure`; `superseded` também exige `replacement_gap_key`; `limit` usa
20 por padrão, rejeita valor menor que 1 e limita em 50; `loadContext` retorna
somente `open`/`stale` e nunca histórico bruto.

```js
test("resolveGap rejects closure without evidence or human decision", () => {
  const {store, gap_key} = seededOpenGapStore();
  assert.throws(() => store.resolveGap({gap_key, resolution: "resolved"}), OpsStoreError);
  assert.equal(store.resolveGap({gap_key, resolution: "resolved", accepted_evidence_ref: "src/Client.kt#Client.call"}).status, "resolved");
  store.close();
});

test("loadContext returns a bounded open and stale summary", () => {
  const store = seededContextStore(60);
  const result = store.loadContext({scope: {namespace: "ns", logical_repos: ["checkout"]}, objective: "audit coverage", limit: 50});
  assert.equal(result.gaps.length, 50);
  assert.ok(result.gaps.every((gap) => gap.status === "open" || gap.status === "stale"));
  assert.equal(Object.hasOwn(result, "history"), false);
  store.close();
});
```

- [ ] **Step 3: Implementar API e ligar ao store**

`createLearningLoopApi(db, persistence)` implementa os três contratos e retorna
os métodos que `openOpsStore` espalha no objeto público. Valide que
`accepted_evidence_ref` é uma Repository Reference relativa e scrubada. Registre
cada mudança em `ops_gap_status_history`, incluindo `source_revision` quando a
transição vier de `recordOutcome`.

- [ ] **Step 4: Rodar testes focados e regressão do journal**

Run: `node --test skills/explorer-ops/test/store.test.mjs skills/explorer-ops/test/learning-loop.test.mjs`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add skills/explorer-ops/src/learning-loop-api.mjs skills/explorer-ops/src/store.mjs skills/explorer-ops/test/learning-loop.test.mjs
git commit -m "feat(ops): add CoverageGap lifecycle API"
```

## Task 5: CLI and Agent Integration

**Files:**
- Modify: skills/explorer-audit/cli.mjs
- Modify: skills/explorer-audit/commands/explorer-audit.md, skills/explorer-audit/SKILL.md
- Modify: skills/explorer-ops/cli.mjs
- Modify: skills/explorer-ops/commands/explorer-ops.md, skills/explorer-ops/SKILL.md
- Modify: agents/opencode/explorer-auditor.md
- Create: skills/explorer-ops/test/cli.test.mjs, skills/explorer-audit/test/cli.test.mjs (additive)
- Modify: packages/explorer-skills/test/install.test.mjs

**CLI aditivo:**

```bash
REVISION=$(git -C /tmp/checkout rev-parse HEAD)
OPS_DB=/tmp/explorer-ops.sqlite
node skills/explorer-audit/cli.mjs observations --namespace ns --run-id run-1 --repos checkout=/tmp/checkout --revision "$REVISION"
node skills/explorer-ops/cli.mjs record-outcome --db "$OPS_DB" --input-json "{\"run\":{\"run_id\":\"run-1\",\"namespace\":\"ns\",\"phase\":\"audit\",\"status\":\"ok\",\"logical_repos\":[\"checkout\"],\"source_revision\":\"$REVISION\",\"started_at\":\"2026-09-01T10:00:00.000Z\"},\"observations\":[]}"
node skills/explorer-ops/cli.mjs load-context --db "$OPS_DB" --scope-json '{"namespace":"ns","logical_repos":["checkout"]}' --objective 'audit coverage' --limit 20
node skills/explorer-ops/cli.mjs resolve-gap --db "$OPS_DB" --gap-key 8f2d1f0e --resolution resolved --accepted-evidence-ref 'src/Client.kt#Client.call'
```

`REVISION` e `OPS_DB` são valores gerados pelo operador. `--input-json` recebe
JSON literal, não filename. `repo_path` serve somente à leitura do audit e
nunca entra no payload de Observation.

- [ ] **Step 1: Escrever testes falhando para os comandos novos**

Em `skills/explorer-ops/test/cli.test.mjs`, defina a fixture com contratos de
produção, sem copiar hashes manualmente:

```js
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeSignal, makeGapKey, makeObservationId } from "../../explorer-audit/src/canonical-observation.mjs";

function cliOutcomeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "ops-cli-loop-"));
  const db = join(dir, "ops.sqlite");
  const canonical = canonicalizeSignal({capability: "cross-repo-http", fields: {from_logical_repo: "checkout", to_contract_key: "GET /invoices/{param}"}});
  const gap_scope = {namespace: "ns", logical_repos: ["checkout"]};
  const observation = {
    run_id: "run-1",
    capability: "cross-repo-http",
    signal_key: canonical.signal_key,
    target_signature: canonical.target_signature,
    logical_repo: "checkout",
    relative_file: "src/Client.kt",
    source_anchor: "Client#fetch",
    source_revision: "rev-1",
    line: 2,
    evidence_snippet: "RestTemplate.getForObject",
    coverage_classification: "POSSIBLE_OMISSION",
    confirmation_status: "AUTO_CONFIRMED",
    gap_reason: "missing-frontier-fact",
    gap_scope,
    observed_at: "2026-09-01T10:00:00.000Z",
  };
  observation.observation_id = makeObservationId({capability: observation.capability, target_signature: observation.target_signature, source_evidence_identity: {logical_repo: observation.logical_repo, relative_file: observation.relative_file, source_anchor: observation.source_anchor}});
  observation.gap_key = makeGapKey({reason: observation.gap_reason, scope: observation.gap_scope, capability: observation.capability, target_signature: observation.target_signature});
  return {db, input: {run: {run_id: "run-1", namespace: "ns", phase: "audit", status: "ok", logical_repos: ["checkout"], source_revision: "rev-1", started_at: "2026-09-01T10:00:00.000Z"}, observations: [observation]}};
}
```

Em `skills/explorer-audit/test/cli.test.mjs`, copie `git` e `makeRepo` da Task
2 e acrescente este wrapper local:

```js
function makeAuditCliRepo() {
  return makeRepo({
    "src/Client.kt": 'class Client {\n  fun fetch() = RestTemplate().getForObject("/invoices/{id}", Invoice::class.java)\n}\n',
  });
}
```

```js
test("record-outcome accepts literal JSON and load-context reads the promoted gap", () => {
  const fixture = cliOutcomeFixture();
  const recorded = spawnSync("node", ["skills/explorer-ops/cli.mjs", "record-outcome", "--db", fixture.db, "--input-json", JSON.stringify(fixture.input)], {encoding: "utf8"});
  assert.equal(recorded.status, 0, recorded.stderr);
  const loaded = spawnSync("node", ["skills/explorer-ops/cli.mjs", "load-context", "--db", fixture.db, "--scope-json", JSON.stringify({namespace: "ns", logical_repos: ["checkout"]}), "--objective", "audit coverage", "--limit", "20"], {encoding: "utf8"});
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(JSON.parse(loaded.stdout).gaps[0].gap_key, fixture.input.observations[0].gap_key);
});

test("observations reads the pinned repository and omits repo_path from output", () => {
  const repo = makeAuditCliRepo();
  const result = spawnSync("node", ["skills/explorer-audit/cli.mjs", "observations", "--namespace", "ns", "--run-id", "run-1", "--repos", `checkout=${repo.cwd}`, "--revision", repo.head], {encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.observations.length > 0);
  assert.equal(JSON.stringify(payload).includes(repo.cwd), false);
});
```

Run: `node --test skills/explorer-audit/test/cli.test.mjs skills/explorer-ops/test/cli.test.mjs`

Expected: FAIL porque os novos switch cases ainda não existem.

- [ ] **Step 2: Implementar parsing e códigos de saída**

Audit `observations` reutiliza `parseRepos`, exige `--run-id` e chama
`inspectRepoFrontier` + `detectObservations`. Ops faz `JSON.parse` fail-closed,
chama o método homônimo do store e escreve uma linha JSON. Erro de argumento ou
JSON retorna 1; qualquer `OpsStoreError` de contrato/colisão retorna 2; sucesso
retorna 0. Não altere os switch cases existentes.

- [ ] **Step 3: Atualizar ritual e comandos instalados**

Atualize os dois `SKILL.md`, os dois command sources e
`explorer-auditor.md`: Classe C gera Observations, grava com
`record-outcome`, trata `NEEDS_REVIEW` sem promover e continua proibida de
alterar grafo/Human Gate. Em `install.test.mjs`, leia os comandos instalados e
afirme que contêm `observations` e `record-outcome`, preservando marker e
ownership atuais.

- [ ] **Step 4: Rodar regressões antigas e novas**

Run: `node --test skills/explorer-audit/test/omissions.test.mjs skills/explorer-audit/test/cli.test.mjs skills/explorer-ops/test/store.test.mjs skills/explorer-ops/test/cli.test.mjs packages/explorer-skills/test/install.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/explorer-audit/cli.mjs skills/explorer-audit/commands/explorer-audit.md skills/explorer-audit/SKILL.md skills/explorer-audit/test/cli.test.mjs skills/explorer-ops/cli.mjs skills/explorer-ops/commands/explorer-ops.md skills/explorer-ops/SKILL.md skills/explorer-ops/test/cli.test.mjs agents/opencode/explorer-auditor.md packages/explorer-skills/test/install.test.mjs
git commit -m "feat(cli): expose the V1 learning loop"
```

## Task 6: Blocking Eval Fixtures and Metrics

**Files:**
- Create: skills/explorer-query/src/learning-loop-eval.mjs
- Test: skills/explorer-query/test/learning-loop-eval.test.mjs

**Arquivos de fixture:**

- `skills/explorer-query/test/fixtures/learning-loop/java-call/source/Client.java`
- `skills/explorer-query/test/fixtures/learning-loop/spring-controller/source/OrderController.java`
- `skills/explorer-query/test/fixtures/learning-loop/spring-feign/source/BillingClient.java`
- `skills/explorer-query/test/fixtures/learning-loop/cross-repo-http/source/InvoiceClient.kt`
- `skills/explorer-query/test/fixtures/learning-loop/kafka/source/EventBus.kt`
- `skills/explorer-query/test/fixtures/learning-loop/intentional-omission/source/PolicyBoundary.java`

Cada diretório também contém `frontier-facts.json` e `expected.json`.
`expected.json` tem a shape fechada; separa o estado produzido pelo detector da
decisão humana aplicada pelo harness:

```json
{
  "capability": "cross-repo-http",
  "outcomes": [
    {
      "source_anchor": "InvoiceClient#fetch",
      "expected_edge": false,
      "expected_omission": true,
      "coverage_classification": "POSSIBLE_OMISSION",
      "detected_confirmation_status": "AUTO_CONFIRMED",
      "review_decision": null,
      "final_confirmation_status": "AUTO_CONFIRMED",
      "gap_occurrence": true
    }
  ],
  "expected_metrics": {
    "edge_precision": "N/A",
    "edge_recall": "N/A",
    "omission_precision": 1,
    "omission_recall": 1
  }
}
```

Cada fixture inclui pelo menos um outcome detectado como `NEEDS_REVIEW`. Para
capabilities sem AUTO, um true omission traz
`review_decision: "HUMAN_CONFIRMED"`; o harness preserva
`detected_confirmation_status`, aplica a decisão em
`final_confirmation_status` e só então grava. `intentional-omission` usa
`review_decision: "REJECTED"`, `expected_omission: false` e prova que nenhum
GapOccurrence é criado.

Predições da métrica: edge quando classificação é `COVERED`; omission quando
confirmação final é `AUTO_CONFIRMED` ou `HUMAN_CONFIRMED`. Classificação e
confirmation status também são comparados literalmente ao expected, de forma
que outcomes ambíguos não somem da avaliação.

**Conteúdo fechado das fixtures:**

```text
java-call/Client.java
  Client#call       -> Gateway.fetch("42") -> POSSIBLE_OMISSION/NEEDS_REVIEW -> HUMAN_CONFIRMED; expected_omission=true
  Client#ambiguous  -> Gateway.fetch()     -> UNKNOWN/NEEDS_REVIEW -> REJECTED; expected_edge=false; expected_omission=false
  frontier-facts.json = []
  metrics = edge_precision N/A, edge_recall N/A, omission_precision 1, omission_recall 1

spring-controller/OrderController.java
  OrderController#get       -> @GetMapping("/orders/{id}") -> POSSIBLE_OMISSION/NEEDS_REVIEW -> HUMAN_CONFIRMED; expected_omission=true
  OrderController#ambiguous -> @RequestMapping("/orders") sem method -> UNKNOWN/NEEDS_REVIEW -> REJECTED; expected_edge=false; expected_omission=false
  frontier-facts.json = []
  metrics = edge_precision N/A, edge_recall N/A, omission_precision 1, omission_recall 1

spring-feign/BillingClient.java
  BillingClient#get       -> @FeignClient(name="billing") + @GetMapping("/invoices/{id}") -> POSSIBLE_OMISSION/NEEDS_REVIEW -> HUMAN_CONFIRMED; expected_omission=true
  BillingClient#ambiguous -> @FeignClient(name="billing") + @GetMapping sem path -> UNKNOWN/NEEDS_REVIEW -> REJECTED; expected_edge=false; expected_omission=false
  frontier-facts.json = []
  metrics = edge_precision N/A, edge_recall N/A, omission_precision 1, omission_recall 1

cross-repo-http/InvoiceClient.kt
  InvoiceClient#covered   -> GET /invoices/{id} -> COVERED/NOT_APPLICABLE; expected_edge=true
  InvoiceClient#missing   -> POST /invoices     -> POSSIBLE_OMISSION/AUTO_CONFIRMED; expected_omission=true
  InvoiceClient#dynamic   -> GET com path dinâmica -> UNKNOWN/NEEDS_REVIEW -> REJECTED; expected_edge=false; expected_omission=false
  frontier-facts.json = [{"kind":"http_outbound","logical_repo":"checkout","source_revision":"fixture-head","method":"GET","path":"/invoices/{param}","contract_key":"GET /invoices/{param}","file":"InvoiceClient.kt","line":2}]
  O harness troca "fixture-head" pelo HEAD criado antes de chamar detectObservations.
  metrics = edge_precision 1, edge_recall 1, omission_precision 1, omission_recall 1

kafka/EventBus.kt
  EventBus#consume   -> @KafkaListener(topics=["orders"]) -> POSSIBLE_OMISSION/NEEDS_REVIEW -> HUMAN_CONFIRMED; expected_omission=true
  EventBus#ambiguous -> KafkaTemplate.send(dynamicTopic, payload) -> UNKNOWN/NEEDS_REVIEW -> REJECTED; expected_edge=false; expected_omission=false
  frontier-facts.json = []
  metrics = edge_precision N/A, edge_recall N/A, omission_precision 1, omission_recall 1

intentional-omission/PolicyBoundary.java
  PolicyBoundary#generated -> marcador "explorer-intentional-omission reason=generated-code scope=src/generated"; o harness cria a Observation explícita -> POSSIBLE_OMISSION/NEEDS_REVIEW -> REJECTED; expected_edge=false; expected_omission=false; gap_occurrence=false
  frontier-facts.json = []
  metrics = edge_precision N/A, edge_recall N/A, omission_precision N/A, omission_recall N/A
```

No detector, Feign tem precedência sobre Controller no mesmo tipo, e chamadas
de framework já classificadas não geram `java-call` duplicada. O harness exige
exatamente os anchors acima; Observation extra ou ausente falha o teste.

- [ ] **Step 1: Escrever evaluator e testes falhando**

```js
export function ratio(numerator, denominator) {
  return denominator === 0 ? "N/A" : numerator / denominator;
}

export function metricsFromCounts(counts) {
  return {
    edge_precision: ratio(counts.tp_edge, counts.tp_edge + counts.fp_edge),
    edge_recall: ratio(counts.tp_edge, counts.tp_edge + counts.fn_edge),
    omission_precision: ratio(counts.tp_omission, counts.tp_omission + counts.fp_omission),
    omission_recall: ratio(counts.tp_omission, counts.tp_omission + counts.fn_omission),
  };
}

export function assertPerfectGate(metrics) {
  for (const [name, value] of Object.entries(metrics)) {
    if (value !== "N/A" && value !== 1) throw new Error(`${name} expected 1, received ${value}`);
  }
}

// runFixture(family: string)
//   -> {expected: object, outcomes: object[], counts: object, metrics: object}
// runAllFixtures()
//   -> {counts: object, metrics: object}
```

```js
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
```

Run: `node --test skills/explorer-query/test/learning-loop-eval.test.mjs`

Expected: FAIL porque evaluator e fixtures ainda não existem.

- [ ] **Step 2: Implementar o harness pinado**

`runFixture(family)` copia `source/` para um diretório temporário, cria commit
Git, substitui `fixture-head` nos FrontierFacts, chama `detectObservations`,
aplica `review_decision` somente onde declarado, grava o resultado via
`recordOutcome` em ops SQLite temporário e consulta GapOccurrence. Para
`intentional-omission`, cria a Observation explícita a partir do marcador usando
`canonicalizeSignal`, sem adicionar detector automático. Ordene outcomes por
`source_anchor` antes da comparação. `runAllFixtures()` soma os quatro confusion
counts de cada família e só depois chama `metricsFromCounts`.

- [ ] **Step 3: Escrever exatamente as seis fixtures da matriz e executar o gate**

Run: `node --test skills/explorer-query/test/learning-loop-eval.test.mjs`

Expected: PASS; toda métrica aplicável por fixture e no agregado é 1, e N/A só
aparece com denominador zero.

- [ ] **Step 4: Commit**

```bash
git add skills/explorer-query/src/learning-loop-eval.mjs skills/explorer-query/test/learning-loop-eval.test.mjs skills/explorer-query/test/fixtures/learning-loop
git commit -m "test(eval): gate the V1 learning loop"
```

## Task 7: Documentation + Package Acceptance

**Files (only these):**
- Modify: docs/adr/0011-coverage-gap-memory.md
- Modify: docs/domain/glossary.md

**No fake documentation tests.**

- [ ] **Step 1: Alinhar ADR 0011**

Registre `Observation`, os dois eixos de estado, `GapOccurrence`, as identidades
estáveis, a promoção somente por `AUTO_CONFIRMED`/`HUMAN_CONFIRMED`, a matriz
AUTO estreita da V1 e a separação do Human Gate. Preserve as operações públicas
`load-context`, `record-outcome` e `resolve-gap`.

- [ ] **Step 2: Alinhar o glossário**

Adicione entradas para `Observation`, `coverage_classification`,
`confirmation_status`, `observation_id`, `signal_key`, `target_signature`,
`GapOccurrence` e `gap_key`. Atualize CoverageGap sem duplicar a spec.

- [ ] **Step 3: Verificar documentação, pacote e suíte completa**

```bash
rg "Observation|GapOccurrence|observation_id|gap_key|AUTO_CONFIRMED|HUMAN_CONFIRMED" docs/adr/0011-coverage-gap-memory.md docs/domain/glossary.md
node --test packages/explorer-skills/test/install.test.mjs
node --test skills/explorer-audit/test/*.test.mjs skills/explorer-ops/test/*.test.mjs skills/explorer-query/test/*.test.mjs
node --test
```

Expected: all PASS, only listed files staged

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0011-coverage-gap-memory.md docs/domain/glossary.md
git commit -m "docs(memory): align the V1 learning loop vocabulary"
```

## Self-Review Checklist

- [x] Spec coverage: every section of v1-learning-loop.md maps to a task (enums, signal_key variants, confirmObservation predicates, Journal/GapOccurrence/CoverageGap, idempotence, fixtures, metrics, preservation).
- [x] Placeholder scan: sem marcadores pendentes, comandos genéricos ou corpos fictícios.
- [x] Type consistency: exact SignalKey variants, exact JSDoc object params, exact DDL columns match Observation fields.
- [x] Dependency graph: Task 1 -> 2+3 parallel; 3 -> 4; 2+4 -> 5+6 parallel; 5+6 -> 7. Correct.
- [x] Each task independently reviewable with exact files, interfaces, failing/passing commands, concrete snippets, semantic commits.
- [x] V1 support matrix and metric independence stated exactly.
- [x] Collision rejection only in store; makeObservationId excludes revision/line by destructuring.
- [x] Fixtures prove REJECTED prevents false promotion; metric assertions compare to expected.json values.
- [x] Only stage files listed per task; no git writes in plan execution.
