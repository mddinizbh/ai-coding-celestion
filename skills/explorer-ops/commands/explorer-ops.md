---
description: Journal e memória do Explorer. Lista desafios, carrega gaps, grava outcomes e resolve gaps.
---

# /explorer-ops

Siga `skills/explorer-ops/SKILL.md`.

Argumentos: $ARGUMENTS

Se o usuário pediu desafios / o que já falhou: `cli.mjs challenges --limit 20`.
Se acabou uma fase: `cli.mjs log --phase … --status …`.
Se vai auditar cobertura: `cli.mjs load-context --scope-json … --objective …`.
Se recebeu Observations: `cli.mjs record-outcome --input-json …`; preserve
`NEEDS_REVIEW`. Só use `cli.mjs resolve-gap` com evidência aceita ou fechamento
humano explícito. Nenhuma operação altera o Human Gate do baseline.
