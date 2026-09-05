import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HISTORY_CURSOR_VERSION,
  checkCompatibility,
  compareBoundaries,
  decodeHistoryCursor,
  encodeHistoryCursor,
  type HistoryCursorBoundary,
  type HistoryCursorContext,
  type HistoryCursorPayload
} from '../src/history-cursor';

const tokenFromJson = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
const tokenFromValue = (value: unknown): string => tokenFromJson(JSON.stringify(value));

const baseBoundary: HistoryCursorBoundary = {
  timestampMs: 1725000000000,
  sessionID: 'session-a',
  runID: 'run-a',
  sequence: 1
};

const basePayload: HistoryCursorPayload = {
  version: HISTORY_CURSOR_VERSION,
  rootSessionID: 'root-a',
  selectedSessionID: 'session-a',
  scope: 'session',
  includeSystem: false,
  direction: 'older',
  boundary: baseBoundary
};

const baseContext: HistoryCursorContext = {
  rootSessionID: 'root-a',
  selectedSessionID: 'session-a',
  scope: 'session',
  includeSystem: false,
  direction: 'older'
};

describe('history cursor codec round-trip', () => {
  const validPayloads = [
    basePayload,
    {
      ...basePayload,
      rootSessionID: 'root-b',
      selectedSessionID: 'session-b',
      scope: 'subtree',
      includeSystem: true,
      direction: 'newer',
      boundary: { timestampMs: 0, sessionID: 'session-b', runID: 'run-b', sequence: 0 }
    },
    {
      ...basePayload,
      boundary: { timestampMs: 9007199254740991, sessionID: 'session-c', runID: 'run-c', sequence: 123456789 }
    }
  ] as const satisfies readonly HistoryCursorPayload[];

  for (const [index, payload] of validPayloads.entries()) {
    it(`round-trips payload #${index + 1} with exact field equality`, () => {
      const decoded = decodeHistoryCursor(encodeHistoryCursor(payload));
      if (!decoded.ok) {
        assert.fail('expected decode success');
      }
      assert.deepEqual(decoded.value, payload);
    });

    it(`re-encode of decode equals original token for payload #${index + 1}`, () => {
      const token = encodeHistoryCursor(payload);
      const decoded = decodeHistoryCursor(token);
      if (!decoded.ok) {
        assert.fail('expected decode success');
      }
      assert.equal(encodeHistoryCursor(decoded.value), token);
    });
  }

  it('encodes deterministically across calls', () => {
    assert.equal(encodeHistoryCursor(basePayload), encodeHistoryCursor(basePayload));
  });

  it('encodes deterministically regardless of payload key order', () => {
    const scrambled: HistoryCursorPayload = {
      direction: basePayload.direction,
      includeSystem: basePayload.includeSystem,
      boundary: {
        sequence: baseBoundary.sequence,
        runID: baseBoundary.runID,
        sessionID: baseBoundary.sessionID,
        timestampMs: baseBoundary.timestampMs
      },
      scope: basePayload.scope,
      selectedSessionID: basePayload.selectedSessionID,
      rootSessionID: basePayload.rootSessionID,
      version: basePayload.version
    };
    assert.equal(encodeHistoryCursor(scrambled), encodeHistoryCursor(basePayload));
  });

  it('emits unpadded base64url alphabet only', () => {
    const token = encodeHistoryCursor(basePayload);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(token));
    assert.ok(!token.includes('='));
  });
});

