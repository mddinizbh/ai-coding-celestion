import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the explorer-* skill trees live.
 * 1) EXPLORER_SKILLS_ROOT
 * 2) package bundled ./skills (npm install)
 * 3) monorepo ../../skills (dev from packages/explorer-skills)
 */
export function resolveSkillsRoot(fromImportMetaUrl = import.meta.url) {
  if (process.env.EXPLORER_SKILLS_ROOT) {
    const p = process.env.EXPLORER_SKILLS_ROOT;
    if (!existsSync(join(p, "explorer-l0"))) {
      throw new Error(`EXPLORER_SKILLS_ROOT missing explorer-l0: ${p}`);
    }
    return p;
  }

  const here = dirname(fileURLToPath(fromImportMetaUrl));
  // src/ → package root
  const pkgRoot = join(here, "..");
  const bundled = join(pkgRoot, "skills");
  if (existsSync(join(bundled, "explorer-l0", "install.mjs"))) {
    return bundled;
  }

  const mono = join(pkgRoot, "..", "..", "skills");
  if (existsSync(join(mono, "explorer-l0", "install.mjs"))) {
    return mono;
  }

  throw new Error(
    "Could not find explorer skills. Run npm pack from harness (prepack sync) or set EXPLORER_SKILLS_ROOT.",
  );
}
