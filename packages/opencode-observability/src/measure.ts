export type Clock = () => string;

export interface ContextSnapshot {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: { readonly providerID: string; readonly id: string };
  readonly system: readonly unknown[];
  readonly messages: readonly unknown[];
  readonly tools: Readonly<Record<string, unknown>>;
}

export interface ContextMeta {
  readonly sessionID: string;
  readonly agent: string;
  readonly provider: string;
  readonly model: string;
  readonly systemCount: number;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly serializedChars: number;
  readonly utf8Bytes: number;
  readonly timestamp: string;
}

const defaultClock: Clock = () => new Date().toISOString();

export function measureContextMeta(
  event: ContextSnapshot,
  clock: Clock = defaultClock
): ContextMeta {
  const systemCount = event.system.length;
  const messageCount = event.messages.length;
  const toolCount = Object.keys(event.tools).length;

  const provider = event.model.providerID;
  const model = event.model.id;

  const serialized = JSON.stringify(event);
  const serializedChars = serialized.length;
  const utf8Bytes = Buffer.byteLength(serialized, 'utf8');

  return {
    sessionID: event.sessionID,
    agent: event.agent,
    provider,
    model,
    systemCount,
    messageCount,
    toolCount,
    serializedChars,
    utf8Bytes,
    timestamp: clock()
  };
}
