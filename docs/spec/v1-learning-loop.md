# Spec: fechamento do loop de aprendizado V1 (condensado)

> Contrato para fechar o ciclo Auditor C -> Observation -> Journal -> CoverageGap.
> Segue o estilo compacto de `docs/spec/explorer-l0-contract.md`. Suficiente para plano de implementação posterior sem reabrir decisões de arquitetura aprovadas.

---

## Propósito

Fechar o loop de memória de cobertura (V1) de forma que omissões detectadas pelo Auditor C sejam classificadas, validadas e consolidadas em CoverageGap duráveis, com identidade estável e métricas de avaliação objetivas. O Journal preserva todas as Observations; GapOccurrence preserva a recorrência por run; CoverageGap é a consolidação para reuso.

### Não-objetivos (V1)

- Não substitui Human Gate do L0 baseline.
- Não inventa adapters, não altera Graphify/L0/L1/L2.
- Não introduz runtime novo, Kafka como infraestrutura de workflow, memória distribuída ou self-healing.
- Não resolve stale freshness (ver ROADMAP).

## Fluxo end-to-end (Auditor C)

1. `detectObservations(pinned source)` - varre fontes pinadas por capability suportada.
2. `validateObservation` - classifica:
   - match semântico (capability + signal_key completo + target_signature) -> `COVERED`
   - proximidade de linha (5 linhas) sem match semântico -> `MAYBE_COVERED` + `NEEDS_REVIEW` (nunca promove automático)
   - nenhum match semântico -> `POSSIBLE_OMISSION` -> `confirmObservation`
3. `confirmObservation` - auto-confirma apenas com: capability suportada, signal_key completo, evidência válida e ausência semântica comprovada. Casos incompletos ou ambíguos permanecem `NEEDS_REVIEW`.
4. Todo Observation válido vai para Journal. Apenas `AUTO_CONFIRMED` / `HUMAN_CONFIRMED` criam/atualizam CoverageGap.

**Separação explícita**: revisão de CoverageGap é independente do Human Gate do baseline L0. Um não afeta o outro.

## Enums fechados

```text
coverage_classification = COVERED | MAYBE_COVERED | POSSIBLE_OMISSION | UNKNOWN

confirmation_status = NOT_APPLICABLE | AUTO_CONFIRMED | NEEDS_REVIEW | HUMAN_CONFIRMED | REJECTED
```

Os eixos são independentes: `coverage_classification` registra o que o detector
encontrou; `confirmation_status` registra se esse achado pode virar gap.

| Classificação | Estado inicial de confirmação | Regra |
|---|---|---|
| `COVERED` | `NOT_APPLICABLE` | Cobertura comprovada não gera gap. |
| `MAYBE_COVERED` | `NEEDS_REVIEW` | Proximidade de linha é pista, nunca confirmação automática. |
| `POSSIBLE_OMISSION` | `AUTO_CONFIRMED` ou `NEEDS_REVIEW` | Depende dos quatro critérios de `confirmObservation`. |
| `UNKNOWN` | `NEEDS_REVIEW` | Capability, sinal ou evidência insuficiente. |

Revisão humana pode promover `NEEDS_REVIEW` para `HUMAN_CONFIRMED` ou
encerrar como `REJECTED`. Não altera `coverage_classification`, preservando o
resultado original do detector.

## Predicados de confirmação automática

Os quatro critérios de `confirmObservation` são verificáveis e cumulativos:

1. **Capability suportada**: pertence à união fechada de `signal_key` desta spec.
2. **Sinal completo**: todos os campos obrigatórios da variante estão presentes
   após normalização canônica; nenhum valor depende de inferência por nome ou
   similaridade.
3. **Evidência válida**: `logical_repo`, arquivo relativo e `source_anchor`
   resolvem, por leitura Git, para o conteúdo da `source_revision` pinada da run;
   o detector reproduz desse conteúdo a mesma capability e o mesmo `signal_key`.
4. **Ausência semântica comprovada**: no conjunto completo de FrontierFacts do
   mesmo namespace, logical repo e revisão pinada não existe fato compatível com
   a mesma capability e `target_signature`. Proximidade de linha não participa
   desse predicado.

Falha de leitura, conjunto parcial de fatos, capability desconhecida, sinal
incompleto ou âncora não reproduzível impede auto-confirmação e resulta em
`NEEDS_REVIEW`; não equivale a ausência.

## Journal e Observation

- Journal armazena **todo** Observation válido.
- Chave: `UNIQUE(run_id, observation_id)`.
- `observation_id` deriva de identidade semântica estável (abaixo).
- Retry de `(run_id, observation_id)` não duplica Observation (idempotente).

## signal_key e target_signature

`signal_key` é uma união fechada e discriminada por capability. Os contratos
mínimos são:

- `java-call`: `{ class, method, params }`
- `spring-controller`: `{ annotation, path, method }`
- `spring-feign`: `{ client, method, path }`
- `cross-repo-http`: `{ from_logical_repo, to_contract_key }`
- `kafka`: `{ topic, direction, client }`
- `intentional-omission`: `{ reason, scope }`

`target_signature` deriva da serialização canônica do `signal_key`, com ordem
de campos e normalização determinísticas, sem ruído de run, revisão ou linha.
Capability desconhecida ou chave incompleta não entra no caminho de
auto-confirmação.

## Identidade de Observation

`observation_id = hash(capability + canonical_signal + source_evidence_identity)`

- Estável em retry.
- `source_evidence_identity = logical_repo + relative_file + source_anchor`.
- `source_anchor` é a identidade canônica da declaração estrutural que produziu
  o sinal (por exemplo, classe + método). Deve ser reproduzível da fonte pinada;
  se o detector não conseguir derivá-la, a Observation fica `UNKNOWN` /
  `NEEDS_REVIEW`.
