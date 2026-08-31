# Agents

Uma classe por papel. Cada invocação é um `new` (cwd + prompt + AGENTS.md do repo).

## Estrutura por plataforma

Agent é **acoplado a plataforma** (frontmatter: mode, permission, model) — por
isso a pasta é por plataforma. Skill é **portável** (contrato SKILL.md + CLI
Node) e fica global em `../skills/`.

```text
agents/
├── opencode/            ← OpenCode (formato atual)
│   ├── brainstorm.md        roster
│   ├── explorer-indexer.md  roster
│   ├── explorer-auditor.md  roster
│   └── roles/               subagentes de tier (binding de modelo é local)
│       ├── explorer-worker.md
│       ├── explorer-matcher.md
│       └── explorer-synth.md
└── copilot/             🔜 quando o time precisar (formato que a MS definir)
```

**Regra:** plataforma mora em `agents/<plataforma>/` e no installer
(`install --target ...`); conhecimento mora em `skills/` global. Categorias de
roster (`discovery/`, `pipeline/`, ...) só quando os agents existirem de
verdade — não criar pasta especulativa.

## Fluxo de código (quando o roster existir)

```text
brainstorm    → visão.md
arquiteto     → SDD
planner       → tasks
orchestrator  → coder → reviewer → tester
```

Allow-list de skill no frontmatter. Não copiar SKILL.md pro agent.

Contratos: `../contracts/` (`brainstorm-visao.md`, `code-references.md`).
