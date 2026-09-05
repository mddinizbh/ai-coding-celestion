import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { SpawnOptions } from 'node:child_process';
import { createBrowserOpener, type BrowserOpenCode, type BrowserOpenerDeps } from '../src/browser-opener';

type SpawnCall = {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
};

interface ErrorEmitter {
  unref(): void;
  on(event: 'error', listener: (err: Error) => void): ErrorEmitter;
}

describe('createBrowserOpener platform selection and spawn contract', () => {
  let calls: SpawnCall[];
  let diagnostics: BrowserOpenCode[];
  let errorListener: ((err: Error) => void) | null;

  beforeEach(() => {
    calls = [];
    diagnostics = [];
    errorListener = null;
  });

  function getCall(): SpawnCall {
    const c = calls[0];
    if (c === undefined) {
      throw new Error('expected spawn call');
    }
    return c;
  }

  function makeDeps(platform: string, throwSync = false, emitError = false): BrowserOpenerDeps {
    return {
      platform: platform as NodeJS.Platform,
      spawn: (command: string, args: readonly string[], options: SpawnOptions) => {
        calls.push({ command, args, options });
        if (throwSync) {
          throw new Error('sync spawn failure');
        }
        const child: ErrorEmitter = {
          unref: () => {},
          on: (event, listener) => {
            if (event === 'error') {
              errorListener = listener;
            }
            return child;
          },
        };
        if (emitError) {
          setImmediate(() => {
            if (errorListener) errorListener(new Error('child error'));
          });
        }
        return child as ReturnType<NonNullable<BrowserOpenerDeps['spawn']>>;
      },
      onDiagnostic: (code) => diagnostics.push(code),
    };
  }

  it('Darwin uses open with URL as single arg, detached non-blocking, shell:false', async () => {
    const opener = createBrowserOpener(makeDeps('darwin'));
    const code = await opener.open('http://127.0.0.1:1234/#abc123');
    assert.equal(code, 'OPEN_REQUESTED');
    assert.equal(calls.length, 1);
    const call0 = getCall();
    assert.equal(call0.command, 'open');
    assert.deepEqual(call0.args, ['http://127.0.0.1:1234/#abc123']);
    assert.equal(call0.options.detached ?? false, true);
    assert.equal(call0.options.stdio ?? '', 'ignore');
    assert.equal(call0.options.shell ?? true, false);
    assert.equal(diagnostics.length, 0);
  });

  it('Linux uses xdg-open with URL as single arg', async () => {
    const opener = createBrowserOpener(makeDeps('linux'));
    const code = await opener.open('http://example.com');
    assert.equal(code, 'OPEN_REQUESTED');
    const c1 = getCall();
    assert.equal(c1.command, 'xdg-open');
    assert.deepEqual(c1.args, ['http://example.com']);
    assert.equal(c1.options.shell ?? true, false);
  });

  it('Windows uses cmd with safe form and URL as one argument', async () => {
    const opener = createBrowserOpener(makeDeps('win32'));
    const code = await opener.open('http://127.0.0.1:0/#token');
    assert.equal(code, 'OPEN_REQUESTED');
    const c2 = getCall();
    assert.equal(c2.command, 'cmd.exe');
    assert.ok(c2.args.length >= 3);
    assert.equal(c2.args[0], '/c');
    assert.equal(c2.args[1], 'start');
    assert.equal(c2.args[2], '');
    assert.equal(c2.args[3], 'http://127.0.0.1:0/#token');
    assert.equal(c2.options.shell ?? true, false);
  });

  it('unsupported platform reports UNSUPPORTED_PLATFORM without spawn', async () => {
    const opener = createBrowserOpener(makeDeps('sunos'));
    const code = await opener.open('http://example.com');
    assert.equal(code, 'UNSUPPORTED_PLATFORM');
    assert.equal(calls.length, 0);
    assert.deepEqual(diagnostics, ['UNSUPPORTED_PLATFORM']);
  });

  it('synchronous spawn throw reports SPAWN_ERROR and resolves', async () => {
    const opener = createBrowserOpener(makeDeps('darwin', true));
    const code = await opener.open('http://example.com');
    assert.equal(code, 'SPAWN_ERROR');
    assert.equal(calls.length, 1);
    assert.deepEqual(diagnostics, ['SPAWN_ERROR']);
  });

  it('child error event reports SPAWN_ERROR without unhandled rejection', async () => {
    const opener = createBrowserOpener(makeDeps('linux', false, true));
    const code = await opener.open('http://example.com');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(code, 'OPEN_REQUESTED');
    assert.deepEqual(diagnostics, ['SPAWN_ERROR']);
  });

  it('exactly one spawn per open invocation', async () => {
    const opener = createBrowserOpener(makeDeps('darwin'));
    await opener.open('u1');
    await opener.open('u2');
    assert.equal(calls.length, 2);
  });

  it('never passes URL or token to reporter', async () => {
    const opener = createBrowserOpener(makeDeps('sunos'));
    await opener.open('http://secret-token.example.com/#tok123');
    assert.ok(!JSON.stringify(diagnostics).includes('secret-token'));
    assert.ok(!JSON.stringify(diagnostics).includes('tok123'));
  });

  it('URL with metacharacters remains one inert argument (no shell)', async () => {
    const opener = createBrowserOpener(makeDeps('darwin'));
    const malicious = 'http://ex.com/a?b=c&d=";rm -rf';
    await opener.open(malicious);
    const c3 = getCall();
    assert.equal(c3.args.length, 1);
    assert.equal(c3.args[0], malicious);
    assert.equal(c3.options.shell ?? true, false);
  });
});
