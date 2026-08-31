---
name: explorer-audit
description: >
  Audit an accepted L1 graph. Use when the user says valida o grafo, auditor
  B/C, sample exact/template edges, or L1 omissions (HTTP/Kafka/Python).
  Does not stitch, accept, or rewrite comprovado.
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
3. Classe **C**: `omissions --namespace <ns> --repos a=/abs --revision <sha>`.
   Cada hit é omissão, não aresta nova.
4. Relatório por classe. Grave o journal:

```bash
node skills/explorer-ops/cli.mjs log \
  --phase audit --status ok \
  --namespace <ns> \
  --detail '{"exact":{"confirmed":n,"rejected":n,"undecidable":n}}' \
  --challenge l1_omission \
  --challenge-detail "python file:line"
```

`--challenge` só quando houver rejeição ou omissão. Códigos: `audit_rejected`,
`l1_omission`.

## Pronto quando

Pedido “valida o grafo” num namespace com L1 → relatório por classe e, se
houver achado, linhas em `challenges`.
