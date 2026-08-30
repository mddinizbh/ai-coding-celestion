---
status: accepted
---

# ADR 0010 — Context Slice persistente como cache derivado determinístico

## Contexto

ADR 0001 define o Project Knowledge Graph como fonte factual e diagramas como projeções descartáveis. ADR 0008 separa o pipeline explorer-l* em build↑ L0→L1→L2 e query↓ L2→L1→L0→code pointers.

O caminho query↓ precisava reutilizar subgrafos sem transformar a sessão do agente em fonte de verdade. A solução precisa preservar o Human Gate do L0, invalidar quando baselines/policies/journeys mudam e permitir rollback operacional imediato.

## Decisão

Persistir Context Slices em SQLite como resultado derivado, determinístico e content-addressed. O Slice completo é cache/materialized result; L0/L1/L2 continuam sendo as fontes canônicas.

A chave de derivação inclui engine/schema version, namespace do sistema, policy e versão, options hash, seeds normalizados, baselines L0 aceitos, hash do edge set L1 em escopo e binds L2 em escopo. Mudança em qualquer parte policy-relevante gera cache miss e novo `slice_hash`.

O `context_slice_current` aponta o Slice corrente por `(system_namespace, policy_name, seed_set_hash)`, mas não substitui a chave de derivação nem autoriza stale hit. `slice-gc` é explícito, dry-run por default, remove apenas `context_slice_*` e preserva L0/L1/L2.

Rollout é opt-in: `answer` usa o caminho legado por default; `answer --use-slice-cache` e `slice` ativam materialização persistente. Rollback é remover a flag. Apagar cache não é necessário para voltar ao comportamento legado.

## Consequências

Positivas:

- Query↓ pode reutilizar Slices byte-estáveis sem consultar código amplo novamente.
- Completeness fica explícita por cobertura e misses, incluindo gaps de journey e baselines ausentes.
- Rollback operacional é simples e não toca nos stores canônicos.

Riscos e custos:

- Mais uma schema migration no DB compartilhado.
- Operadores precisam diferenciar Fact, Slice, Pack e diagrama.
- Cache stale é evitado por chave completa; qualquer atalho que ignore baseline/policy hash é proibido.

## Alternativas

Rejeitada: manter Slices apenas em memória de sessão. Isso evita schema, mas perde reuse e torna regressões difíceis de provar.

Rejeitada: promover Slice a nova camada canônica. Isso violaria ADR 0001/0008 e confundiria derivado com fato aceito.

Deferred: FTS5 para busca de Slice, single-flight entre processos, otimização incremental e Explorer L3. FTS5 só entra se `slice_query_scan_rows` justificar.

## Operação

Comandos principais:

```bash
node skills/explorer-query/cli.mjs slice \
  --system-namespace <system> --system-db <system.sqlite> \
  --l0-db <l0.sqlite> --policy journey --seeds <seeds.json>

node skills/explorer-query/cli.mjs slice-show \
  --system-db <system.sqlite> --slice-hash <64-hex>

node skills/explorer-query/cli.mjs answer --use-slice-cache \
  --system-namespace <system> --system-db <system.sqlite> \
  --l0-db <l0.sqlite> --policy journey --seeds <seeds.json>

node skills/explorer-query/src/slice-gc-cli.mjs --db <system.sqlite>
node skills/explorer-query/src/slice-gc-cli.mjs --db <system.sqlite> --execute --keep-current
```

Métricas locais mínimas: `cache_hit`, `cache_miss`, `materialization_ms`, `nodes`, `edges`, `misses_by_reason`, `slice_query_scan_rows`, `pack_truncated`. Não há telemetria remota.

Limites: ceilings de materialização protegem tamanho do Slice; budgets de Pack (`max_nodes`, `max_edges`, `max_chars`) só truncam a projeção agente-facing. O budget não promete contagem exata de tokens.
