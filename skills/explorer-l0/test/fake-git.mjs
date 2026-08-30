/**
 * Test helper: fake `git` binary that delegates to real git except hanging subcommands.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** @returns {string} absolute path to real git */
export function realGitPath() {
  return execFileSync("/bin/sh", ["-c", "command -v git"], {
    encoding: "utf8",
    shell: false,
  }).trim();
}

/**
 * @param {{ hangOn?: string[], realGit?: string }} [opts]
 * hangOn: substrings matched against joined argv (e.g. "worktree remove", "rev-parse")
 * Matching is token-boundary aware for multi-word needles.
 * @returns {{ gitBin: string, dir: string, realGit: string }}
 */
export function installFakeGit(opts = {}) {
  const hangOn = opts.hangOn ?? [];
  const realGit = opts.realGit ?? realGitPath();
  const dir = mkdtempSync(join(tmpdir(), "descobrir-fake-git-"));
  const gitBin = join(dir, "git");
  // Forward stdout/stderr explicitly so parent execFileSync pipes receive output.
  const script = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const realGit = ${JSON.stringify(realGit)};
const hangOn = ${JSON.stringify(hangOn)};
const args = process.argv.slice(2);
const joined = args.join(" ");
function shouldHang(joinedArgs, needles) {
  for (const needle of needles) {
    if (!needle) continue;
    // Prefer exact multi-token subsequence match.
    if (joinedArgs === needle || joinedArgs.startsWith(needle + " ") || joinedArgs.includes(" " + needle + " ") || joinedArgs.endsWith(" " + needle)) {
      return true;
    }
    // Also allow plain includes for single tokens like "rev-parse".
    if (!needle.includes(" ") && joinedArgs.split(" ").includes(needle)) return true;
  }
  return false;
}
if (shouldHang(joined, hangOn)) {
  setInterval(() => {}, 1 << 30);
  return;
}
const r = spawnSync(realGit, args, {
  stdio: ["ignore", "pipe", "pipe"],
  cwd: process.cwd(),
  env: process.env,
  encoding: "buffer",
  maxBuffer: 16 * 1024 * 1024,
});
if (r.error) {
  process.stderr.write(String(r.error.stack || r.error));
  process.exit(127);
}
if (r.stdout && r.stdout.length) process.stdout.write(r.stdout);
if (r.stderr && r.stderr.length) process.stderr.write(r.stderr);
process.exit(r.status == null ? 1 : r.status);
`;
  writeFileSync(gitBin, script, { encoding: "utf8" });
  chmodSync(gitBin, 0o755);
  return { gitBin, dir, realGit };
}
