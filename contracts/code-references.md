# code_references — padrão de todos os handoffs

Ponteiro, não dump. O próximo agent **lê esses paths**. Não cola corpo de arquivo no yaml/md.

## Formato

```yaml
code_references:
  - path: src/main/kotlin/.../CrlvFlowOrchestrator.kt
    why: "entrada do fluxo; chain por UF"
  - path: .explorer/L1.md
    why: "arestas SP → DataCube"
```

- `path` — absoluto no repo, arquivo que existe.
- `why` — uma linha. Sem isso o próximo agent reabre o repo inteiro.
- Sem `content`. Sem trecho de código. Sem pasta-raiz (`src/`).

Opcional: `symbol` (classe/função) se o path sozinho for grosso demais.

## Cadeia

Cada etapa **herda e aperta**:

```
brainstorm  → o que importa pra decidir
arquiteto   → + contratos/interfaces que o SDD cita
planner     → + arquivos que cada task mexe
coder       → files_created / files_changed (o que de fato tocou)
```

Não joga fora o que o anterior apontou, a menos que tenha sido desmentido.

## Tokens

Ler 8 arquivos certos << grep do módulo. Se a lista passar de ~15, está gorda: o agent não escolheu.
