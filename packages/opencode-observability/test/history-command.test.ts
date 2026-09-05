import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BrowserOpener, BrowserOpenCode } from '../src/browser-opener';
import type { DashboardServer, ServerDescriptor } from '../src/server';
import { createCelestionHistoryCommand, type HistoryCommandDiagnosticCode } from '../src/history-command';

const DUMMY_DESC: ServerDescriptor = Object.freeze({
  port: 12345,
  origin: 'http://127.0.0.1:12345',
  launchURL: 'http://127.0.0.1:12345/#token=abc',
});

function makeFakes(options: {
  startShouldThrow?: boolean;
  openCode?: BrowserOpenCode;
  reporterShouldThrow?: boolean;
} = {}) {
  const startCalls: string[] = [];
  const openCalls: string[] = [];
  const activeSessions: (string | null)[] = [];
  const diagnostics: HistoryCommandDiagnosticCode[] = [];

  const server: DashboardServer = {
    async start() {
      startCalls.push('start');
      if (options.startShouldThrow) throw new Error('boom');
      return DUMMY_DESC;
    },
    setActiveSession(s: string | null) {
      activeSessions.push(s);
    },
    descriptor() { return DUMMY_DESC; },
    async stop() {},
  };

  const opener: BrowserOpener = {
    async open(url: string): Promise<BrowserOpenCode> {
      openCalls.push(url);
      return options.openCode ?? 'OPEN_REQUESTED';
    },
  };

  const onDiagnostic = options.reporterShouldThrow
    ? () => { throw new Error('reporter boom'); }
    : (code: HistoryCommandDiagnosticCode) => { diagnostics.push(code); };

  return { server, opener, onDiagnostic, startCalls, openCalls, activeSessions, diagnostics };
}

