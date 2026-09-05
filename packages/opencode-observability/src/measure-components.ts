export interface ContextComponentSizes {
  readonly systemBytes: number;
  readonly messagesBytes: number;
  readonly toolsBytes: number;
  readonly generationBytes: number | null;
  readonly providerOptionsBytes: number | null;
  readonly hookEventBytes: number;
}

export function measureContextComponents(event: {
  readonly system?: readonly unknown[];
  readonly messages?: readonly unknown[];
  readonly tools?: Readonly<Record<string, unknown>>;
  readonly generation?: unknown;
  readonly providerOptions?: unknown;
}): ContextComponentSizes {
  const systemBytes = Buffer.byteLength(JSON.stringify(event.system ?? []), 'utf8');
  const messagesBytes = Buffer.byteLength(JSON.stringify(event.messages ?? []), 'utf8');
  const toolsBytes = Buffer.byteLength(JSON.stringify(event.tools ?? {}), 'utf8');
  const generationBytes = event.generation !== undefined ? Buffer.byteLength(JSON.stringify(event.generation), 'utf8') : null;
  const providerOptionsBytes = event.providerOptions !== undefined ? Buffer.byteLength(JSON.stringify(event.providerOptions), 'utf8') : null;
  const hookEventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
  return { systemBytes, messagesBytes, toolsBytes, generationBytes, providerOptionsBytes, hookEventBytes };
}
