---
status: accepted
---

# ADR 0011 — Memória de CoverageGap

## Contexto

O journal (`explorer-ops`) registra runs e challenges operacionais. O Project Knowledge Graph armazena fatos com evidência aceita. Decisões de arquitetura vivem em ADRs. A memória de agente não deve virar bucket genérico de decisões ou transcrições.

O plano de store compartilhado menciona journal remoto. CoverageGap é a
consolidação de falhas de cobertura relevantes para reuso sem reexecução cega.

Hoje, `explorer-ops` expõe Journal com Observation e GapOccurrence. As operações públicas `load-context`, `record-outcome` e `resolve-gap` estão implementadas na porta de memória V1.

## Decisão

Aprovar e registrar as três operações públicas implementadas na porta de memória V1:

1. `load-context(scope, objective)` — recupera contexto de CoverageGap antes da execução.
2. Agente executa fluxo L0/L1/audit normal (inalterado).
3. `record-outcome({run, observations})` — persiste toda Observation válida (phase dentro de run); apenas AUTO_CONFIRMED/HUMAN_CONFIRMED criam/atualizam CoverageGap via GapOccurrence.
4. `resolve-gap(gap_key, resolution)` — somente com evidência aceita ou fechamento humano explícito.

Observation usa dois eixos independentes: `coverage_classification` (COVERED | MAYBE_COVERED | POSSIBLE_OMISSION | UNKNOWN) e `confirmation_status` (NOT_APPLICABLE | AUTO_CONFIRMED | NEEDS_REVIEW | HUMAN_CONFIRMED | REJECTED). Identidade estável: `observation_id = hash(capability + canonical_signal + source_evidence_identity)`; `gap_key = reason + scope + capability + target_signature`.

GapOccurrence registra evidência por run (`UNIQUE(run_id, gap_key)`). V1 auto-confirmação restrita a cross-repo-http totalmente comprovado (quatro predicados da spec). Proximidade de linha nunca promove automático.

Separação explícita: revisão de CoverageGap é independente do Human Gate do baseline L0. Um não afeta o outro.

Todas as Observations válidas persistem no Journal. Somente AUTO_CONFIRMED/HUMAN_CONFIRMED promovem gaps.

## Vocabulário

- **Journal**: registra runs/fases e challenges operacionais + toda Observation válida (`UNIQUE(run_id, observation_id)`). Fonte de recuperação para reconstrução/retry idempotente; não transforma ocorrência em fato do grafo. Nenhuma atomicidade assumida entre stores distintos.
- **Observation**: registro de detecção com dois eixos (`coverage_classification`, `confirmation_status`), `observation_id` estável, `signal_key`, `target_signature` e evidência.
- **GapOccurrence**: evidência por run (`run_id`, `gap_key`, `observation_id`; `UNIQUE(run_id, gap_key)`). Primeira Observation confirmada cria; equivalentes posteriores ficam no Journal.
- **CoverageGap**: deficiência durável consolidada. `gap_key` UNIQUE (razão + escopo + capability + target_signature). Campos: reason, scope, capability, target_signature, status, first_seen, last_seen, occurrences. Revisões pertencem ao histórico.
- **Project Knowledge Graph**: fatos com evidência aceita (Human Gate). Nunca armazena CoverageGap.

Identidade estável de Observation exclui ruído de run/revisão/linha. `gap_key` exclui revisão.

Política de promoção V1 (estreita): somente AUTO_CONFIRMED/HUMAN_CONFIRMED criam/atualizam CoverageGap. Auto-confirmação restrita a cross-repo-http totalmente comprovado (capability suportada + sinal completo + evidência válida + ausência semântica comprovada). MAYBE_COVERED e casos ambíguos ficam NEEDS_REVIEW; proximidade de linha nunca promove.

Estados de CoverageGap: `open`, `stale`, `resolved`, `superseded`. Nova revisão marca como `stale`. Resolução/substituição somente via `resolve-gap` com evidência ou fechamento humano.

Separação explícita: revisão de CoverageGap é independente do Human Gate do baseline L0.

Limites de conteúdo (porta V1): recusa path absoluto/hostname, segredo (password/secret/token/api_key/private_key em chave ou assignment), e exige Repository Reference relativa com #anchor para evidência aceita; human_closure exige actor+reason scrubados. Journal preserva todas as Observations; promoção é estreita e auditável.

## Consequências

Positivas:
- Todas as Observations válidas persistem; somente AUTO_CONFIRMED/HUMAN_CONFIRMED promovem gaps (V1 estreita).
- GapOccurrence dá rastreabilidade por run; `gap_key` e `observation_id` estáveis.
- Separação explícita do Human Gate do L0 baseline; revisão de CoverageGap independente.
- Agentes usam operações públicas sem acoplamento a stores.

Riscos e custos:
- Classificação de dois eixos em `record-outcome`.
- Rollback exige reprocessar Journal (idempotente).

## Alternativas rejeitadas

- Expor cada microstep para agentes: aumenta acoplamento e permite consolidação
  parcial coordenada pelo agente.
- Manter somente o Journal com batch atrasado: perde reuso imediato de gaps.
- Armazenar transcrições ou dumps completos de run: cria um bucket genérico e
  viola os limites de conteúdo.

## Limites de implementação

As operações `load-context`, `record-outcome` e `resolve-gap` estão implementadas na porta V1 (`explorer-ops`). Auditor C detecta/valida Observations; Journal persiste Observation + GapOccurrence com idempotência. Nenhuma alteração em L0 Human Gate, Graphify ou L1/L2. Auto-confirmação V1 restrita a cross-repo-http comprovado.