describe('history cursor decode sanitized failures', () => {
  const malformedTokens: readonly [name: string, token: string][] = [
    ['malformed base64 garbage', '!!!!not-base64!!!!'],
    ['empty token', ''],
    ['valid base64 but invalid JSON', tokenFromJson('{')],
    ['valid base64 but prose text', tokenFromJson('not json at all')],
    ['JSON number instead of object', tokenFromJson('5')],
    ['JSON null', tokenFromJson('null')],
    ['JSON array', tokenFromJson('[]')]
  ];

  for (const [name, token] of malformedTokens) {
    it(`rejects ${name} with sanitized CURSOR_INVALID`, () => {
      assert.deepEqual(decodeHistoryCursor(token), { ok: false, code: 'CURSOR_INVALID' });
    });
  }

  const schemaCases: readonly [name: string, payload: unknown][] = [
    ['missing rootSessionID', { ...basePayload, rootSessionID: undefined }],
    ['missing direction', { ...basePayload, direction: undefined }],
    ['missing boundary', { rootSessionID: 'root-a', selectedSessionID: 'session-a', scope: 'session', includeSystem: false, direction: 'older', version: HISTORY_CURSOR_VERSION }],
    ['missing version', { rootSessionID: 'root-a', selectedSessionID: 'session-a', scope: 'session', includeSystem: false, direction: 'older', boundary: baseBoundary }],
    ['extra field rejected by strict', { ...basePayload, evil: 'EXTRA_MARKER' }],
    ['wrong type for includeSystem', { ...basePayload, includeSystem: 'false' }],
    ['wrong type for timestampMs', { ...basePayload, boundary: { ...baseBoundary, timestampMs: '1725000000000' } }],
    ['wrong version 0', { ...basePayload, version: 0 }],
    ['wrong version 2', { ...basePayload, version: 2 }],
    ['wrong version 1.5', { ...basePayload, version: 1.5 }],
    ['wrong version negative', { ...basePayload, version: -1 }],
    ['missing boundary timestampMs', { ...basePayload, boundary: { sessionID: 's', runID: 'r', sequence: 0 } }],
    ['missing boundary sessionID', { ...basePayload, boundary: { timestampMs: 0, runID: 'r', sequence: 0 } }],
    ['missing boundary runID', { ...basePayload, boundary: { timestampMs: 0, sessionID: 's', sequence: 0 } }],
    ['missing boundary sequence', { ...basePayload, boundary: { timestampMs: 0, sessionID: 's', runID: 'r' } }],
    ['timestampMs negative', { ...basePayload, boundary: { ...baseBoundary, timestampMs: -1 } }],
    ['sequence negative', { ...basePayload, boundary: { ...baseBoundary, sequence: -1 } }],
    ['sequence non-integer', { ...basePayload, boundary: { ...baseBoundary, sequence: 1.5 } }],
    ['empty rootSessionID', { ...basePayload, rootSessionID: '' }],
    ['empty selectedSessionID', { ...basePayload, selectedSessionID: '' }],
    ['empty boundary sessionID', { ...basePayload, boundary: { ...baseBoundary, sessionID: '' } }],
    ['empty boundary runID', { ...basePayload, boundary: { ...baseBoundary, runID: '' } }],
    ['scope enum violation', { ...basePayload, scope: 'bogus' }],
    ['direction enum violation', { ...basePayload, direction: 'both' }]
  ];

  for (const [name, payload] of schemaCases) {
    it(`rejects ${name} with sanitized CURSOR_INVALID`, () => {
      assert.deepEqual(decodeHistoryCursor(tokenFromValue(payload)), { ok: false, code: 'CURSOR_INVALID' });
    });
  }

  it('rejects Infinity timestampMs arriving via 1e999 JSON exponent', () => {
    const json = JSON.stringify(basePayload).replace('1725000000000', '1e999');
    assert.deepEqual(decodeHistoryCursor(tokenFromJson(json)), { ok: false, code: 'CURSOR_INVALID' });
  });

  it('rejects NaN timestampMs that serialized to null', () => {
    const poisoned: HistoryCursorPayload = { ...basePayload, boundary: { ...baseBoundary, timestampMs: Number.NaN } };
    assert.deepEqual(decodeHistoryCursor(encodeHistoryCursor(poisoned)), { ok: false, code: 'CURSOR_INVALID' });
  });

  it('failure value carries no payload fragment or parse detail', () => {
    const secret = 'ses_TOP_SECRET_LEAK';
    const result = decodeHistoryCursor(tokenFromValue({ ...basePayload, rootSessionID: secret, extra: secret }));
    assert.equal(result.ok, false);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes('error'));
    assert.ok(!serialized.includes('message'));
  });
});

