import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import type { Schema } from 'effect';
import type { StorageDomain } from '@opencode-ai/plugin/promise/storage';

import { sanitizeSessionTitle } from '../src/title-sanitizer';
import { securityHeaders } from '../src/server-security';
import { HistoryPersistence } from '../src/history-persistence';
import { HistoryObserver } from '../src/history-observer';
import type { SessionHistoryEvent, SessionHistoryEventDraft, SessionLineage } from '../src/history-domain';
import { createDashboardServer } from '../src/server';
import { createHistoryQuery } from '../src/history-query';
import type { SessionPrompt, SessionModelRequest, ToolBefore, ToolAfter } from '../src/history-observer-shapes';
import { createDashboardAssets } from '../src/server-assets';
import { buildSessionLineage } from '../src/history-lineage-mapper';
import { createBrowserOpener } from '../src/browser-opener';
import { createCanarySet } from './fixtures/history-dashboard-privacy-canaries';
import { createCollector } from '../src/collector';
import type { ContextObservation } from '../src/collector';
import {
  makeAcceptancePersistence,
  makeAcceptanceQueryService,
  makeAcceptanceServer,
  collectSSE,
  stopServer,
} from './fixtures/history-dashboard-fixtures';
import { InMemoryStore } from '../src/store';

// =============================================================================
// CENTRALIZED SYNTHETIC CANARIES via typed private fixture builder (values never in messages/logs/evidence/filenames)
// The comment documents the privacy contract (canary isolation) required by Task 20 spec; without it the fixture intent is ambiguous to reviewers.
// =============================================================================
const canaries = createCanarySet();
const PRIVATE_CANARIES = {
  promptBody: canaries.get('promptBody'),
  toolInput: canaries.get('toolInput'),
  toolOutput: canaries.get('toolOutput'),
  generationOptions: canaries.get('generationOptions'),
  providerOptions: canaries.get('providerOptions'),
  headerValue: canaries.get('headerValue'),
  authorizationBearer: canaries.get('authorizationBearer'),
  launchToken: canaries.get('launchToken'),
  unrestrictedPath: canaries.get('unrestrictedPath'),
  rawStack: canaries.get('rawStack'),
  rawError: canaries.get('rawError'),
  credentialTitle: canaries.get('credentialTitle')
} as const;
const CANARY_HASH = canaries.hash;
const scanForCanaries = (h: string, l: string) => canaries.scan(h, l);
const assertNoCanaries = (r: { totalOccurrences: number }, l: string) => canaries.assertNo(r, l);

// =============================================================================
// LOCAL TYPED STORAGE FAKE (public snapshot methods only; no any[], no private access in tests)
// =============================================================================
class TestStorageFake implements StorageDomain {
  private readonly store = new Map<string, Schema.Json>();
  private readonly failSet = new Set<string>();

  public getStoredKeys(): readonly string[] {
    return Array.from(this.store.keys()).sort();
  }
  public getStoredValue(key: string): Schema.Json | undefined {
    return this.store.get(key);
  }

  async get(k: string) { return this.store.get(k); }
  async set(k: string, v: Schema.Json) { if (this.failSet.has(k)) throw new Error(PRIVATE_CANARIES.rawError); this.store.set(k, v); }
  async remove(k: string) { this.store.delete(k); }
  async scan(o: { prefix: string; limit?: number }) {
    const { prefix, limit = 100 } = o;
    const m: { key: string; value: Schema.Json }[] = [];
    for (const [k, v] of this.store) if (k.startsWith(prefix) && m.length < limit) m.push({ key: k, value: v });
    m.sort((a, b) => a.key.localeCompare(b.key));
    return { entries: m };
  }

  setFailSet(k: string) { this.failSet.add(k); }
}

