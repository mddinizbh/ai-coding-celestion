import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { measureContextMeta, type ContextSnapshot, type Clock } from '../src/measure';
import { createContextObserver, type Sink, type FailureReporter } from '../src/observer';
import { measureContextComponents } from '../src/measure-components';

const fixedIso = '2026-09-01T00:00:00.000Z';
const fixedClock: Clock = () => fixedIso;

const fixture: ContextSnapshot = {
  sessionID: 'ses_test123',
  agent: 'test-agent',
  model: { id: 'claude-3-5-sonnet-20241022', providerID: 'anthropic' },
  system: [{ type: 'text', text: 'sys' }],
  messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }],
  tools: {}
} as const;

const expectedChars = 248;
const expectedBytes = 248;

describe('measureContextMeta', () => {
  it('computes deterministic metadata with injected clock', () => {
    const meta = measureContextMeta(fixture, fixedClock);
    assert.equal(meta.sessionID, 'ses_test123');
    assert.equal(meta.agent, 'test-agent');
    assert.equal(meta.provider, 'anthropic');
    assert.equal(meta.model, 'claude-3-5-sonnet-20241022');
    assert.equal(meta.systemCount, 1);
    assert.equal(meta.messageCount, 2);
    assert.equal(meta.toolCount, 0);
    assert.equal(meta.serializedChars, expectedChars);
    assert.equal(meta.utf8Bytes, expectedBytes);
    assert.equal(meta.timestamp, fixedIso);
  });
});

describe('createContextObserver fail-open', () => {
  it('sink throws: callback does not throw, reporter receives sanitized diagnostic', () => {
    const diags: string[] = [];
    const reporter: FailureReporter = (d) => { diags.push(d); };
    const throwingSink: Sink = () => { throw new Error('boom'); };
    const observer = createContextObserver({ sink: throwingSink, clock: fixedClock, reporter });
    // must not throw
    observer(fixture);
    assert.equal(diags.length, 1);
    assert.equal(diags[0], '[opencode-observability] sink failed');
  });

  it('both sink and reporter throw: callback still does not throw', () => {
    const throwingSink: Sink = () => { throw new Error('sink'); };
    const throwingReporter: FailureReporter = () => { throw new Error('rep'); };
    const observer = createContextObserver({ sink: throwingSink, clock: fixedClock, reporter: throwingReporter });
    observer(fixture);
  });

  it('measurement failure: callback does not throw, sink not called, reporter gets measurement failed', () => {
    const diags: string[] = [];
    const reporter: FailureReporter = (d) => { diags.push(d); };
    let sinkCalled = false;
    const sink: Sink = () => { sinkCalled = true; };
    const circ: Record<string, unknown> = {};
    circ['self'] = circ;
    const bad: ContextSnapshot = { ...fixture, tools: circ };
    const observer = createContextObserver({ sink, clock: fixedClock, reporter });
    observer(bad);
    assert.equal(sinkCalled, false);
    assert.equal(diags.length, 1);
    assert.equal(diags[0], '[opencode-observability] measurement failed');
  });
});

describe('Etapa B measureContextComponents (real sizing)', () => {
  it('computes deterministic UTF-8 bytes per component + hook event', () => {
    const ctx = {
      sessionID: 's1',
      agent: 'a1',
      model: { providerID: 'anthropic', id: 'claude' },
      system: [{ type: 'text', text: 'sys' }],
      messages: [{ role: 'user', content: 'hi' }],
      tools: { t1: { description: 'd', input: {} } },
      generation: { temperature: 0.7 },
      providerOptions: { anthropic: { thinking: { type: 'enabled' } } }
    } as const;
    const sizes = measureContextComponents(ctx);
    assert.equal(sizes.systemBytes, 30);
    assert.equal(sizes.messagesBytes, 32);
    assert.equal(sizes.toolsBytes, 37);
    assert.equal(sizes.generationBytes, 19);
    assert.equal(sizes.providerOptionsBytes, 45);
    assert.equal(sizes.hookEventBytes, 307);
  });
});
