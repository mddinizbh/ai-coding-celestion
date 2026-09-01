---
status: accepted
---

# ADR 0011 — Memória de CoverageGap

## Contexto

O journal (`explorer-ops`) registra runs e challenges operacionais. O Project Knowledge Graph armazena fatos com evidência aceita. Decisões de arquitetura vivem em ADRs. A memória de agente não deve virar bucket genérico de decisões ou transcrições.

O plano de store compartilhado menciona journal remoto. CoverageGap é a
consolidação de falhas de cobertura relevantes para reuso sem reexecução cega.

Hoje, `explorer-ops` expõe apenas `log`, `list` e `challenges`. O indexer grava
`finalize`; o auditor grava `audit`; o SQLite local recusa de forma transacional
caminho absoluto, hostname e material com segredo. `load-context`,
`record-outcome` e `resolve-gap` ainda não existem.

## Decisão

Aprovar três operações públicas para a futura porta de memória de CoverageGap.
Elas não são comandos implementados nesta decisão. O ciclo é:

1. `load-context(scope, objective)` — antes da execução.
2. Agente executa fluxo L0/L1/audit normal (inalterado).
3. `record-outcome(run, phase, observations)` — após fase.
4. `resolve-gap(gap_id, resolution)` — somente com evidência aceita ou
   fechamento humano explícito.

Os microsteps ficam escondidos atrás das operações públicas:

- `load-context`: `select-open-gaps`, `rank-gaps`, `build-memory-context`.
- `record-outcome`: `append-journal-entry`, `classify-observations`,
  `decide-promotion`, `identify-gap`, `upsert-gap`, `reconcile-gap`.

Agentes não invocam avaliação, promoção ou persistência separadamente e não
importam clientes Oracle ou Mongo.

## Vocabulário

- **Journal**: registra toda ocorrência de run/fase e challenge operacional. É
  a fonte de recuperação quando a consolidação precisa ser refeita.
- **Project Knowledge Graph**: fatos com evidência aceita (Human Gate). Nunca armazena CoverageGap.
- **CoverageGap**: consolida falhas de cobertura relevantes, tentativas e próxima hipótese. Não é decisão arbitrária nem dump de run.

Escopo local é `namespace + logical_repo`. Escopo cross-service é
`system_namespace + logical_repos` afetados.

A identidade estável combina motivo, escopo e alvo; `source_revision` fica fora
dela. O registro guarda `first_seen_revision`, `last_seen_revision`, recorrência,
tentativas, resumo curto, próxima hipótese curta, estado e Repository References
relativas aceitas.

Política de promoção:

- automática: `index_missing`, `no_accepted_l0`, `unresolved_fact_anchor`,
  `unresolved_dispatch`;
- marcação explícita obrigatória: `no_matching_edge`, `policy_boundary`;
- demais observações permanecem somente no Journal.

Estados: `open`, `stale`, `resolved`, `superseded`. Nova revisão marca gaps
relevantes como `stale` para revalidação. Resolução e substituição exigem
evidência aceita ou fechamento humano explícito.

Ranking de recuperação: objetivo atual, escopo exato, bloqueio de cobertura,
recorrência e recência. A saída padrão é um resumo limitado; o histórico completo
fica sob demanda.

Conteúdo durável permitido: motivo, escopo, identidade, estado, revisões e
recorrência estruturados; tentativas limitadas; resumo e próxima hipótese curtos;
ponteiros de evidência relativos e scrubados.

Conteúdo proibido: segredo, cookie, token ou credencial; caminho de máquina ou
hostname; prompt ou transcrição inteira; logs irrestritos, dumps de grafo ou
corpos de arquivo crus.

O scrub atual do ops já recusa caminho, hostname e segredo, embora o checkbox em
`docs/plans/store-compartilhado.md` ainda apareça desmarcado. A futura porta
também deve impor os demais limites desta decisão antes de escrever.

A promoção é híbrida. O Journal é a fonte de recuperação em caso de retry da
consolidação; não se pressupõe atomicidade entre stores.

## Consequências

Positivas:
- Memória foca só em CoverageGap consolidado; ADRs guardam decisões de arquitetura; ocorrências ficam no Journal.
- Agentes ganham contexto sem importar stores remotos ou clientes pesados.
- Human Gate preservado; nada auto-aceita evidência de grafo.

Riscos e custos:
- Mais uma camada de classificação em `record-outcome`.
- Rollback de memória exige reprocessar o Journal.

## Alternativas rejeitadas

- Expor cada microstep para agentes: aumenta acoplamento e permite consolidação
  parcial coordenada pelo agente.
- Manter somente o Journal com batch atrasado: perde reuso imediato de gaps.
- Armazenar transcrições ou dumps completos de run: cria um bucket genérico e
  viola os limites de conteúdo.

## Limites de implementação (deferred)

Nenhuma skill, schema, adapter, acesso Mongo/Oracle ou mudança em agente é
implementado nesta decisão. As operações são nomes aprovados para a porta futura.