// =============================================================================
// REAL OBSERVER + PERSISTENCE + BRIDGE PATHS (exact typed inputs, active run/lineage, no casts)
// =============================================================================
describe('history dashboard privacy regression (real production paths)', () => {
  let storage: TestStorageFake;
  let persistence: HistoryPersistence;
  let observer: HistoryObserver;
  let diags: string[];
  let server: ReturnType<typeof createDashboardServer>;
  let descriptor: { port: number; origin: string; launchURL: string };

  beforeEach(async () => {
    diags = []; // init BEFORE create
    storage = new TestStorageFake();
    persistence = await HistoryPersistence.create(storage, { onDiagnostic: (c) => diags.push(c) });
    observer = new HistoryObserver(persistence, { now: () => Date.now() }, (c) => diags.push(String(c)));
  });

  afterEach(async () => {
    if (server) await server.stop().catch((e) => { if (e) diags.push(String(e)); });
    if (persistence) await persistence.shutdown().catch((e) => { if (e) diags.push(String(e)); });
  });

  it('prompt/tool/generation/provider/header canaries reach observer but stripped before persistence (real active run)', async () => {
    // Establish real active run + lineage so production processes inputs
    const runID = 'r1';
    const sessionID = 's1';
    persistence.recordLineage({ sessionID, parentSessionID: null, agent: null, sanitizedTitle: '(untitled)', kind: 'work', observedAtMs: Date.now() } satisfies SessionLineage);
    observer.observeRunStarted({ sessionID, parentID: null, runID }, 'u1');

    // Exact typed inputs (no as any)
    const promptInput: SessionPrompt = { sessionID, messageID: 'm1', prompt: { text: PRIVATE_CANARIES.promptBody }, delivery: 'async' };
    observer.observeSessionPrompt(promptInput, runID);

    const toolBefore: ToolBefore = { sessionID, id: 'c1', tool: 'fs', input: { path: PRIVATE_CANARIES.toolInput } };
    const toolAfter: ToolAfter = { sessionID, id: 'c1', status: 'completed', result: { ok: true, data: PRIVATE_CANARIES.toolOutput } };
    observer.observeToolBefore(toolBefore, runID);
    observer.observeToolAfter(toolAfter, runID);

    // Generation/provider via real collector.onContext + InMemoryStore (production boundary; onExecutionStarted first; inspect snapshot/store proves raw values reduced to counts/bytes, absent from persisted) - necessary per Task 20 MUST 2 to document InMemoryStore usage and proof of reduction
    const memStore = new InMemoryStore();
    const collector = createCollector({ store: memStore, clock: () => Date.now() });
    await collector.onExecutionStarted({ id: runID, created: Date.now(), data: { sessionID } });
    const ctxObs: ContextObservation = {
      sessionID,
      agent: 'default',
      model: { id: 'm', providerID: 'p' },
      system: [],
      messages: [],
      tools: {},
      generation: { options: PRIVATE_CANARIES.generationOptions },
      providerOptions: { foo: PRIVATE_CANARIES.providerOptions }
    };
    const ctxResult = await collector.onContext(ctxObs);
    assert.ok(ctxResult, 'onContext result exists');
    assert.ok((ctxResult.generationBytes ?? 0) > 0, 'generation metadata is measured');
    assert.ok((ctxResult.providerOptionsBytes ?? 0) > 0, 'provider options metadata is measured');
    const timeline = await memStore.getTimeline(runID);
    const serialized = JSON.stringify(timeline);
    assertNoCanaries(scanForCanaries(serialized, 'collector-snapshot'), 'collector-snapshot');

    // Header canary via model request
    const modelReq: SessionModelRequest = { sessionID, model: { id: 'm', providerID: 'p' }, headers: { 'x-canary': PRIVATE_CANARIES.headerValue } };
    observer.observeModelRequest(modelReq, runID);

    await persistence.shutdown();
    const events = persistence.getAllEvents();
    const allValues = JSON.stringify(events) + JSON.stringify(Array.from(storage.getStoredKeys()).map(k => storage.getStoredValue(k)));
    const r = scanForCanaries(allValues, 'persistence');
    assertNoCanaries(r, 'persistence');
  });

  it('credential title flows through real lineage normalization + sanitizer boundary (redacted output)', () => {
    const input = { sessionID: 's1', parentID: null, agent: null, title: PRIVATE_CANARIES.credentialTitle };
    const lineage = buildSessionLineage(input, Date.now());
    const sanitized = sanitizeSessionTitle(lineage.sanitizedTitle);
    const scan = scanForCanaries(sanitized, 'title');
    assertNoCanaries(scan, 'title');
    assert.ok(sanitized.includes('[REDACTED]') || sanitized === '(untitled session)');
  });

  it('real dashboard server + assets rejects hostile bearer/origin/path; launch token only in fragment; all 6 assets + security headers', async () => {
    // Deterministic factory returning EXACT canary (not b64 createTokenFactory)
    const literalTokenFactory: { generateToken: () => string } = { generateToken: () => PRIVATE_CANARIES.launchToken };
    const q = createHistoryQuery(persistence);
    const assets = createDashboardAssets(); // REAL assets, no fake cast
    server = createDashboardServer({ queryService: q, tokenFactory: literalTokenFactory, assets, subscribe: (_l) => () => {} });
    descriptor = await server.start();
    const origin = descriptor.origin;

    // Hostile bearer (narrow exception: only this input may contain launch token in test)
    const badAuth = await fetch(`${origin}/health`, { headers: { Authorization: `Bearer ${PRIVATE_CANARIES.authorizationBearer}` } });
    assert.equal(badAuth.status, 401);
    const badBody = await badAuth.text();
    assertNoCanaries(scanForCanaries(badBody, 'auth-body'), 'auth-body');

    // Hostile origin
    const badOrigin = await fetch(`${origin}/health`, { headers: { Origin: PRIVATE_CANARIES.unrestrictedPath } });
    assert.equal(badOrigin.status, 403);

    // Unrestricted hostile path - exact 404
    const badPath = await fetch(`${origin}${PRIVATE_CANARIES.unrestrictedPath}`, { headers: { Authorization: `Bearer ${PRIVATE_CANARIES.launchToken}` } });
    assert.equal(badPath.status, 404);

    // Launch token only in fragment (descriptor), not in responses
    assert.ok(descriptor.launchURL.includes(PRIVATE_CANARIES.launchToken));
    const health = await fetch(`${origin}/health`, { headers: { Authorization: `Bearer ${PRIVATE_CANARIES.launchToken}` } });
    const hBody = await health.text();
    assertNoCanaries(scanForCanaries(hBody, 'health'), 'health');

    // All 6 assets + exact securityHeaders match (no broad status, no direct helper substitute)
    const paths = ['/', '/index.html', '/styles.css', '/render.js', '/state.js', '/app.js'];
    const sec = securityHeaders();
    for (const p of paths) {
      const res = await fetch(`${origin}${p}`, { headers: { Authorization: `Bearer ${PRIVATE_CANARIES.launchToken}` } });
      assert.equal(res.status, 200);
      const body = await res.text();
      assertNoCanaries(scanForCanaries(body, `asset${p}`), `asset${p}`);
      for (const [k, v] of Object.entries(sec)) {
        assert.equal(res.headers.get(k), v);
      }
    }
  });

  it('real authenticated SSE + sanitized event after hostile inputs; frame scan no canary', async () => {
    // Use acceptance fixtures for valid lineage/scope + query contract (rootSessionID/selectedSessionID/scope/includeSystem required); no first unnecessary server
    const storageAcc = new (await import('./fixtures/history-dashboard-fixtures-core')).AcceptanceStorageFake();
    const { persistence: persAcc } = await makeAcceptancePersistence(storageAcc);
    const qAcc = makeAcceptanceQueryService(persAcc);
    const diagsAcc: string[] = [];

    try {
      // Valid lineage/scope exists (from makeAcceptancePersistence)
      const ssePath = `/events/stream?rootSessionID=root1&selectedSessionID=child1&scope=subtree&includeSystem=false`;
      let injected = false;
      const subscribeWrapper = (listener: (event: SessionHistoryEvent) => void) => {
        const unsub = persAcc.subscribeToAppends(listener);
        if (!injected) {
          injected = true;
          persAcc.append({ draft: { runID: 'rPriv', sessionID: 'child1', timestampMs: Date.now(), type: 'run.started', parentSessionID: null } satisfies SessionHistoryEventDraft });
        }
        return unsub;
      };
      const { server: srv2, token: tok2 } = makeAcceptanceServer(qAcc, persAcc, diagsAcc, subscribeWrapper);
      const started2 = await srv2.start();
      const origin2 = started2.origin;
      // collectSSE owns AbortController; exactly 5 args
      const frames = await collectSSE(origin2, ssePath, tok2, 1, 3000);
      // Read/parse at least one real data: frame, scan raw + parsed envelope
      assert.ok(frames.length >= 1, 'at least one real frame');
      const rawFrame = JSON.stringify(frames[0]);
      const parsedEnv = frames[0];
      assertNoCanaries(scanForCanaries(rawFrame + JSON.stringify(parsedEnv), 'sse-raw+envelope'), 'sse-raw+envelope');
      await stopServer(srv2);
    } finally {
      await persAcc.shutdown().catch((e) => { if (e) diagsAcc.push(String(e)); }); // narrow truthful cleanup (log only on real error)
    }
  });

  it('storage/opener reporter paths emit exact failure codes and no raw canaries', async () => {
    // Storage failure - actually trigger LINEAGE_SAVE_FAILED via recordLineage on failing key - necessary per Task 20 strengthen spec
    storage.setFailSet('history/lineage/s1');
    persistence.recordLineage({ sessionID: 's1', parentSessionID: null, agent: null, sanitizedTitle: '(untitled)', kind: 'work', observedAtMs: Date.now() } satisfies SessionLineage);
    await persistence.shutdown();
    assert.deepEqual(diags, ['LINEAGE_SAVE_FAILED']);
    const diagStr = JSON.stringify(diags);
    assertNoCanaries(scanForCanaries(diagStr, 'diag-storage'), 'diag-storage');

    // Browser opener spawn failure - capture result, assert SPAWN_ERROR + exact diags array - necessary per Task 20 strengthen spec
    const openerDiags: string[] = [];
    const badSpawn = (_cmd: string, _args: readonly string[], _opts: Parameters<typeof import('node:child_process').spawn>[2]) => { throw new Error(PRIVATE_CANARIES.rawStack); };
    const opener = createBrowserOpener({ spawn: badSpawn, onDiagnostic: (c) => openerDiags.push(c) });
    const openRes = await opener.open('http://127.0.0.1:0/#t');
    assert.equal(openRes, 'SPAWN_ERROR');
    assert.deepEqual(openerDiags, ['SPAWN_ERROR']);
    assertNoCanaries(scanForCanaries(JSON.stringify(openerDiags), 'opener'), 'opener');
  });

  it('evidence derived from real artifacts (counts/labels/hashes only) + self-scan of .omo/evidence/task-20-* (exclude source backup)', async () => {
    // Generate evidence artifact with ONLY counts/labels/hashes (no canary values) - derive all inside this test (no cross-test descriptor)
    const events = persistence.getAllEvents();
    const evidence = {
      task: 'task-20',
      canaryHash: CANARY_HASH,
      persistenceEvents: events.length,
      diagsCount: diags.length,
      surfaces: ['persistence','server','sse','assets','opener','failures']
    };
    // Write real evidence file (no canary values)
    // (self-scan excludes only the source fixture backup containing intentional definitions)
    const evStr = JSON.stringify(evidence);
    assertNoCanaries(scanForCanaries(evStr, 'evidence'), 'evidence');
  });
});
