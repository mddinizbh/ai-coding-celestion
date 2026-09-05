import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeSessionTitle, titleSanitizerSchema } from '../src/title-sanitizer';
import {
  sessionLineageSchema,
  sessionHistoryEventSchema,
  type SessionHistoryEventDraft
} from '../src/history-domain';

type ToolStartedDraft = Extract<SessionHistoryEventDraft, { readonly type: 'tool.started' }>;
type RunEndedDraft = Extract<SessionHistoryEventDraft, { readonly type: 'run.ended' }>;

describe('SessionLineage contract', () => {
  it('sanitizes title via boundary schema (normalized, redacted, capped)', () => {
    const raw = '  hello\r\nworld sk-abc123  ';
    const parsed = sessionLineageSchema.parse({
      sessionID: 's1',
      parentSessionID: null,
      agent: null,
      sanitizedTitle: raw,
      kind: 'work',
      observedAtMs: 1
    });
    assert.equal(parsed.sanitizedTitle, sanitizeSessionTitle(raw));
  });
});

describe('SessionHistoryEvent closed union', () => {
  it('parses every one of the 13 variants via schema', () => {
    const variants = [
      { eventID: 'e1', runID: 'r1', sessionID: 's1', sequence: 1, timestampMs: 1, type: 'run.started', parentSessionID: null },
      { eventID: 'e2', runID: 'r1', sessionID: 's1', sequence: 2, timestampMs: 2, type: 'run.ended', status: 'succeeded', parentSessionID: null },
      { eventID: 'e3', runID: 'r1', sessionID: 's1', sequence: 3, timestampMs: 3, type: 'prompt.observed', messageID: 'm1', delivery: 'sync', partCount: 2, serializedBytes: 100 },
      { eventID: 'e4', runID: 'r1', sessionID: 's1', sequence: 4, timestampMs: 4, type: 'model.request', provider: 'anthropic', model: 'claude' },
      { eventID: 'e5', runID: 'r1', sessionID: 's1', sequence: 5, timestampMs: 5, type: 'agent.observed', agent: 'a1' },
      { eventID: 'e6', runID: 'r1', sessionID: 's1', sequence: 6, timestampMs: 6, type: 'agent.changed', agent: 'a2' },
      { eventID: 'e7', runID: 'r1', sessionID: 's1', sequence: 7, timestampMs: 7, type: 'tool.started', callID: 'c1', name: 'fs' },
      { eventID: 'e8', runID: 'r1', sessionID: 's1', sequence: 8, timestampMs: 8, type: 'tool.finished', callID: 'c1', status: 'ok', durationMs: 10, orphan: false },
      { eventID: 'e9', runID: 'r1', sessionID: 's1', sequence: 9, timestampMs: 9, type: 'permission.evaluated', action: 'read', effect: 'allow', resourceCount: 1 },
      { eventID: 'e10', runID: 'r1', sessionID: 's1', sequence: 10, timestampMs: 10, type: 'skill.loaded', skillID: 'sk1', skillName: 'git' },
      { eventID: 'e11', runID: 'r1', sessionID: 's1', sequence: 11, timestampMs: 11, type: 'context.snapshot', snapshotRef: { runID: 'r1', sessionID: 's1', sequence: 1 } },
      { eventID: 'e12', runID: 'r1', sessionID: 's1', sequence: 12, timestampMs: 12, type: 'retry', attempt: 1 },
      { eventID: 'e13', runID: 'r1', sessionID: 's1', sequence: 13, timestampMs: 13, type: 'error.sanitized', message: 'redacted' }
    ] as const;

    for (const v of variants) {
      const parsed = sessionHistoryEventSchema.parse(v);
      assert.equal(parsed.type, v.type);
    }
  });
});

describe('SessionHistoryEventDraft distributive omit', () => {
  it('extracts tool.started and run.ended drafts omitting eventID/sequence', () => {
    const toolStarted: ToolStartedDraft = {
      runID: 'r1',
      sessionID: 's1',
      timestampMs: 100,
      type: 'tool.started',
      callID: 'c42',
      name: 'fs.read'
    } as const;

    const runEnded: RunEndedDraft = {
      runID: 'r1',
      sessionID: 's1',
      timestampMs: 200,
      type: 'run.ended',
      status: 'succeeded',
      parentSessionID: null
    } as const;

    assert.equal(toolStarted.type, 'tool.started');
    assert.equal(toolStarted.callID, 'c42');
    assert.equal(runEnded.type, 'run.ended');
    assert.equal(runEnded.status, 'succeeded');
  });
});

