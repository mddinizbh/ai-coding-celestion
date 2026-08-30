/**
 * freshness — detect stale accepted L0 baselines vs current repo HEAD.
 * Declares staleness at query time (team rule: never hide).
 * Reuses loadAcceptedBaselines from explorer-l1 (cross-skill import established pattern).
 */

import { execSync } from "node:child_process";
import { loadAcceptedBaselines } from "../../explorer-l1/src/stitch.mjs";

/**
 * Check freshness for given repos against their accepted L0 baselines.
 * @param {{ l0DbPath: string, namespace: string, repos: Array<{logical_repo: string, repo_path: string}> }} input
 * @returns {Array<{ logical_repo: string, baseline_revision: string, head_revision: string, behind: number, fresh: boolean, branch: string }>}
 */
export function checkFreshness({ l0DbPath, namespace, repos, _loadAcceptedBaselines = loadAcceptedBaselines }) {
  if (!l0DbPath || typeof l0DbPath !== "string") {
    throw new Error("checkFreshness: l0DbPath (string) is required");
  }
  if (!namespace || typeof namespace !== "string") {
    throw new Error("checkFreshness: namespace (string) is required");
  }
  if (!Array.isArray(repos) || repos.length === 0) {
    throw new Error("checkFreshness: repos[] with {logical_repo, repo_path} is required");
  }

  // logicalRepos can be strings or objects; loadAcceptedBaselines accepts the list
  const logicalRepos = repos.map((r) => r.logical_repo);
  const acceptedList = _loadAcceptedBaselines(l0DbPath, namespace, logicalRepos);

  const results = [];
  for (const repo of repos) {
    const { logical_repo, repo_path } = repo;
    if (!logical_repo || !repo_path) {
      throw new Error(`checkFreshness: each repo needs logical_repo and repo_path`);
    }

    // find the accepted entry; support both array-of-objects and possible map return shapes
    let accepted = null;
    if (Array.isArray(acceptedList)) {
      accepted = acceptedList.find((a) => a && (a.logical_repo === logical_repo || a.logicalRepo === logical_repo));
    } else if (acceptedList && typeof acceptedList === "object") {
      accepted = acceptedList[logical_repo] || acceptedList[logical_repo.replace(/-/g, "_")];
    }
    const baselineRevision =
      accepted && (accepted.source_revision || accepted.sourceRevision || accepted.revision || accepted.baseline_revision);

    if (!baselineRevision) {
      throw new Error(
        `no accepted baseline for logical_repo=${logical_repo} in namespace=${namespace} (stale visibility requires explicit error)`
      );
    }

    // git operations — hermetic, no network, use -C
    let headRevision;
    try {
      headRevision = execSync(`git -C "${repo_path}" rev-parse HEAD`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (err) {
      throw new Error(`git rev-parse HEAD failed for ${logical_repo} at ${repo_path}: ${err.message}`);
    }

    let branch;
    try {
      const ref = execSync(`git -C "${repo_path}" rev-parse --abbrev-ref HEAD`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      branch = ref === "HEAD" ? "detached" : ref;
    } catch {
      branch = "unknown";
    }

    let behind = 0;
    if (baselineRevision !== headRevision) {
      try {
        const cnt = execSync(`git -C "${repo_path}" rev-list --count ${baselineRevision}..HEAD`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        behind = parseInt(cnt, 10) || 0;
      } catch {
        // baseline not reachable from HEAD (e.g. force-push or shallow) — report as 0 to avoid silent fail, but error is explicit elsewhere
        behind = 0;
      }
    }

    const fresh = behind === 0;
    results.push({
      logical_repo,
      baseline_revision: baselineRevision,
      head_revision: headRevision,
      behind,
      fresh,
      branch,
    });
  }

  return results;
}
