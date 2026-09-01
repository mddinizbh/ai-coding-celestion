# opencode-observability (Milestone 0)

Minimal TypeScript plugin for OpenCode V2 beta that observes `ctx.session.hook("context")` dispatches.

Emits one metadata-only JSON line to stderr:
`{"sessionID":"...","agent":"...","provider":"...","model":"...","systemCount":N,"messageCount":N,"toolCount":N,"serializedChars":N,"utf8Bytes":N,"timestamp":"..."}`

## Beta assumption (IMPORTANT)
This package pins **@opencode-ai/plugin@0.0.0-beta-18743** (promise API with Plugin.define + SessionContext).
It is incompatible with the repository's stable @opencode-ai/plugin 1.18.x (no session.context hook, different Hooks shape).
Load only via local package in a beta OpenCode runtime. Do not mix with stable pins in .opencode/package.json.

## Local configuration (beta only)
In a project-level `opencode.jsonc` at the repository root:
```jsonc
{
  "plugins": [
    "./packages/opencode-observability/src/index.ts"
  ]
}
```

For a global config such as `~/.config/opencode/opencode.jsonc`, replace the
relative entry with the absolute path to `src/index.ts`. Restart OpenCode.

## Commands / usage
No slash commands. The observer is passive.
From the repository root, run `opencode`. Every context dispatch emits one
JSONL line on stderr.

Expected output example:
`{"sessionID":"ses_abc","agent":"default","provider":"anthropic","model":"claude-3-5-sonnet-20241022","systemCount":2,"messageCount":5,"toolCount":3,"serializedChars":1240,"utf8Bytes":1240,"timestamp":"2026-09-01T16:41:45.938Z"}`

## Privacy behavior
- Default output contains ONLY counts, IDs, sizes, timestamp.
- NEVER logs system/messages/tools content, generation values, providerOptions, prompts, bodies, or tool outputs.
- No persistence, no SQLite, no files written.
- Sink injection is internal test seam only.

## Deterministic + fail-open
Measurement uses injected clock for exact timestamp. Sink and reporter failures are contained via Result; callback never throws. Internal factory seam supports test injection.

## Verification (dev)
```bash
cd packages/opencode-observability
bun install
bun test
bunx tsc --noEmit -p tsconfig.json
```
All under 250 pure LOC per file. TDD: red (module not found) → green.

## Mismatch note
Stable 1.18.11 types (in ~/.config/opencode/node_modules) expose only legacy Hooks (event, chat.message, tool, auth, provider). No SessionContext or session.hook. This package requires the exact beta.
