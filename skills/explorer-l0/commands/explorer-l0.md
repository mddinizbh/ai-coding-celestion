---
description: >
  Explorer L0 — index one Git project into a baseline candidate
  (prepare → Explorer chunks → finalize). Alias of the old /descobrir.
---

# /explorer-l0

Run the global `explorer-l0` skill for: $ARGUMENTS

<!-- explorer-l0-install-owned:v1 -->

You are executing the strict one-invocation **explorer-l0** protocol (Project
Knowledge Graph micro layer). Take project/config intent from `$ARGUMENTS`
(Git project path, optional `namespace`, `logical-repo`, `source-revision`),
then run the four phases **in order**. Do not invent intermediate draft JSON,
do not run Graphify manually, do not auto-accept baselines, and do not skip a phase.

## Phase order (strict)

1. **setup-status** — `node skills/explorer-l0/cli.mjs setup-status`
   If `installed === false` OR `matches_pin === false`, stop and tell the user
   to run `node skills/explorer-l0/cli.mjs setup`.
2. **prepare** — `node skills/explorer-l0/cli.mjs prepare` with flags from `$ARGUMENTS`.
3. **Explorer chunk dispatch** — one payload per `chunk_key` under the run root
   (`explorer/payloads/<chunk_key>.json`), closed Explorer contract from SKILL.md.
4. **finalize** — `node skills/explorer-l0/cli.mjs finalize --run-root … --db … --source-repo …`

Human Gate accept is **explicit** only (`cli.mjs accept`). Never auto-accept.

Skill root after install: `~/.agents/skills/explorer-l0` (alias `~/.agents/skills/descobrir`).