- Linhas e revisão ficam como metadados históricos.
- Exclui ruído local de run/revisão, como proximidade de linha e timestamp.
- Mesmo material canônico produz o mesmo ID. Se um ID já existente receber
  payload canônico divergente, a escrita falha como colisão; não sobrescreve.
- `signal_key` divergente produz Observation distinta.

## CoverageGap e GapOccurrence

- **CoverageGap**: deficiência durável.
  - `gap_key` UNIQUE (razão + escopo + capability + target_signature)
  - Campos: reason, scope, capability, target_signature, status, first_seen, last_seen, occurrences
  - Revisões pertencem ao histórico, não à identidade.

- **GapOccurrence**: evidência por run.
  - `run_id`, `gap_key`, `observation_id`
  - `UNIQUE(run_id, gap_key)`
  - A primeira Observation confirmada para o gap na run cria a ocorrência;
    Observations equivalentes posteriores permanecem no Journal, sem incrementar
    o gap novamente.

- `gap_key = reason + scope + capability + target_signature`
- `first_seen`, `last_seen` e `occurrences` são projeções reconstruíveis de
  `GapOccurrence`, não fontes primárias.

### Estado de CoverageGap

O enum fechado permanece o do ADR 0011:

```text
gap_status = open | stale | resolved | superseded
```

- Novo gap confirmado nasce `open`.
- Nova revisão pinada do escopo afetado move `open` para `stale`, antes da
  revalidação.
- Nova ocorrência confirmada move `stale`, `resolved` ou `superseded` para
  `open`, preservando a transição no histórico.
- `open` ou `stale` move para `resolved` somente por `resolve-gap`, com evidência
  aceita de correção ou fechamento humano explícito.
- `open` ou `stale` move para `superseded` somente por `resolve-gap`, com
  `gap_key` substituto e evidência aceita ou fechamento humano explícito.
- Ausência de ocorrência em uma run não resolve nem substitui gap.

`status` é estado consolidado, não projeção de contagem. O histórico de
transições e revisões permite auditar reabertura, resolução e substituição.

## Idempotência

- Retry `(run_id, observation_id)` não duplica Observation.
- Gap incrementa no máximo uma vez por `(run_id, gap_key)`.

## Fixtures de avaliação inicial

java-call, spring-controller, spring-feign, cross-repo-http, kafka, intentional-omission.

## Métricas

Por fixture e agregadas:

- edge precision / recall
- omission precision / recall

Regras:
- Zero positivos -> N/A (nunca 1.0 artificial).
- Resultados ambíguos (NEEDS_REVIEW, UNKNOWN) representados no ground truth.
- Toda métrica aplicável deve ser `1.0` por fixture e no agregado.
- O agregado soma apenas os confusion counts das métricas aplicáveis; se não
  houver denominador, permanece N/A.
- Regressão em capability suportada bloqueia merge/release V1.

## Preservação

Graphify, L0/L1/L2, Human Gate do baseline e Auditor B/C permanecem. Journal,
CoverageGap e portas de store também permanecem como conceitos e fronteiras,
mas evoluem para acomodar Observation, GapOccurrence e idempotência.

## Exclusões V2 (explícitas)

- Hybrid LSP customizado
- Substituição de Graphify
- Adapters automáticos
- Self-healing
- Runtime traces
- MCP completo
- Hooks avançados
- Novo banco de grafos

## Limites de implementação (fronteiras)

- `explorer-audit`: detecta e valida Observations (pinned source).
- `explorer-ops`: dono do Journal, persistência de Occurrence, idempotência.
- Camada query/eval: calcula métricas.
- Armazenamento permanece atrás de portas (nenhuma skill abre path hardcoded).

## Critérios de aceitação (verificáveis mecanicamente)

- Todo Observation válido persiste com UNIQUE(run_id, observation_id).
- Apenas AUTO_CONFIRMED/HUMAN_CONFIRMED criam/atualizam gaps.
- Proximidade de linha nunca promove automático.
- Métricas em fixtures suportadas = 1.0 (ou N/A quando zero positivos).
- Nenhuma regressão em capability suportada.
- Journal e CoverageGap seguem definições de identidade/gap_key acima.
- Auditor C roda sem alterar L0 Human Gate.
- Mesmo ID com payload divergente é rejeitado como colisão.
- `first_seen`, `last_seen` e `occurrences` podem ser reconstruídos somente de
  GapOccurrence.
- Auto-confirmação só ocorre quando os quatro predicados desta spec são
  comprovados sobre a mesma revisão pinada.
- Toda transição de `gap_status` respeita o enum e as regras desta spec.

## Referências

- `AGENTS.md` - padrão de agents/skills e convenções do explorer.
- `docs/spec/explorer-l0-contract.md` - estilo de contrato condensado e Human Gate.
- `docs/adr/0011-coverage-gap-memory.md` - decisão de memória CoverageGap (Journal vs Gap).
- `docs/domain/glossary.md` - vocabulário (Auditor B/C, Journal, CoverageGap).
- `ROADMAP.md` - exclusões V2 e o que não reabrir.
- `skills/explorer-audit/src/omissions.mjs` - detecção atual de omissões (base para detectObservations).
- `skills/explorer-l1/src/frontier-extract.mjs` - FrontierFact e signal (method/path/contract_key).
- `skills/explorer-ops/src/schema.mjs` + `store.mjs` - Journal atual (run_id, challenges).
- `agents/opencode/explorer-auditor.md` - ritual Auditor B/C e journal.
- `skills/explorer-query/src/slice-metrics.mjs` - padrão de métricas.

**Nota**: Após aceitação desta spec, ADR 0011 e glossary podem precisar de alinhamento de vocabulário/estado, mas não são editados agora.
