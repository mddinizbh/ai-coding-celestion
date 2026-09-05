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

O token não expira por tempo. Fica no `sessionStorage` da aba, separado do histórico, para que F5 continue funcionando. Um novo link de lançamento substitui o token salvo. Se o navegador bloquear esse armazenamento, a abertura pelo comando ainda funciona, mas a recarga exige reabrir o link. Após reiniciar o plugin, use `/celestion-history` novamente, pois o servidor tem outro token e pode usar outra porta. Uma resposta 401 limpa o acesso salvo e interrompe as tentativas automáticas. Falhas de conexão não apagam o token.

## Histórico e persistência

Usa `StorageDomain` do OpenCode. Hidrata após restart. Armazena apenas metadados sanitizados. Retém padrão de 5.000 eventos por run.

O dashboard abre em **All sessions**, reunindo todas as conversas registradas no histórico disponível ao plugin. A sessão de onde o comando foi chamado não limita essa visão. A lateral mostra todas as árvores, com controles para selecionar uma sessão ou sua subárvore. Sessões de sistema continuam ocultas por padrão. Na visão global, eventos de novas sessões também atualizam a lateral sem precisar reabrir a aba.

As consultas HTTP e SSE aceitam `scope=all`, sem `rootSessionID` nem `selectedSessionID`. Os escopos `session` e `subtree` continuam exigindo esses IDs. Páginas não vazias incluem `newerCursor` para atualização ao vivo, separado de `nextCursor`, que mantém a continuação da paginação.

Na conexão global sem cursor, o SSE assina os eventos ao vivo antes de reler o histórico disponível. Isso cobre o intervalo entre uma página inicialmente vazia e a conexão. Eventos repetidos são deduplicados. A lateral também é reconciliada com as páginas recebidas, e chegadas durante uma atualização pendente provocam uma nova leitura.

- Página de consulta: 200 eventos por padrão e no máximo.
- Limite no browser: 1.000 eventos.
- Título sanitizado: até 160 caracteres.
- Fallback SSE: após 3 falhas, polling de 2.000 ms.

Desktop-only. Sem suporte mobile declarado.

## Privacidade (exclusões exatas)

O histórico nunca persiste nem expõe:
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
