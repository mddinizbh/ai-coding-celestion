# opencode-observability

Plugin TypeScript para OpenCode V2 beta que adiciona `/celestion-debug`, sidebar de métricas no TUI e comando `/celestion-history` com dashboard em browser.

A versão do plugin está fixada em `@opencode-ai/plugin@0.0.0-beta-18743`. O smoke test usa `@opencode-ai/cli@0.0.0-beta-18866`. O pacote não é compatível com OpenCode estável 1.x.

Raiz do pacote expõe `index.ts` (plugin principal) e `tui.ts` (entrada TUI com sidebar e debug).

## Configuração local (beta V2)

Em `opencode.jsonc` na raiz do repositório:

```jsonc
{
  "plugins": ["./packages/opencode-observability"]
}
```

O loader beta descobre os dois entrypoints. Não aponte a configuração apenas para `src/index.ts`.

## Comandos

- `/celestion-debug`: expõe métricas e estado via TUI.
- `/celestion-history`: inicia servidor sob demanda (uma única instância reutilizada), abre requisição de browser a cada chamada, para no cleanup do plugin.

Servidor escuta apenas em `127.0.0.1` em porta escolhida pelo sistema. Token de lançamento vai no fragmento da URL; cliente remove antes das requisições. Rotas de dados/health/SSE exigem Bearer exato e same-origin exato quando Origin presente. Assets estáticos do shell não contêm dados de histórico e carregam antes da auth.

## Histórico e persistência

Usa `StorageDomain` do OpenCode. Hidrata após restart. Armazena apenas metadados sanitizados. Retém padrão de 5.000 eventos por run.

- Página de consulta: 200 eventos por padrão e no máximo.
- Limite no browser: 1.000 eventos.
- Título sanitizado: até 160 caracteres.
- Fallback SSE: após 3 falhas, polling de 2.000 ms.

Desktop-only. Sem suporte mobile declarado.

## Privacidade (exclusões exatas)

Nunca persiste nem expõe:
- corpos de prompt/message
- input/output bruto de tools
- corpos de generation
- provider options
- headers/valores de auth
- secrets
- paths irrestritos
- stacks/erros crus

Metadados permitidos: counts/sizes, tipo de evento, labels de provider/model/agent, IDs/linhagem, título sanitizado.

## Shutdown

Automático no cleanup do OpenCode/plugin. Drena persistência e fecha recursos de SSE/servidor.

## Verificação

Na raiz do repositório:

```bash
cd packages/opencode-observability
bun install
bun test
bun run typecheck
bun test test/history-dashboard-acceptance.test.ts test/history-dashboard-privacy.test.ts
```

O smoke de runtime exige metadados locais e sanitizados de uma sessão já preparada. Ele é evidência de manutenção, não um script público do pacote. Execute na raiz do repositório:

```bash
bun run .omo/evidence/task-21-runtime-smoke/harness.mjs
```
