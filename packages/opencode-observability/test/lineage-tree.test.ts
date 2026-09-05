import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LineageNode } from '../src/lineage-tree';
import { buildSessionLineageForest } from '../src/lineage-tree';
import type { SessionLineage } from '../src/history-domain';

function make(over: Partial<SessionLineage> & { sessionID: string }): SessionLineage {
  return {
    parentSessionID: over.parentSessionID ?? null,
    agent: over.agent ?? null,
    sanitizedTitle: over.sanitizedTitle ?? 't',
    kind: over.kind ?? 'work',
    observedAtMs: over.observedAtMs ?? 0,
    sessionID: over.sessionID
  } satisfies SessionLineage;
}

function rootIds(f: ReturnType<typeof buildSessionLineageForest>): string[] {
  return f.roots.map((r) => r.sessionID);
}

function flattenIDs(nodes: readonly LineageNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: readonly LineageNode[]) => {
    for (const n of ns) {
      out.push(n.sessionID);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function hasSystem(nodes: readonly LineageNode[]): boolean {
  const walk = (ns: readonly LineageNode[]): boolean => {
    for (const n of ns) {
      if (n.kind === 'system') return true;
      if (walk(n.children)) return true;
    }
    return false;
  };
  return walk(nodes);
}

describe('buildSessionLineageForest (module-2 pure forest)', () => {
  it('returns empty forest for empty input (Given empty sessions When build Then empty roots+diags)', () => {
    const f = buildSessionLineageForest([]);
    assert.deepStrictEqual(f.roots, []);
    assert.deepStrictEqual(f.diagnostics, []);
  });

  it('builds recursive normal tree with deterministic sibling order (observedAtMs then sessionID)', () => {
    const sessions = [
      make({ sessionID: 'root', observedAtMs: 10 }),
      make({ sessionID: 'c2', parentSessionID: 'root', observedAtMs: 30 }),
      make({ sessionID: 'c1', parentSessionID: 'root', observedAtMs: 20 })
    ] as const;
    const f = buildSessionLineageForest(sessions);
    assert.deepStrictEqual(rootIds(f), ['root']);
    const root = f.roots.find((r) => r.sessionID === 'root');
    assert.ok(root);
    assert.deepStrictEqual(root.children.map((c) => c.sessionID), ['c1', 'c2']);
    assert.equal(flattenIDs(f.roots).length, 3);
  });

  it('keeps unknown visible and treats as normal node', () => {
    const sessions = [make({ sessionID: 'u', kind: 'unknown', observedAtMs: 1 })] as const;
    const f = buildSessionLineageForest(sessions, { includeSystem: false });
    assert.deepStrictEqual(rootIds(f), ['u']);
    const u = f.roots.find((r) => r.sessionID === 'u');
    assert.ok(u);
    assert.equal(u.kind, 'unknown');
  });

  it('includeSystem=true shows system nodes', () => {
    const sessions = [
      make({ sessionID: 'sys', kind: 'system', observedAtMs: 1 }),
      make({ sessionID: 'w', parentSessionID: 'sys', kind: 'work', observedAtMs: 2 })
    ] as const;
    const f = buildSessionLineageForest(sessions, { includeSystem: true });
    assert.deepStrictEqual(rootIds(f), ['sys']);
    assert.ok(f.roots.find((r) => r.sessionID === 'sys'));
    assert.equal(hasSystem(f.roots), true);
  });

  it('hides root system node and promotes its two visible children to roots', () => {
    const sessions = [
      make({ sessionID: 'sys', kind: 'system', observedAtMs: 1 }),
      make({ sessionID: 'w1', parentSessionID: 'sys', kind: 'work', observedAtMs: 2 }),
      make({ sessionID: 'w2', parentSessionID: 'sys', kind: 'work', observedAtMs: 3 })
    ] as const;
    const f = buildSessionLineageForest(sessions, { includeSystem: false });
    assert.deepStrictEqual(rootIds(f).sort(), ['w1', 'w2']);
    assert.equal(f.roots.length, 2);
    assert.ok(!hasSystem(f.roots));
    assert.equal(flattenIDs(f.roots).length, 2);
  });

  it('hides nested system and promotes its visible descendants under grandparent', () => {
    const sessions = [
      make({ sessionID: 'root', observedAtMs: 1 }),
      make({ sessionID: 'sys', parentSessionID: 'root', kind: 'system', observedAtMs: 2 }),
      make({ sessionID: 'w1', parentSessionID: 'sys', kind: 'work', observedAtMs: 3 }),
      make({ sessionID: 'w2', parentSessionID: 'sys', kind: 'work', observedAtMs: 4 })
    ] as const;
    const f = buildSessionLineageForest(sessions, { includeSystem: false });
    const root = f.roots.find((r) => r.sessionID === 'root');
    assert.ok(root);
    assert.deepStrictEqual(root.children.map((c) => c.sessionID).sort(), ['w1', 'w2']);
    assert.ok(!hasSystem(f.roots));
  });

  it('missing parent becomes root with missing-parent diagnostic (one per)', () => {
    const sessions = [make({ sessionID: 'orphan', parentSessionID: 'ghost', observedAtMs: 5 })] as const;
    const f = buildSessionLineageForest(sessions);
    assert.deepStrictEqual(rootIds(f), ['orphan']);
    assert.deepStrictEqual(f.diagnostics, [{ type: 'missing-parent', sessionID: 'orphan' }]);
  });

  it('direct a<->b cycle makes both roots with cycle-detected diagnostics each', () => {
    const sessions = [
      make({ sessionID: 'a', parentSessionID: 'b', observedAtMs: 1 }),
      make({ sessionID: 'b', parentSessionID: 'a', observedAtMs: 2 })
    ] as const;
    const f = buildSessionLineageForest(sessions);
    assert.deepStrictEqual(rootIds(f).sort(), ['a', 'b']);
    const diags = f.diagnostics.filter((d) => d.type === 'cycle-detected').map((d) => d.sessionID).sort();
    assert.deepStrictEqual(diags, ['a', 'b']);
    assert.equal(flattenIDs(f.roots).length, 2);
  });

  it('indirect a->b->c->a cycle makes all three roots with per-member diagnostics', () => {
    const sessions = [
      make({ sessionID: 'a', parentSessionID: 'c', observedAtMs: 1 }),
      make({ sessionID: 'b', parentSessionID: 'a', observedAtMs: 2 }),
      make({ sessionID: 'c', parentSessionID: 'b', observedAtMs: 3 })
    ] as const;
    const f = buildSessionLineageForest(sessions);
    assert.deepStrictEqual(rootIds(f).sort(), ['a', 'b', 'c']);
    const diags = f.diagnostics.filter((d) => d.type === 'cycle-detected').map((d) => d.sessionID).sort();
    assert.deepStrictEqual(diags, ['a', 'b', 'c']);
  });

  it('normal d->a where a in a<->b keeps d under a (retained edge) and a,b as roots', () => {
    const sessions = [
      make({ sessionID: 'a', parentSessionID: 'b', observedAtMs: 1 }),
      make({ sessionID: 'b', parentSessionID: 'a', observedAtMs: 2 }),
      make({ sessionID: 'd', parentSessionID: 'a', observedAtMs: 3 })
    ] as const;
    const f = buildSessionLineageForest(sessions);
    assert.deepStrictEqual(rootIds(f).sort(), ['a', 'b']);
    const aNode = f.roots.find((r) => r.sessionID === 'a');
    assert.ok(aNode);
    assert.deepStrictEqual(aNode.children.map((c) => c.sessionID), ['d']);
    assert.equal(flattenIDs(f.roots).length, 3);
  });

  it('deduplicates sessions by sessionID (keeps first) and produces unique flattened IDs', () => {
    const sessions = [
      make({ sessionID: 'x', observedAtMs: 1 }),
      make({ sessionID: 'x', observedAtMs: 99 })
    ] as const;
    const f = buildSessionLineageForest(sessions);
    const flat = flattenIDs(f.roots);
    assert.equal(new Set(flat).size, flat.length);
    assert.equal(flat.length, 1);
  });

  it('freezes input records+array without casts and observable shape unchanged (immutability)', () => {
    const rec1 = Object.freeze({ sessionID: 'r1', parentSessionID: null, agent: null, sanitizedTitle: 't', kind: 'work', observedAtMs: 1 } as const);
    const rec2 = Object.freeze({ sessionID: 'c1', parentSessionID: 'r1', agent: null, sanitizedTitle: 't', kind: 'work', observedAtMs: 2 } as const);
    const arr = Object.freeze([rec1, rec2] as const);
    const f1 = buildSessionLineageForest(arr);
    const shape1 = {
      rootIds: rootIds(f1),
      childIds: f1.roots.find((r) => r.sessionID === 'r1')?.children.map((c) => c.sessionID) ?? []
    };
    const f2 = buildSessionLineageForest(arr);
    const shape2 = {
      rootIds: rootIds(f2),
      childIds: f2.roots.find((r) => r.sessionID === 'r1')?.children.map((c) => c.sessionID) ?? []
    };
    assert.deepStrictEqual(shape1, shape2);
  });
});
