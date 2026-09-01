import type { ContextSnapshot, Clock, ContextMeta } from './measure';
import { measureContextMeta } from './measure';

export type Sink = (line: string) => void;
export type FailureReporter = (diagnostic: string) => void;

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface ObserverDeps {
  readonly sink?: Sink;
  readonly clock?: Clock;
  readonly reporter?: FailureReporter;
}

const defaultSink: Sink = (line) => { process.stderr.write(line); };
const defaultReporter: FailureReporter = (d) => { process.stderr.write(d + '\n'); };

function toResult<T>(fn: () => T): Result<T, unknown> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: e };
  }
}

export function createContextObserver(deps: ObserverDeps = {}) {
  const sink = deps.sink ?? defaultSink;
  const clock = deps.clock;
  const reporter = deps.reporter ?? defaultReporter;

  return (event: ContextSnapshot): void => {
    const measureRes = toResult(() => measureContextMeta(event, clock));
    if (!measureRes.ok) {
      const diag = '[opencode-observability] measurement failed';
      toResult(() => reporter(diag));
      return;
    }
    const meta: ContextMeta = measureRes.value;
    const line = JSON.stringify({
      sessionID: meta.sessionID,
      agent: meta.agent,
      provider: meta.provider,
      model: meta.model,
      systemCount: meta.systemCount,
      messageCount: meta.messageCount,
      toolCount: meta.toolCount,
      serializedChars: meta.serializedChars,
      utf8Bytes: meta.utf8Bytes,
      timestamp: meta.timestamp
    }) + '\n';
    const sinkRes = toResult(() => sink(line));
    if (!sinkRes.ok) {
      const diag = '[opencode-observability] sink failed';
      toResult(() => reporter(diag));
    }
  };
}
