# Agents OpenCode (fluxo de código)

Uma classe por papel. Cada invocação é um `new` (cwd + prompt + AGENTS.md do repo).

Você é o service até existir run de verdade. Depois: `@workflow`.

```
brainstorm  → visão.md
arquiteto   → SDD
planner     → tasks
orchestrator → coder → reviewer → tester
```

Allow-list de skill no frontmatter. Não copiar SKILL.md pro agent.

Contratos: `../../contracts/` (`brainstorm-visao.md`, `code-references.md`).
