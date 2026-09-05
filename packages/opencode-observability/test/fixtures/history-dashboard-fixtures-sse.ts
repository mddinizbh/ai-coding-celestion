import assert from 'node:assert/strict';
import http from 'node:http';
import { z } from 'zod';
import { eventSchema } from './history-dashboard-fixtures-schema';

export type SSEEvent = { readonly cursor: string; readonly event: z.infer<typeof eventSchema> };

export const sseEventSchema = z.object({
  cursor: z.string(),
  event: eventSchema,
}).strict();

export async function fetchJSON<T>(origin: string, path: string, token: string, schema: z.ZodSchema<T>, init?: RequestInit): Promise<{ status: number; json: T | null; errorCode?: string | undefined }> {
  const res = await fetch(`${origin}${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  });
  if (res.ok) {
    const raw = await res.json();
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new Error(`malformed response shape: ${parsed.error.message}`);
    return { status: res.status, json: parsed.data };
  }
  const text = await res.text();
  let errorCode: string | undefined;
  try {
    const errSchema = z.object({ error: z.string() }).strict();
    const parsedErr = errSchema.safeParse(JSON.parse(text));
    if (parsedErr.success) {
      errorCode = parsedErr.data.error;
    } else {
      errorCode = text;
    }
  } catch { errorCode = text; }
  return { status: res.status, json: null, errorCode };
}

export async function collectSSE(
  origin: string,
  path: string,
  token: string,
  expectedCount: number,
  timeoutMs: number
): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const res = await fetch(`${origin}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (!res.body) throw new Error('no body');
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (events.length < expectedCount) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1 && events.length < expectedCount) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (chunk.startsWith(':')) continue;
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (dataLine) {
            const raw = JSON.parse(dataLine.slice(6));
            const parsed = sseEventSchema.safeParse(raw);
            if (!parsed.success) throw new Error(`malformed SSE frame: ${parsed.error.message}`);
            events.push(parsed.data);
          }
        }
      }
    } finally {
      if (reader) {
        try { await reader.cancel(); } catch { /* ignore */ }
        reader.releaseLock();
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      // timeout path
    } else {
      throw err;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  if (events.length !== expectedCount) {
    throw new Error(`SSE timeout: expected exactly ${expectedCount} but observed ${events.length}`);
  }
  return events;
}

export function extractToken(launchURL: string): string {
  const hash = launchURL.split('#')[1] || '';
  if (!hash) throw new Error('no token in fragment');
  return hash;
}

export async function expectConnectionRefused(origin: string): Promise<void> {
  let refused = false;
  try {
    await fetch(`${origin}/health`);
  } catch {
    refused = true;
  }
  assert.equal(refused, true, 'expected connection refused after stop');
}

export async function canRebind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}
