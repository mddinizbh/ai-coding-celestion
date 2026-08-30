/**
 * On-demand human projection writer — repo primary (.explorer/L{N}.md).
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {{
 *   repo_root: string,
 *   layer: "l0" | "l1" | "l2",
 *   meta: object,
 *   body_markdown: string,
 * }} input
 */
export function writeHumanProjection(input) {
  const dir = join(input.repo_root, ".explorer");
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const file = join(dir, `L${input.layer.slice(1)}.md`);
  const fm = [
    "---",
    `explorer_layer: ${input.layer}`,
    `generated_at: ${new Date().toISOString()}`,
    `generator: explorer-query`,
    ...Object.entries(input.meta || {}).map(
      ([k, v]) => `${k}: ${JSON.stringify(v)}`,
    ),
    "---",
    "",
  ].join("\n");
  writeFileSync(file, `${fm}${input.body_markdown.trim()}\n`, { mode: 0o644 });

  // update index
  const indexPath = join(dir, "index.json");
  /** @type {object} */
  let index = { projections: [] };
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(readFileSync(indexPath, "utf8"));
    } catch {
      index = { projections: [] };
    }
  }
  if (!Array.isArray(index.projections)) index.projections = [];
  index.projections = index.projections.filter((p) => p.layer !== input.layer);
  index.projections.push({
    layer: input.layer,
    path: `.explorer/L${input.layer.slice(1)}.md`,
    generated_at: new Date().toISOString(),
    meta: input.meta || {},
  });
  index.updated_at = new Date().toISOString();
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  return { path: file, index: indexPath };
}

/**
 * @param {object} pack  context pack or stitch result
 */
export function bodyFromL1Pack(pack) {
  const lines = [
    `# Explorer L1 — ${pack.system_namespace || "system"}`,
    "",
      "Projeção humana (não canônica). Fonte de verdade: SQLite `l1_system_edges`.",
    "",
    "## Hops",
    "",
  ];
  const hops = pack.hops || [{ edges: pack.edges || [] }];
  for (const h of hops) {
    lines.push(`### ${h.step_id || "edges"} (${h.status || "ok"})`);
    for (const e of h.edges || []) {
      lines.push(
        `- \`${e.from}\` → \`${e.to}\` · \`${e.contract_key}\` · ${e.match_kind} (${e.score})`,
      );
    }
    lines.push("");
  }
  if (pack.code_pointers?.length) {
    lines.push("## Code pointers", "");
    for (const p of pack.code_pointers.slice(0, 40)) {
      lines.push(`- \`${p.repo}\` ${p.file}:${p.line}`);
    }
  }
  return lines.join("\n");
}

/**
 * @param {string} repoRoot
 */
export function listProjections(repoRoot) {
  const indexPath = join(repoRoot, ".explorer", "index.json");
  if (!existsSync(indexPath)) return { projections: [] };
  return JSON.parse(readFileSync(indexPath, "utf8"));
}
