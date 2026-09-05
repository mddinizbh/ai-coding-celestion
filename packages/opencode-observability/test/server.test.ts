import assert from 'node:assert/strict';
import http from 'node:http';
import { describe, it } from 'node:test';

import type { HistoryQueryService, LineageScopeQuery } from '../src/history-query';
import type { ListEventsInput } from '../src/history-query-contracts';
import { createDashboardAssets } from '../src/server-assets';
import { createDashboardServer, type DashboardServer, type ServerDiagnosticCode } from '../src/server';
import { securityHeaders } from '../src/server-security';

const TOKEN = 'test-token-123';
const WRONG_TOKEN = 'wrong-token-456';
const CSP = securityHeaders()['Content-Security-Policy'];

const fakeQueryService: HistoryQueryService = {
  listRoots: () => [{ sessionID: 'root', sanitizedTitle: 'Root', agent: 'coder', kind: 'work', observedAtMs: 1 }],
  getTree: () => ({ ok: true, root: { sessionID: 'root', parentSessionID: null, sanitizedTitle: 'Root', agent: 'coder', kind: 'work', observedAtMs: 1, children: [] } }),
  resolveScope: (_query: LineageScopeQuery) => ({ ok: true, sessionIDs: ['root'] }),
  listEvents: (_input: ListEventsInput) => ({ ok: true, page: { events: [], hasMore: false, nextCursor: null } }),
  projectBootstrap: (input) => ({ roots: [{ sessionID: 'root', sanitizedTitle: 'Root', agent: 'coder', kind: 'work', observedAtMs: 1 }], activeRootSessionID: input.activeSessionID, cursor: null })
};

function makeServer(diagnostics: ServerDiagnosticCode[] = []): DashboardServer {
  return createDashboardServer({
    queryService: fakeQueryService,
    tokenFactory: { generateToken: () => TOKEN },
    assets: createDashboardAssets(),
    onDiagnostic: (code) => diagnostics.push(code)
  });
}

async function readBody(response: Response): Promise<string> {
  return await response.text();
}

function bearer(token = TOKEN): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

async function stop(server: DashboardServer): Promise<void> {
  await server.stop();
}

async function expectConnectionRefused(origin: string): Promise<void> {
  try {
    await fetch(`${origin}/health`, { headers: bearer() });
  } catch {
    return;
  }
  assert.fail('expected fetch to refuse after stop');
}

async function canBind(port: number): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close((error) => {
        if (error) reject(error);
        resolve(true);
      });
    });
  });
}

describe('dashboard loopback server startup', () => {
  it('constructs without listening and later binds exactly 127.0.0.1 with a system-selected stable port/token', async () => {
    const server = makeServer();
    assert.deepEqual(server.descriptor(), { port: 0, origin: 'http://127.0.0.1:0', launchURL: 'http://127.0.0.1:0/#' });

    const [first, second] = await Promise.all([server.start(), server.start()]);
    try {
      assert.deepEqual(first, second);
      assert.ok(first.port > 0);
      assert.equal(first.origin, `http://127.0.0.1:${first.port}`);
      assert.equal(first.launchURL, `${first.origin}/#${TOKEN}`);
      assert.ok(!first.launchURL.includes('?'));
    } finally {
      await stop(server);
    }
  });

  it('coalesces five concurrent start calls into one descriptor and one listener', async () => {
    const server = makeServer();
    const descriptors = await Promise.all([server.start(), server.start(), server.start(), server.start(), server.start()]);
    try {
      const serialized = descriptors.map((d) => JSON.stringify(d));
      assert.equal(new Set(serialized).size, 1);
      assert.equal(new Set(descriptors.map((d) => d.port)).size, 1);
    } finally {
      await stop(server);
    }
  });
});

