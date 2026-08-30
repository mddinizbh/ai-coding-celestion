---
status: accepted
---

# ADR 0005 — Skill Descobrir de produção com store SQLite de documentos

## Contexto

O ADR 0002 fixou o modelo de Knowledge Records e o ADR 0003 autorizou um protótipo descartável sob `prototypes/descobrir-v1/` para evidência de Gate C. O protótipo prova que o contrato é satisfatível, mas **não** é skill instalável, **não** é runtime permanente e pode ser apagado sem impacto.

O harness precisa agora de um caminho de produção **project-local** que:

1. Oriente o agente (LLM Explorer) a ler saída isolada do Graphify e emitir um pacote candidato com contrato exato.
2. Aplique guardrails determinísticos (schema, IDs canônicos, ordenação, hash) sobre saída LLM **não confiável**.
3. Persista candidates e o ponteiro de baseline aceito de forma durável, idempotente e com isolamento de namespace.
4. Mantenha JSON apenas como export/auditoria — nunca como segunda fonte de verdade.
5. Exija Human Gate explícito (`coverage_report.passed === true` + identidade do aprovador) antes de aceitar.

O README ainda descrevia Descobrir como docs-first sem skill e o protótipo como “ainda não existe”, o que ficou obsoleto após Gate C e a introdução da skill.

## Decisão

### Skill project-local em `skills/descobrir/`

A skill de produção vive em `skills/descobrir/` com `SKILL.md` descoberta por frontmatter (`name`, `description` só de triggers). Ela **não** importa módulos de `prototypes/**`. Seams puros (IDs canônicos, validação de schema, hash de grafo, store) são reimplementados sob a skill e leem os schemas canônicos em `workflows/descobrir/contracts/`.

### Graphify apenas em cópia/worktree efêmera (path B)

Graphify roda somente em worktree efêmera do repositório-alvo na revisão pinada.
O Explorer raciocina sobre saída isolada; o repositório-fonte nunca é mutado.
**Atualização (ADR 0006):** a skill de produção **passa a invocar** Graphify de
forma gerenciada (`prepare` / `setup` com `graphifyy==0.9.32`). O operador não
precisa mais rodar Graphify manualmente.

### Saída LLM untrusted; determinismo só no envelope

A extração semântica permanece estocástica. Determinismo cobre: shape do draft, `additionalProperties`/campos banidos (ex.: `confidence`), recomputação de IDs canônicos (IDs fornecidos pelo LLM **não** são autoridade), normalização, ordenação estável, `canonical_graph_hash`, verificação de revisão pinada quando aplicável, e comportamento transacional do store.

### Store SQLite de documentos (não grafo normalizado)

Usar `node:sqlite` (`DatabaseSync`) do Node v26, **zero** dependências de pacote.

Schema canônico de documentos:

- `candidate_packages`: documento JSON estável do pacote candidato, chaveado por `namespace` + `logical_repo` + `source_revision` + `canonical_graph_hash` (e `candidate_id` determinístico).
- `accepted_baselines`: no máximo **um** ponteiro aceito por (`namespace`, `logical_repo`), atualizado atomicamente no Human Gate.

Não se normaliza o grafo em tabelas de entidade/evidência neste slice. Múltiplos candidates são preservados; aceitação substitui apenas o ponteiro.

### CLI mínima

`persist-candidate`, `accept`, `export` em `skills/descobrir/cli.mjs`. Export grava JSON com modo `0600` quando aplicável; o SQLite permanece canônico. Erros de CLI são sanitizados (sem paths absolutos desnecessários / stacks).

### Explorer draft closed shape

O draft do LLM Explorer é um envelope fechado: relations usam apenas natural keys (nunca `from_record`/`to_record`/`id` como autoridade); `coverage_report` no draft aceita somente inputs determinísticos (`id`, `threshold`, `mutation`, `producer_baseline`, `repeatability`, `freshness`). Campos derivados (`passed`, `provenance`, `status_counts`, …) são rejeitados e recomputados pelos guardrails. O store SQLite revalida alinhamento cross-document, listas do GraphIndex, resolução de artifact evidence e o gate recomputado antes de gravar.

### Persist collision and mutation equivalence

Persistência é idempotente somente quando o JSON canônico do pacote é byte-equivalente ao já armazenado para a mesma chave `(namespace, logical_repo, source_revision, canonical_graph_hash)`. Pacotes divergentes na mesma chave são rejeitados com `StoreError` (não sobrescritos silenciosamente). `mutation.equivalent` é sempre derivado da comparação canônica estável de `pre`/`post`; o booleano do draft não é autoridade. `accept` revalida integridade do `package_json` armazenado antes de mover o ponteiro aceito.

### Human Gate

`accept` exige:

1. `coverage_report.passed === true` no candidate persistido
2. identidade de aprovador não vazia

Sem auto-accept. Rejeição deixa o baseline aceito anterior inalterado.

## Consequências

**Positivas:**

- Skill descoberta e executável no harness, alinhada ao FLOW e aos contratos.
- Protótipo permanece deletável; produção não depende dele.
- Persistência idempotente, isolamento de namespace, aceitação atômica.
- Fronteira clara entre estocástico (LLM) e determinístico (guardrails + store).

**Negativas / riscos:**

- Store de documentos não otimiza travessia de grafo (L1/L2 / Neo4j ficam para ADR futuro — ver ADR 0006).
- Cobertura `comprovado` ainda depende de verificação de repositório na revisão pinada — fora do auto-accept.
- Isolamento Graphify é enforced pelo `prepare` (worktree + cleanup); setup pinado é pré-requisito explícito (`cli.mjs setup`).

## Alternativas rejeitadas

### Continuar só com protótipo + JSON em `output/`

Rejeitada: JSON gitignored não é baseline operacional nem Human Gate durável multi-candidate.

### Importar `prototypes/descobrir-v1` na skill

Rejeitada: acoplaria produção a artefato descartável e impediria apagar o protótipo.

### Tabelas normalizadas de nós/arestas neste slice

Rejeitada por YAGNI: o contrato atual é o pacote candidato completo; normalização é decisão separada (ver ADR 0004 sobre store graph-capable para L1/L2).

### Auto-accept quando `passed === true`

Rejeitada: FLOW e ADR 0002 exigem Human Gate; consenso de agente não substitui aprovação humana.

## Evidência

Implementação em `skills/descobrir/` com testes `node --test skills/descobrir/test/*.test.mjs` cobrindo rejeição de schema/campos banidos, IDs inventados, hash/ordem determinísticos, persistência idempotente, rollback, isolamento de namespace, rejeição de accept sem gate/aprovador, aceitação atômica e export round-trip.
