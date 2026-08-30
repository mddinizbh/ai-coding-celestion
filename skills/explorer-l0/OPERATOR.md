# Descobrir — guia do operador

## Pré-requisitos

- Node.js com `node:sqlite` (v22+/v26)
- Git
- `uv` (para setup do Graphify)
- OpenCode (para `/descobrir` e Explorer)

## Setup (uma vez)

```bash
# Do checkout do ai-dev-harness (ou de qualquer path onde a skill viva):
node skills/descobrir/install.mjs install
node skills/descobrir/cli.mjs setup
node skills/descobrir/cli.mjs setup-status
```

**Quit e restart OpenCode** após install/uninstall para recarregar skills/commands.

Graphify é pinado em **`graphifyy==0.9.32`**. Runs normais **não** auto-instalam.

## Uso one-invocation (OpenCode)

Em qualquer repositório Git:

```text
/descobrir <projeto ou path>
```

Fases (código + Explorer):

1. `setup-status` — falha com instrução de setup se Graphify ausente/errado
2. `prepare` — worktree + Graphify + chunks + descriptor
3. Explorer por chunk — só semântica em `explorer/payloads/`
4. `finalize` — verifica, persiste candidate
5. Retry seletivo de chunks com blockers (até limite fixo)

**Você não** escreve JSON intermediário nem roda Graphify na mão.

## CLI determinística

```bash
node skills/descobrir/cli.mjs prepare \
  --namespace <ns> --logical-repo <repo> --project-path <abs>

node skills/descobrir/cli.mjs finalize \
  --run-root <abs-run> --db <sqlite> --source-repo <abs>

node skills/descobrir/cli.mjs accept --db <sqlite> \
  --candidate-id <id> --approver "Nome"

node skills/descobrir/cli.mjs export --db <sqlite> \
  --accepted --namespace <ns> --logical-repo <repo> --output out.json

node skills/descobrir/cli.mjs project-obsidian --db <sqlite> \
  --namespace <ns> --logical-repo <repo> --out <dir>

node skills/descobrir/cli.mjs status
node skills/descobrir/cli.mjs cleanup --stale
node skills/descobrir/cli.mjs cleanup --run-id <id>
```

`persist-candidate` permanece para testes/compat; **não** verifica bytes do
repositório — use `finalize` em produção.

## Ownership

| Etapa | Dono |
|---|---|
| Graphify extract + manifest + hashes + IDs + coverage | Código (`prepare`/`finalize`) |
| type/name/summary/relations intent | Explorer (LLM) |
| Accept baseline | Humano |
| Obsidian Markdown | Projeção one-way do aceito |

## Paths

| Artefato | Default |
|---|---|
| SQLite | `${XDG_DATA_HOME:-~/.local/share}/descobrir/<ns>.sqlite` |
| Runs | `${XDG_CACHE_HOME:-~/.cache}/descobrir/runs/<run-id>/` |
| Skill global | `~/.agents/skills/descobrir` → symlink live |
| Comando | `~/.config/opencode/commands/descobrir.md` |

## Exit codes

| Code | Significado |
|---|---|
| 0 | OK |
| 1 | Erro de infra / typed error |
| 2 | Blockers semânticos no `finalize` (sem write no DB; run preservado) |

## Recovery

- `status` lista runs sob o cache
- `cleanup --stale` remove incompletos e tenta limpar worktrees leftover
- `cleanup --run-id <id>` remove um run específico
- **Nunca** apaga candidates/accepted no SQLite

## Verificação

```bash
node --test skills/descobrir/test/*.test.mjs
node skills/descobrir/e2e/run.mjs --graphify fake
# opcional (rede + uv):
node skills/descobrir/e2e/run.mjs --graphify real
```

## Fora de escopo (não entregue)

- L1/L2 cross-service stitching
- Neo4j / grafo normalizado
- Docker deploy
- Auto-accept
- Vault Obsidian como fonte de verdade
