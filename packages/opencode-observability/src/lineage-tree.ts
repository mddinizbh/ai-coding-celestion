import type { SessionLineage } from './history-domain';

export type LineageDiagnostic = {
  readonly type: 'missing-parent' | 'cycle-detected';
  readonly sessionID: string;
};

export interface LineageNode extends SessionLineage {
  readonly children: readonly LineageNode[];
}

export interface LineageForest {
  readonly roots: readonly LineageNode[];
  readonly diagnostics: readonly LineageDiagnostic[];
}

export function buildSessionLineageForest(
  sessions: readonly SessionLineage[],
  { includeSystem = false }: { includeSystem?: boolean } = {}
): LineageForest {
  const byId = new Map<string, SessionLineage>();
  for (const s of sessions) {
    if (!byId.has(s.sessionID)) byId.set(s.sessionID, s);
  }
  const all = Array.from(byId.values());

  const parentOf = new Map<string, string | null>();
  for (const s of all) parentOf.set(s.sessionID, s.parentSessionID);

  const cycleMembers = new Set<string>();
  const color = new Map<string, 0 | 1 | 2>();
  const activePath: string[] = [];

  function dfs(u: string): void {
    color.set(u, 1);
    activePath.push(u);
    const p = parentOf.get(u);
    if (p && byId.has(p)) {
      const c = color.get(p);
      if (c === 1) {
        const idx = activePath.indexOf(p);
        if (idx !== -1) {
          for (const id of activePath.slice(idx)) cycleMembers.add(id);
        }
      } else if (c !== 2) {
        dfs(p);
      }
    }
    activePath.pop();
    color.set(u, 2);
  }

  for (const s of all) if (!color.has(s.sessionID)) dfs(s.sessionID);

  const diagnostics: LineageDiagnostic[] = [];
  for (const s of all) {
    const p = s.parentSessionID;
    if (p && !byId.has(p)) {
      diagnostics.push({ type: 'missing-parent', sessionID: s.sessionID });
    }
  }
  for (const id of cycleMembers) {
    diagnostics.push({ type: 'cycle-detected', sessionID: id });
  }
  const diagKey = (d: LineageDiagnostic) => `${d.type}:${d.sessionID}`;
  const dedupedDiags = Array.from(
    new Map(diagnostics.map((d) => [diagKey(d), d])).values()
  ).sort((a, b) => a.type.localeCompare(b.type) || a.sessionID.localeCompare(b.sessionID));

  const effectiveParent = new Map<string, string | null>();
  for (const s of all) {
    const orig = s.parentSessionID;
    if (cycleMembers.has(s.sessionID)) {
      effectiveParent.set(s.sessionID, null);
    } else if (orig && byId.has(orig)) {
      effectiveParent.set(s.sessionID, orig);
    } else {
      effectiveParent.set(s.sessionID, null);
    }
  }

  const childrenAdj = new Map<string, string[]>();
  for (const s of all) childrenAdj.set(s.sessionID, []);
  for (const s of all) {
    const ep = effectiveParent.get(s.sessionID);
    if (ep && byId.has(ep)) {
      const kids = childrenAdj.get(ep);
      if (kids) kids.push(s.sessionID);
    }
  }

  const getObs = (id: string) => byId.get(id)?.observedAtMs ?? 0;
  const siblingSort = (a: string, b: string) => {
    const d = getObs(a) - getObs(b);
    return d !== 0 ? d : a.localeCompare(b);
  };
  for (const kids of childrenAdj.values()) kids.sort(siblingSort);

  const rootIds = all
    .filter((s) => effectiveParent.get(s.sessionID) === null)
    .map((s) => s.sessionID)
    .sort(siblingSort);

  function getVisibleSubtree(id: string): readonly LineageNode[] {
    const s = byId.get(id);
    if (!s) return [];
    if (!includeSystem && s.kind === 'system') {
      const kids = childrenAdj.get(id) ?? [];
      return kids.flatMap((k) => getVisibleSubtree(k));
    }
    const kids = childrenAdj.get(id) ?? [];
    const visibleChildren = kids.flatMap((k) => getVisibleSubtree(k));
    const node: LineageNode = { ...s, children: visibleChildren };
    return [node];
  }

  const visibleRoots = rootIds.flatMap((rid) => getVisibleSubtree(rid));
  return { roots: visibleRoots, diagnostics: dedupedDiags };
}
