---
name: db-setup
description: Configura acesso PostgreSQL para os agentes AI Dev. Gera .mcp.json e settings.local.json com os MCP servers de leitura e escrita.
model: sonnet
allowed-tools: Read, Glob, Grep, Bash, Write, Edit, AskUserQuestion
---

# Skill /db-setup — Configuracao PostgreSQL para AI Dev Agents

Voce e uma skill interativa que configura o acesso ao PostgreSQL para o framework ai-dev-agents. Seu trabalho e perguntar as informacoes necessarias ao usuario e gerar os arquivos de configuracao MCP corretos.

**Sempre responda em Portugues Brasileiro (pt-BR).**

## Fluxo de Execucao

### 1. Coletar Informacoes do Usuario

**Pergunta 1 — Connection String:**

Use AskUserQuestion para perguntar ao usuario:

```
Qual e a connection string do seu banco PostgreSQL?

Formato esperado: postgresql://usuario:senha@host:porta/banco

Exemplos:
  postgresql://admin:senha123@localhost:5432/meudb
  postgresql://postgres:@localhost:5432/dev
  postgresql://user:pass@db.example.com:5432/production

Digite a connection string:
```

Armazene a resposta como CONNECTION_STRING.

**Pergunta 2 — Agentes com acesso de escrita:**

Use AskUserQuestion para perguntar:

```
Quais agentes devem ter acesso de ESCRITA no banco?

O MCP writer permite INSERT, UPDATE, DELETE alem de leitura.
O MCP reader e somente leitura.

Opcoes:
  1. coder
  2. tester
  3. orchestrator
  4. todos

Digite os numeros separados por virgula, ou "todos" para liberar para todos:
```

Armazene a resposta como WRITE_AGENTS.

### 2. Determinar Path do Projeto

Use Bash para descobrir o diretorio raiz do projeto onde a skill esta sendo executada:

```bash
pwd
```

Armazene como PROJECT_ROOT.

### 3. Gerar `.mcp.json`

Crie o arquivo `{PROJECT_ROOT}/.mcp.json` com o seguinte conteudo, substituindo CONNECTION_STRING pelo valor coletado:

```json
{
  "mcpServers": {
    "pg-reader": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "CONNECTION_STRING"]
    },
    "pg-writer": {
      "command": "node",
      "args": ["~/.claude/mcp-server/dist/index.js", "CONNECTION_STRING"]
    }
  }
}
```

**IMPORTANTE:** O path do MCP writer server instalado e `~/.claude/mcp-server/dist/index.js`.

Se o arquivo `.mcp.json` ja existir, leia o conteudo atual antes de sobrescrever e avise o usuario que o arquivo sera sobrescrito.

Adicione `.mcp.json` ao `.gitignore` do projeto se o arquivo `.gitignore` existir — a connection string nao deve ser versionada.

### 4. Gerar `.claude/settings.local.json`

Verifique se o diretorio `.claude/` existe no projeto. Se nao existir, crie-o.

Verifique se `.claude/settings.local.json` ja existe:
- Se existir: leia o conteudo atual, mescle as configuracoes de `mcpServers` sem perder outras configuracoes presentes
- Se nao existir: crie do zero

Crie/atualize `{PROJECT_ROOT}/.claude/settings.local.json` com:

```json
{
  "mcpServers": {
    "pg-reader": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "CONNECTION_STRING"]
    },
    "pg-writer": {
      "command": "node",
      "args": ["~/.claude/mcp-server/dist/index.js", "CONNECTION_STRING"]
    }
  }
}
```

Adicione `.claude/settings.local.json` ao `.gitignore` se ainda nao estiver listado.

### 5. Validar Conexao com o Banco

Tente validar a conexao usando `pg_isready` ou `psql`:

```bash
# Tenta pg_isready primeiro (mais rapido)
pg_isready -d "CONNECTION_STRING" 2>/dev/null

# Se pg_isready nao estiver disponivel, tenta psql
psql "CONNECTION_STRING" -c "SELECT 1;" 2>&1 | head -5
```

Reporte o resultado ao usuario:
- **Sucesso:** "Conexao com o banco validada com sucesso!"
- **Falha:** "Nao foi possivel validar a conexao. Verifique a connection string e se o banco esta acessivel. Os arquivos de configuracao foram gerados assim mesmo — voce pode tentar novamente apos corrigir."

### 6. Informar sobre Restart

Apos gerar os arquivos, informe o usuario:

```
Configuracao concluida!

Arquivos gerados:
  - .mcp.json (MCP servers reader e writer)
  - .claude/settings.local.json (configuracoes locais com credenciais)

IMPORTANTE: Voce precisa restartar o Claude Code para que os MCP servers
sejam carregados. Feche e reabra o Claude Code neste projeto.

Apos o restart, os seguintes MCP servers estarao disponiveis:
  - pg-reader: leitura no PostgreSQL (npx @modelcontextprotocol/server-postgres)
  - pg-writer: leitura e escrita no PostgreSQL (~/.claude/mcp-server/dist/index.js)
```

## Regras

- **Nao execute SQL** — apenas configure os MCP servers
- **Nao exponha a connection string** nos logs mais do que o necessario
- **Se o usuario cancelar** qualquer pergunta, pare a execucao sem criar arquivos parciais
- **Se `.mcp.json` ja existir**, avise antes de sobrescrever
- **O path do MCP writer** e sempre `~/.claude/mcp-server/dist/index.js` — nao pergunte ao usuario
- **O MCP reader** usa npx: `npx -y @modelcontextprotocol/server-postgres`
