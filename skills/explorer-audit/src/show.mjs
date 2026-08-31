/**
 * Read a pinned file around a line. Working tree is never the source.
 */

import { readAtRevision } from "../../explorer-l0/src/git-reader.mjs";

/**
 * @param {{
 *   repo_path: string,
 *   revision: string,
 *   file: string,
 *   line: number,
 *   context?: number,
 * }} input
 */
export function showPinned(input) {
  const context = Number.isInteger(input.context) && input.context >= 0 ? input.context : 8;
  const line = Number(input.line);
  if (!Number.isInteger(line) || line < 1) {
    throw new Error("--line must be a positive integer");
  }
  const buf = readAtRevision({
    cwd: input.repo_path,
    revision: input.revision,
    path: input.file,
  });
  const lines = buf.toString("utf8").split("\n");
  const from = Math.max(1, line - context);
  const to = Math.min(lines.length, line + context);
  /** @type {{ n: number, text: string, mark: boolean }[]} */
  const window = [];
  for (let n = from; n <= to; n += 1) {
    window.push({ n, text: lines[n - 1] ?? "", mark: n === line });
  }
  return {
    file: input.file,
    revision: input.revision,
    line,
    window,
  };
}
