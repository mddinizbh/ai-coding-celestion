#!/usr/bin/env node
/**
 * Copy harness skills into this package for npm pack/publish.
 * Source: <repo>/skills/explorer-*
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repoSkills = join(pkgRoot, "..", "..", "skills");
const destRoot = join(pkgRoot, "skills");

const NAMES = ["explorer-l0", "explorer-l1", "explorer-l2", "explorer-query", "explorer-ops", "explorer-audit"];

if (!existsSync(join(repoSkills, "explorer-l0"))) {
  console.error(`sync-skills: harness skills not found at ${repoSkills}`);
  process.exit(1);
}

rmSync(destRoot, { recursive: true, force: true });
mkdirSync(destRoot, { recursive: true });

for (const name of NAMES) {
  const src = join(repoSkills, name);
  if (!existsSync(src)) {
    console.error(`missing skill: ${src}`);
    process.exit(1);
  }
  cpSync(src, join(destRoot, name), {
    recursive: true,
    filter: (p) => !p.includes(`${name}/test`) && !p.includes(`${name}/e2e`),
  });
  console.log(`synced ${name}`);
}

// also sync agent command markdowns (canonical sources for /explorer-indexer and /explorer-auditor) so packaged tarball includes every referenced source
for (const f of ["explorer-indexer.md", "explorer-auditor.md"]) {
  const src = join(pkgRoot, "..", "..", "agents", "opencode", "commands", f);
  if (existsSync(src)) {
    cpSync(src, join(destRoot, f));
    console.log(`synced command source ${f}`);
  }
}

writeFileSync(
  join(destRoot, ".synced-from"),
  `${repoSkills}\n${new Date().toISOString()}\n`,
);
console.log(`ok → ${destRoot}`);