describe('dashboard server static assets and auth boundary', () => {
  it('serves static assets without bearer auth and protects data endpoints', async () => {
    const server = makeServer();
    const descriptor = await server.start();
    try {
      const index = await fetch(`${descriptor.origin}/`);
      assert.equal(index.status, 200);
      assert.match(index.headers.get('content-type') ?? '', /^text\/html/);
      assert.equal(index.headers.get('Content-Security-Policy'), CSP);
      assert.match(await readBody(index), /dashboard-root|tree|timeline/);

      const styles = await fetch(`${descriptor.origin}/styles.css`);
      assert.equal(styles.status, 200);
      assert.match(styles.headers.get('content-type') ?? '', /^text\/css/);

      const health = await fetch(`${descriptor.origin}/health`);
      assert.equal(health.status, 401);
      assert.deepEqual(JSON.parse(await readBody(health)), { error: 'UNAUTHORIZED' });
    } finally {
      await stop(server);
    }
  });

  it('serves the Task 12 app asset without reflecting secrets', async () => {
    const server = makeServer();
    const descriptor = await server.start();
    try {
      const response = await fetch(`${descriptor.origin}/app.js`);
      const body = await readBody(response);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/);
      assert.match(body, /createDashboardClient/);
      assert.ok(!body.includes(TOKEN));
    } finally {
      await stop(server);
    }
  });

  it('authenticates data routes, rejects wrong bearer, and rejects foreign Origin before routing', async () => {
    const server = makeServer();
    server.setActiveSession('root');
    const descriptor = await server.start();
    try {
      const health = await fetch(`${descriptor.origin}/health`, { headers: bearer() });
      assert.equal(health.status, 200);
      assert.deepEqual(JSON.parse(await readBody(health)), { ok: true });

      const bootstrap = await fetch(`${descriptor.origin}/bootstrap`, { headers: bearer() });
      assert.equal(bootstrap.status, 200);
      assert.deepEqual(JSON.parse(await readBody(bootstrap)), fakeQueryService.projectBootstrap({ activeSessionID: 'root' }));

      const wrong = await fetch(`${descriptor.origin}/health`, { headers: bearer(WRONG_TOKEN) });
      const wrongBody = await readBody(wrong);
      assert.equal(wrong.status, 401);
      assert.ok(!wrongBody.includes(TOKEN));
      assert.ok(!wrongBody.includes(WRONG_TOKEN));

      const foreign = await fetch(`${descriptor.origin}/health`, { headers: { ...bearer(), Origin: 'http://evil.example.com' } });
      assert.equal(foreign.status, 403);
      assert.deepEqual(JSON.parse(await readBody(foreign)), { error: 'FORBIDDEN' });
    } finally {
      await stop(server);
    }
  });
});

describe('dashboard server lifecycle and fail-open diagnostics', () => {
  it('stops idempotently and releases the port', async () => {
    const server = makeServer();
    const descriptor = await server.start();

    await server.stop();
    await server.stop();

    await expectConnectionRefused(descriptor.origin);
    assert.equal(await canBind(descriptor.port), true);
  });

  it('reports bind failure as a sanitized code and remains stoppable without throwing', async () => {
    const diagnostics: ServerDiagnosticCode[] = [];
    const server = createDashboardServer({
      queryService: fakeQueryService,
      tokenFactory: { generateToken: () => TOKEN },
      assets: createDashboardAssets(),
      onDiagnostic: (code) => diagnostics.push(code),
      createServer: () => {
        throw new Error('raw bind failure with secret-ish text');
      }
    });

    const descriptor = await server.start();
    await server.stop();

    assert.deepEqual(diagnostics, ['SERVER_BIND_FAILED']);
    assert.deepEqual(descriptor, { port: 0, origin: 'http://127.0.0.1:0', launchURL: 'http://127.0.0.1:0/#' });
    assert.ok(!JSON.stringify(diagnostics).includes(TOKEN));
  });

  it('sanitizes request-handler crashes and keeps serving later requests', async () => {
    const diagnostics: ServerDiagnosticCode[] = [];
    const server = createDashboardServer({
      queryService: fakeQueryService,
      tokenFactory: { generateToken: () => TOKEN },
      assets: createDashboardAssets({ loader: async () => { throw new Error('raw asset failure'); } }),
      onDiagnostic: (code) => diagnostics.push(code)
    });
    const descriptor = await server.start();
    try {
      const failed = await fetch(`${descriptor.origin}/`);
      assert.equal(failed.status, 500);
      assert.deepEqual(JSON.parse(await readBody(failed)), { error: 'INTERNAL_ERROR' });
      const health = await fetch(`${descriptor.origin}/health`, { headers: bearer() });
      assert.equal(health.status, 200);
      assert.deepEqual(diagnostics, ['REQUEST_HANDLER_FAILED']);
    } finally {
      await stop(server);
    }
  });
});

describe('dashboard server SSE seam', () => {
  it('rejects unauthenticated stream requests before stream takeover', async () => {
    const server = createDashboardServer({
      queryService: fakeQueryService,
      tokenFactory: { generateToken: () => TOKEN },
      assets: createDashboardAssets(),
      streamHandler: () => {
        assert.fail('stream handler must not run before bearer auth');
      }
    });
    const descriptor = await server.start();
    try {
      const response = await fetch(`${descriptor.origin}/events/stream?rootSessionID=root&selectedSessionID=root&scope=subtree&includeSystem=false`);
      assert.equal(response.status, 401);
      assert.deepEqual(JSON.parse(await readBody(response)), { error: 'UNAUTHORIZED' });
    } finally {
      await stop(server);
    }
  });

  it('falls back to the Task 7 marker when the raw stream handler declines takeover', async () => {
    const server = createDashboardServer({
      queryService: fakeQueryService,
      tokenFactory: { generateToken: () => TOKEN },
      assets: createDashboardAssets(),
      streamHandler: () => false
    });
    const descriptor = await server.start();
    try {
      const response = await fetch(`${descriptor.origin}/events/stream`, { headers: bearer() });
      assert.equal(response.status, 501);
      assert.deepEqual(JSON.parse(await readBody(response)), { error: 'NOT_IMPLEMENTED' });
    } finally {
      await stop(server);
    }
  });
});
