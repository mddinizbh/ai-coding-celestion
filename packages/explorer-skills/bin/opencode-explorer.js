#!/usr/bin/env node
/**
 * opencode-explorer — one command to install Explorer skills for OpenCode.
 *
 *   npx opencode-explorer install
 *   npx opencode-explorer setup
 *   npx opencode-explorer status
 *   npx opencode-explorer uninstall
 */

import {
  runAll,
  setupGraphify,
  setupStatus,
} from "../src/install-all.mjs";

const HELP = `opencode-explorer — OpenCode Explorer skills (L0–L2 + query)

Usage:
  opencode-explorer install     Symlink skills + commands into ~/.agents and ~/.config/opencode
  opencode-explorer setup       Install pinned Graphify (uv tool, once per machine)
  opencode-explorer setup-status
  opencode-explorer status      Show install state
  opencode-explorer uninstall   Remove owned skill links/commands only

After install: quit and restart OpenCode, then use:
  /explorer-l0      index one service
  /explorer-l1      stitch system edges
  /explorer-l2      bind journeys
  /explorer-query   ensure / answer / generate-human

Dev (deste monorepo):
  node packages/explorer-skills/bin/opencode-explorer.js install
`;

async function main(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  try {
    switch (cmd) {
      case "install": {
        const result = await runAll("install");
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.stdout.write(`\n${result.restart_guidance}\n`);
        process.stdout.write(
          "Next: opencode-explorer setup   # Graphify once\n",
        );
        return 0;
      }
      case "status": {
        const result = await runAll("status");
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      case "uninstall": {
        const result = await runAll("uninstall");
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.stdout.write(`\n${result.restart_guidance}\n`);
        return 0;
      }
      case "setup":
        return setupGraphify();
      case "setup-status":
        return setupStatus();
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
