---
name: explorer-audit
description: >
  Audit an accepted L1 graph. Use when the user says valida o grafo, auditor
  B/C, sample exact/template edges, or registrar Observations de cobertura.
  Does not stitch, accept, rewrite comprovado, or alter the Human Gate.
---

# explorer-audit — conferir o grafo, não gerá-lo

Depois do L1. Amostra ligações, lê código **pinado**, registra omissão.
Journal: `explorer-ops`. Grafo intocado.

CLI: `node skills/explorer-audit/cli.mjs`.

## Ritual

1. `sample --namespace <ns>` — se `blocked`/`no_l1_edges`, pare.
2. Classe **B**: para cada edge do sample (`exact` e `template`), `show` no
   `file`/`revision` da evidência. Marque confirmado, rejeitado ou indecidível.
   Rejeitado = o código pinado não sustenta o contrato.
3. Classe **C**: gere Observations da revisão pinada:

```bash
node skills/explorer-audit/cli.mjs observations \
  --namespace <ns> --run-id <run_id> \
  --repos a=/abs/a --revision <sha>
```

   `NEEDS_REVIEW` permanece como saiu do detector. Não promova por proximidade,
   nome ou inferência. `omissions` continua disponível como relatório legado de
   hits por família; hit nunca vira aresta.
4. Grave todo o lote válido no journal com o mesmo `run_id` e revisão. Passe
   JSON literal, não filename:

```bash
node skills/explorer-ops/cli.mjs record-outcome \
  --input-json '{"run":{"run_id":"<run_id>","namespace":"<ns>","phase":"audit","status":"ok","logical_repos":["a"],"source_revision":"<sha>","started_at":"<iso>"},"observations":[...]}'
```

Somente `AUTO_CONFIRMED` e `HUMAN_CONFIRMED` promovem `CoverageGap`.
Na V1, auto-confirmação é restrita a `cross-repo-http`; revisão do gap é
independente do Human Gate do baseline.

## Pronto quando

Pedido “valida o grafo” num namespace com L1 → relatório por classe, todas as
Observations válidas persistidas e nenhum `NEEDS_REVIEW` promovido.