describe('celestion-history command contract', () => {
  it('exports exact command name and non-empty description', () => {
    const f = makeFakes();
    const cmd = createCelestionHistoryCommand({ server: f.server, opener: f.opener, onDiagnostic: f.onDiagnostic });
    assert.equal(cmd.name, 'celestion-history');
    assert.ok(typeof cmd.description === 'string' && cmd.description.length > 0);
  });

  it('sets active session before start/open on every invocation', async () => {
    const f = makeFakes();
    const cmd = createCelestionHistoryCommand({ server: f.server, opener: f.opener, onDiagnostic: f.onDiagnostic });
    await cmd.execute({ sessionID: 'ses_1' });
    assert.deepEqual(f.activeSessions, ['ses_1']);
    assert.equal(f.startCalls.length, 1);
    assert.equal(f.openCalls.length, 1);
  });

  it('starts server on first call, reuses on subsequent calls without extra start', async () => {
    const f = makeFakes();
    const cmd = createCelestionHistoryCommand({ server: f.server, opener: f.opener, onDiagnostic: f.onDiagnostic });
    await cmd.execute({ sessionID: 's1' });
    await cmd.execute({ sessionID: 's2' });
    assert.equal(f.startCalls.length, 1);
    assert.equal(f.openCalls.length, 2);
    assert.deepEqual(f.activeSessions, ['s1', 's2']);
  });

  it('coalesces concurrent starts; each invocation still opens exactly once', async () => {
    const f = makeFakes();
    const cmd = createCelestionHistoryCommand({ server: f.server, opener: f.opener, onDiagnostic: f.onDiagnostic });
    const p1 = cmd.execute({ sessionID: 'c1' });
    const p2 = cmd.execute({ sessionID: 'c2' });
    await Promise.all([p1, p2]);
    assert.equal(f.startCalls.length, 1);
    assert.equal(f.openCalls.length, 2);
  });

  it('fail-open on server start rejection: resolves, reports SERVER_START_FAILED, zero descriptor/open calls', async () => {
    const f = makeFakes({ startShouldThrow: true });
    const cmd = createCelestionHistoryCommand({ server: f.server, opener: f.opener, onDiagnostic: f.onDiagnostic });
    await cmd.execute({ sessionID: 's' });
    assert.deepEqual(f.diagnostics, ['SERVER_START_FAILED']);
    assert.equal(f.openCalls.length, 0);
  });

  it('fail-open on opener non-OPEN code: reports BROWSER_OPEN_FAILED, resolves', async () => {
    const f = makeFakes({ openCode: 'SPAWN_ERROR' });
    const cmd = createCelestionHistoryCommand({ server: f.server, opener: f.opener, onDiagnostic: f.onDiagnostic });
    await cmd.execute({ sessionID: 's' });
    assert.deepEqual(f.diagnostics, ['BROWSER_OPEN_FAILED']);
  });

  it('fail-open on opener rejection: reports BROWSER_OPEN_FAILED, resolves', async () => {
    const server = makeFakes().server;
    const opener: BrowserOpener = { async open() { throw new Error('opener boom'); } };
    const diagnostics: HistoryCommandDiagnosticCode[] = [];
    const cmd = createCelestionHistoryCommand({ server, opener, onDiagnostic: (c) => diagnostics.push(c) });
    await cmd.execute({ sessionID: 's' });
    assert.deepEqual(diagnostics, ['BROWSER_OPEN_FAILED']);
  });

  it('reporter throw is swallowed, command still resolves (report path exercised via start failure)', async () => {
    const f = makeFakes({ startShouldThrow: true, reporterShouldThrow: true });
    const cmd = createCelestionHistoryCommand({ server: f.server, opener: f.opener, onDiagnostic: f.onDiagnostic });
    await cmd.execute({ sessionID: 's' }); // must not throw even if reporter throws
    assert.ok(true);
  });

  it('failed start allows retry on next explicit invocation; successful retry opens once', async () => {
    let startShouldThrow = true;
    const startCalls: string[] = [];
    const openCalls: string[] = [];
    const server: DashboardServer = {
      async start() {
        startCalls.push('start');
        if (startShouldThrow) throw new Error('boom');
        return DUMMY_DESC;
      },
      setActiveSession() {},
      descriptor() { return DUMMY_DESC; },
      async stop() {},
    };
    const opener: BrowserOpener = { async open() { openCalls.push('open'); return 'OPEN_REQUESTED'; } };
    const diagnostics: HistoryCommandDiagnosticCode[] = [];
    const cmd = createCelestionHistoryCommand({ server, opener, onDiagnostic: c => diagnostics.push(c) });
    await cmd.execute({ sessionID: 'f1' });
    assert.deepEqual(diagnostics, ['SERVER_START_FAILED']);
    assert.equal(openCalls.length, 0);
    startShouldThrow = false;
    await cmd.execute({ sessionID: 's2' });
    assert.equal(startCalls.length, 2);
    assert.equal(openCalls.length, 1);
  });

  it('ordered call log: setActiveSession precedes start/open per invocation; one shared start for concurrent', async () => {
    const log: string[] = [];
    const server: DashboardServer = {
      async start() { log.push('start'); return DUMMY_DESC; },
      setActiveSession(s) { log.push(`set:${s}`); },
      descriptor() { return DUMMY_DESC; },
      async stop() {},
    };
    const opener: BrowserOpener = { async open() { log.push('open'); return 'OPEN_REQUESTED'; } };
    const cmd = createCelestionHistoryCommand({ server, opener });
    await cmd.execute({ sessionID: 'seq' });
    const p1 = cmd.execute({ sessionID: 'c1' });
    const p2 = cmd.execute({ sessionID: 'c2' });
    await Promise.all([p1, p2]);
    // partial order: each set before its open; exactly one start
    const startCount = log.filter(x => x === 'start').length;
    assert.equal(startCount, 1);
    assert.ok(log.indexOf('set:seq') < log.indexOf('open'));
    assert.ok(log.indexOf('set:c1') < log.lastIndexOf('open'));
    assert.ok(log.indexOf('set:c2') < log.lastIndexOf('open'));
  });

  it('never exposes launch URL or token in public surface or diagnostics', async () => {
    const f = makeFakes();
    const cmd = createCelestionHistoryCommand({ server: f.server, opener: f.opener, onDiagnostic: f.onDiagnostic });
    const result = await cmd.execute({ sessionID: 's' });
    assert.equal(result, undefined);
    assert.ok(!JSON.stringify(f.diagnostics).includes('token'));
    assert.ok(!JSON.stringify(f.diagnostics).includes('launchURL'));
  });

  it('overlapping start: two invocations share one in-flight start; both setActive before any open; opens only after start resolves', async () => {
    const log: string[] = [];
    let resolveStart: (() => void) | undefined;
    const startPromise = new Promise<void>((resolve) => { resolveStart = resolve; });
    const server: DashboardServer = {
      async start() {
        log.push('start-called');
        await startPromise;
        log.push('start-resolved');
        return DUMMY_DESC;
      },
      setActiveSession(s) { log.push(`set:${s}`); },
      descriptor() { return DUMMY_DESC; },
      async stop() {},
    };
    const opener: BrowserOpener = { async open() { log.push('open'); return 'OPEN_REQUESTED'; } };
    const cmd = createCelestionHistoryCommand({ server, opener });

    const p1 = cmd.execute({ sessionID: 'o1' });
    const p2 = cmd.execute({ sessionID: 'o2' });

    // Before resolving start: exactly one start attempt, both sessions recorded, zero opens
    await Promise.resolve(); // allow microtasks for sets
    assert.equal(log.filter(x => x === 'start-called').length, 1);
    assert.ok(log.includes('set:o1'));
    assert.ok(log.includes('set:o2'));
    assert.equal(log.filter(x => x === 'open').length, 0);

    // Resolve start (type-safe guard, no non-null assertion)
    if (typeof resolveStart !== 'function') throw new Error('resolveStart was not assigned');
    resolveStart();
    await Promise.all([p1, p2]);

    // After: both opens happened, start resolved once
    assert.equal(log.filter(x => x === 'start-resolved').length, 1);
    assert.equal(log.filter(x => x === 'open').length, 2);
    // ordering: both sets must precede the FIRST open
    const firstOpenIdx = log.indexOf('open');
    assert.ok(log.indexOf('set:o1') < firstOpenIdx);
    assert.ok(log.indexOf('set:o2') < firstOpenIdx);
  });
});
