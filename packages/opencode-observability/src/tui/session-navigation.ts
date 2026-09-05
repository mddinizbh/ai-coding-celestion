import type { Context, Destination } from '@opencode-ai/plugin/tui/context';
import type { OverviewReadModel } from '../rpc';

export interface ParsedRouteData {
  readonly sessionID: string | null;
}

export function activeSessionToDestination(route: unknown): Destination | null {
  if (route === null || typeof route !== 'object') return null;
  if (!('type' in route) || route.type !== 'session') return null;
  if (!('sessionID' in route) || typeof route.sessionID !== 'string' || route.sessionID === '') return null;
  return {
    type: 'plugin',
    name: 'celestion-debug',
    data: { sessionID: route.sessionID }
  };
}

export function parseRouteData(data: unknown): ParsedRouteData {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { sessionID: null };
  }
  if ('sessionID' in data && typeof data.sessionID === 'string' && data.sessionID !== '') {
    return { sessionID: data.sessionID };
  }
  return { sessionID: null };
}

export function formatValue(v: string | number | null): string {
  if (v === null) return 'N/A';
  return String(v);
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'N/A';
  if (bytes === 0) return '0 B';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return 'N/A';
  if (ms === 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

export function formatTimestamp(ts: number | null): string {
  if (ts === null) return 'N/A';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

export type LoadState =
  | { state: 'missing-session'; message: string }
  | { state: 'no-run'; message: string }
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; model: OverviewReadModel };

export async function loadOverview(
  sessionID: string | null,
  fetcher: (sid: string) => Promise<OverviewReadModel>
): Promise<LoadState> {
  if (!sessionID) {
    return { state: 'missing-session', message: 'No active session. Open a session and run /celestion-debug again.' };
  }
  try {
    const model: OverviewReadModel = await fetcher(sessionID);
    if (model.runID === null) {
      return { state: 'no-run', message: 'No observed run for this session.' };
    }
    return { state: 'ready', model };
  } catch (error: unknown) {
    if (error instanceof Error) {
      return { state: 'error', message: 'Failed to load overview.' };
    }
    throw error;
  }
}

export type DebugNavigationCtx = {
  readonly keymap: {
    layer: Context['keymap']['layer'];
    mode: Pick<Context['keymap']['mode'], 'push'>;
  };
  readonly ui: { router: { navigate(dest: { type: 'session'; sessionID: string }): void } };
};

export function installDebugNavigation(ctx: DebugNavigationCtx, sessionID: string): () => void {
  ctx.keymap.layer(() => ({
    mode: 'celestion-debug',
    commands: [{ id: 'celestion-debug.back', bind: 'escape', run: () => ctx.ui.router.navigate({ type: 'session', sessionID }) }]
  }));
  return ctx.keymap.mode.push('celestion-debug');
}
