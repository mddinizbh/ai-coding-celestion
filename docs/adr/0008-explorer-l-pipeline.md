---
status: accepted
---

# ADR 0008 — Família explorer-l* e pipeline build↑ / query↓

## Contexto

L0 (ex-Descobrir) e L1 existiam com nomes e skills fragmentados. A consulta
não descia camadas de forma disciplinada; projeção humana misturava-se ao index.

## Decisão

1. Skills de camada: **`explorer-l0`**, **`explorer-l1`**, **`explorer-l2`**
   (`explorer-l3` deferred).
2. Orquestração: **`explorer-query`** (`ensure`, `answer`/`context-pack`,
   `generate-human`, `list-projections`).
3. **Build ↑** L0→L1→L2; **Query ↓** L2→L1→L0→code pointers.
4. Projeção humana: **repo primary** (`.explorer/L{N}.md`), **on-demand**
   (`generate-human`), nunca implícita no accept/stitch.
5. Store canônico permanece SQLite; Markdown não é fonte de verdade.
6. Testes de pipeline: fixtures herméticas no harness (sem monorepo de domínio
   como acceptance de CI).
7. Incremental graph: epic futuro.

## Consequências

- Aliases legados: `/descobrir`, `/l1`, `/graph-system`.
- XDG data path pode manter o nome `descobrir` por compatibilidade de dados.
- Agente de consulta deve preferir `explorer-query answer` a grep amplo.