describe('history cursor compatibility', () => {
  it('accepts a cursor matching root, selected session, scope, filter, and direction', () => {
    assert.deepEqual(checkCompatibility(basePayload, baseContext), { ok: true, value: basePayload });
  });

  const mismatchCases: readonly [name: string, context: HistoryCursorContext][] = [
    ['root session mismatch', { ...baseContext, rootSessionID: 'other-root' }],
    ['selected session mismatch', { ...baseContext, selectedSessionID: 'other-session' }],
    ['scope mismatch', { ...baseContext, scope: 'subtree' }],
    ['includeSystem mismatch', { ...baseContext, includeSystem: true }],
    ['direction mismatch', { ...baseContext, direction: 'newer' }]
  ];

  for (const [name, context] of mismatchCases) {
    it(`rejects ${name} with one sanitized code`, () => {
      assert.deepEqual(checkCompatibility(basePayload, context), { ok: false, code: 'CURSOR_SCOPE_MISMATCH' });
    });
  }
});

describe('history cursor boundary comparator', () => {
  it('orders by timestampMs first', () => {
    const a: HistoryCursorBoundary = { timestampMs: 1, sessionID: 'zzz', runID: 'zzz', sequence: 99 };
    const b: HistoryCursorBoundary = { timestampMs: 2, sessionID: 'aaa', runID: 'aaa', sequence: 0 };
    assert.ok(compareBoundaries(a, b) < 0);
    assert.ok(compareBoundaries(b, a) > 0);
  });

  it('breaks timestamp ties by sessionID string compare', () => {
    const a: HistoryCursorBoundary = { timestampMs: 5, sessionID: 'ses_a', runID: 'zzz', sequence: 99 };
    const b: HistoryCursorBoundary = { timestampMs: 5, sessionID: 'ses_b', runID: 'aaa', sequence: 0 };
    assert.ok(compareBoundaries(a, b) < 0);
    assert.ok(compareBoundaries(b, a) > 0);
  });

  it('string compare is code-unit lexicographic, not numeric, not locale-collated', () => {
    const a: HistoryCursorBoundary = { timestampMs: 5, sessionID: 'ses_10', runID: 'r', sequence: 0 };
    const b: HistoryCursorBoundary = { timestampMs: 5, sessionID: 'ses_9', runID: 'r', sequence: 0 };
    assert.ok(compareBoundaries(a, b) < 0);
  });

  it('breaks session ties by runID', () => {
    const a: HistoryCursorBoundary = { timestampMs: 5, sessionID: 'ses_a', runID: 'run_1', sequence: 99 };
    const b: HistoryCursorBoundary = { timestampMs: 5, sessionID: 'ses_a', runID: 'run_2', sequence: 0 };
    assert.ok(compareBoundaries(a, b) < 0);
    assert.ok(compareBoundaries(b, a) > 0);
  });

  it('breaks runID ties by sequence', () => {
    const a: HistoryCursorBoundary = { timestampMs: 5, sessionID: 'ses_a', runID: 'run_1', sequence: 3 };
    const b: HistoryCursorBoundary = { timestampMs: 5, sessionID: 'ses_a', runID: 'run_1', sequence: 4 };
    assert.ok(compareBoundaries(a, b) < 0);
    assert.ok(compareBoundaries(b, a) > 0);
  });

  it('returns exactly 0 for identical tuples', () => {
    assert.equal(compareBoundaries(baseBoundary, { ...baseBoundary }), 0);
  });

  it('sorts a mixed list into canonical ascending order', () => {
    const unsorted: HistoryCursorBoundary[] = [
      { timestampMs: 5, sessionID: 'ses_a', runID: 'run_1', sequence: 2 },
      { timestampMs: 1, sessionID: 'ses_z', runID: 'run_9', sequence: 9 },
      { timestampMs: 5, sessionID: 'ses_a', runID: 'run_1', sequence: 1 },
      { timestampMs: 3, sessionID: 'ses_a', runID: 'run_1', sequence: 0 },
      { timestampMs: 5, sessionID: 'ses_a', runID: 'run_0', sequence: 7 }
    ];
    const sorted = [...unsorted].sort(compareBoundaries);
    assert.deepEqual(sorted.map((b) => b.timestampMs), [1, 3, 5, 5, 5]);
    assert.deepEqual(sorted.map((b) => b.runID), ['run_9', 'run_1', 'run_0', 'run_1', 'run_1']);
    assert.deepEqual(sorted.map((b) => b.sequence), [9, 0, 7, 1, 2]);
  });
});