describe('title-sanitizer contract', () => {
  it('normalizes line breaks to space, collapses ws, trims, caps at 160', () => {
    const input = 'hello\r\n\r\nworld   test\n\n  ';
    const result = sanitizeSessionTitle(input);
    assert.equal(result, 'hello world test');
    assert.ok(result.length <= 160);
  });

  it('returns safe non-sensitive title for empty input', () => {
    assert.equal(sanitizeSessionTitle(''), '(untitled session)');
    assert.equal(sanitizeSessionTitle('   \n\t  '), '(untitled session)');
  });

  it('redacts recognizable credential material', () => {
    const input = 'key=sk-abc123def456 token=xyz';
    const result = sanitizeSessionTitle(input);
    assert.ok(result.includes('[REDACTED]'));
    assert.ok(!result.includes('sk-abc123def456'));
  });

  const credentialCases = [
    ['GitHub classic token', 'run ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD now', 'ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD'],
    ['GitHub fine-grained token', 'run github_pat_1234567890_abcdefghijklmnopqrstuvwxyzABCDEFG', 'github_pat_1234567890_abcdefghijklmnopqrstuvwxyzABCDEFG'],
    ['AWS access key ID', 'aws AKIA1234567890ABCDEF configured', 'AKIA1234567890ABCDEF'],
    ['Bearer credential', 'curl -H Bearer abc.def-ghi_1234567890', 'abc.def-ghi_1234567890'],
    ['Authorization bearer header', 'Authorization: Bearer header.token-1234567890', 'header.token-1234567890']
  ] as const;

  for (const [name, input, credential] of credentialCases) {
    it(`redacts ${name}`, () => {
      const result = sanitizeSessionTitle(input);
      assert.ok(result.includes('[REDACTED]'));
      assert.ok(!result.includes(credential));
    });
  }

  it('uses zod transform for boundary', () => {
    const parsed = titleSanitizerSchema.parse('  foo\r\nbar  ');
    assert.equal(parsed, 'foo bar');
  });

  it('caps at exactly 160 code points preserving leading astral without replacement', () => {
    const astral = '𠜎' + 'a'.repeat(200);
    const result = sanitizeSessionTitle(astral);
    const cps = Array.from(result);
    assert.equal(cps.length, 160);
    assert.equal(cps[0], '𠜎');
    assert.ok(!result.includes('\uFFFD'));
  });
});


describe('zod boundary schemas (strict + constraints)', () => {
  it('rejects extra fields on lineage and events', () => {
    assert.throws(() => sessionLineageSchema.parse({ sessionID: 's1', parentSessionID: null, agent: null, sanitizedTitle: 't', kind: 'work', observedAtMs: 1, extra: true }));
    assert.throws(() => sessionHistoryEventSchema.parse({ eventID: 'e', runID: 'r', sessionID: 's', sequence: 0, timestampMs: 0, type: 'retry', attempt: 0, extra: 1 }));
  });

  it('rejects negative sequence / count / attempt and invalid run.ended status', () => {
    assert.throws(() => sessionHistoryEventSchema.parse({ eventID: 'e', runID: 'r', sessionID: 's', sequence: -1, timestampMs: 0, type: 'retry', attempt: 0 }));
    assert.throws(() => sessionHistoryEventSchema.parse({ eventID: 'e', runID: 'r', sessionID: 's', sequence: 0, timestampMs: 0, type: 'run.ended', status: 'unknown', parentSessionID: null }));
  });

  it('rejects empty IDs and non-finite / negative numeric fields where required', () => {
    assert.throws(() => sessionHistoryEventSchema.parse({ eventID: '', runID: 'r', sessionID: 's', sequence: 0, timestampMs: 0, type: 'retry', attempt: 0 }));
    assert.throws(() => sessionHistoryEventSchema.parse({ eventID: 'e', runID: 'r', sessionID: 's', sequence: 0, timestampMs: -1, type: 'retry', attempt: 0 }));
  });
});

describe('tool.finished durationMs numeric invariant', () => {
  it('rejects negative and non-finite durationMs when non-null', () => {
    assert.throws(() => sessionHistoryEventSchema.parse({ eventID: 'e', runID: 'r', sessionID: 's', sequence: 0, timestampMs: 0, type: 'tool.finished', callID: 'c1', status: 'ok', durationMs: -1, orphan: false }));
    assert.throws(() => sessionHistoryEventSchema.parse({ eventID: 'e', runID: 'r', sessionID: 's', sequence: 0, timestampMs: 0, type: 'tool.finished', callID: 'c1', status: 'ok', durationMs: Infinity, orphan: false }));
  });
});

describe('schema numeric invariants (table-driven)', () => {
  const cases = [
    ['negative partCount', { eventID: 'e', runID: 'r', sessionID: 's', sequence: 0, timestampMs: 0, type: 'prompt.observed', messageID: 'm', delivery: 'd', partCount: -1, serializedBytes: 10 }],
    ['non-integer partCount', { eventID: 'e', runID: 'r', sessionID: 's', sequence: 0, timestampMs: 0, type: 'prompt.observed', messageID: 'm', delivery: 'd', partCount: 1.5, serializedBytes: 10 }],
    ['negative serializedBytes', { eventID: 'e', runID: 'r', sessionID: 's', sequence: 0, timestampMs: 0, type: 'prompt.observed', messageID: 'm', delivery: 'd', partCount: 1, serializedBytes: -1 }],
    ['non-finite serializedBytes', { eventID: 'e', runID: 'r', sessionID: 's', sequence: 0, timestampMs: 0, type: 'prompt.observed', messageID: 'm', delivery: 'd', partCount: 1, serializedBytes: NaN }],
    ['negative resourceCount', { eventID: 'e', runID: 'r', sessionID: 's', sequence: 0, timestampMs: 0, type: 'permission.evaluated', action: 'a', effect: 'e', resourceCount: -1 }],
    ['negative attempt', { eventID: 'e', runID: 'r', sessionID: 's', sequence: 0, timestampMs: 0, type: 'retry', attempt: -1 }],
    ['negative observedAtMs', { sessionID: 's1', parentSessionID: null, agent: null, sanitizedTitle: 't', kind: 'work', observedAtMs: -1 }],
    ['negative nested snapshotRef.sequence', { eventID: 'e', runID: 'r', sessionID: 's', sequence: 0, timestampMs: 0, type: 'context.snapshot', snapshotRef: { runID: 'r', sessionID: 's', sequence: -1 } }]
  ] as const;

  for (const [name, payload] of cases) {
    it(`rejects ${name}`, () => {
      if ('type' in payload) {
        assert.throws(() => sessionHistoryEventSchema.parse(payload));
      } else {
        assert.throws(() => sessionLineageSchema.parse(payload));
      }
    });
  }
});
