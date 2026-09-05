/** @jsxImportSource @opentui/solid */
import { createSignal, onMount, onCleanup, Show } from 'solid-js';
import type { Context, Page } from '@opencode-ai/plugin/tui/context';
import { overviewDefinition, type DebugReadModel } from '../rpc';
import {
  parseRouteData,
  formatValue,
  formatBytes,
  formatDuration,
  formatTimestamp,
  installDebugNavigation
} from './session-navigation';

type LoadDebugState =
  | { state: 'loading' }
  | { state: 'missing-session'; message: string }
  | { state: 'no-run'; message: string }
  | { state: 'error'; message: string }
  | { state: 'ready'; model: DebugReadModel };

function assertNever(x: never): never {
  throw new Error('Unexpected value: ' + x);
}

function formatTimelineItem(t: DebugReadModel['timeline'][number]): string {
  switch (t.type) {
    case 'snapshot':
      return `snapshot seq:${t.sequence} hook:${formatBytes(t.hookEventBytes)}`;
    case 'model':
      return `model seq:${t.sequence} ${t.provider}/${t.model}`;
    case 'skill':
      return `skill ${t.skillName}`;
    default:
      return assertNever(t);
  }
}

async function loadDebug(
  sessionID: string | null,
  fetcher: (sid: string) => Promise<DebugReadModel>
): Promise<LoadDebugState> {
  if (!sessionID) {
    return { state: 'missing-session', message: 'No active session. Open a session and run /celestion-debug again.' };
  }
  try {
    const model = await fetcher(sessionID);
    if (model.overview.runID === null) {
      return { state: 'no-run', message: 'No observed run for this session.' };
    }
    return { state: 'ready', model };
  } catch (error: unknown) {
    if (error instanceof Error) {
      return { state: 'error', message: 'Failed to load debug.' };
    }
    throw error;
  }
}

function OverviewContent(props: { data?: unknown; ctx: Context }) {
  const ctx = props.ctx;
  const [loadState, setLoadState] = createSignal<LoadDebugState>({ state: 'loading' });
  const parsed = parseRouteData(props.data);
  const sessionID = parsed.sessionID;
  let navCleanup: (() => void) | null = null;
  let iv: ReturnType<typeof setInterval> | null = null;

  onMount(async () => {
    if (sessionID) {
      navCleanup = installDebugNavigation(ctx, sessionID);
    }
    const result = await loadDebug(sessionID, async (sid: string) => {
      const rpc = ctx.client.rpc(overviewDefinition);
      return rpc.getDebug({ sessionID: sid });
    });
    setLoadState(result);
    if (sessionID && result.state === 'ready') {
      const rpc = ctx.client.rpc(overviewDefinition);
      const refresh = async () => {
        try {
          const d = await rpc.getDebug({ sessionID });
          setLoadState({ state: 'ready', model: d });
        } catch (error: unknown) {
          if (error instanceof Error) {
            setLoadState({ state: 'error', message: 'Failed to refresh debug.' });
          } else {
            throw error;
          }
        }
      };
      iv = setInterval(refresh, 2000);
    }
  });

  onCleanup(() => {
    if (iv) clearInterval(iv);
    if (navCleanup) navCleanup();
  });

  return (
    <Show when={loadState().state === 'loading'} fallback={
      <Show when={loadState().state === 'missing-session'} fallback={
        <Show when={loadState().state === 'no-run'} fallback={
          <Show when={loadState().state === 'error'} fallback={
            <Show when={loadState().state === 'ready'}>
              {(() => {
                const state = loadState();
                if (state.state !== 'ready') return null;
                const d = state.model;
                const m = d.overview;
                const c = d.contextComponents;
                return (
                  <box flexDirection="column" padding={1}>
                    <text>CELESTION DEBUG</text>
                    <text>Run: {formatValue(m.runID)}</text>
                    <text>Session: {formatValue(m.sessionID)}</text>
                    <text>Agent: {formatValue(m.agent)}</text>
                    <text>Provider/Model: {formatValue(m.provider)}/{formatValue(m.model)}</text>
                    <text>Started: {formatTimestamp(m.startedAt)}</text>
                    <text>Duration: {formatDuration(m.durationMs)}</text>
                    <text>Status: {formatValue(m.status)}</text>
                    <text>Model Calls: {formatValue(m.modelCalls)}</text>
                    {c && (
                      <>
                        <text>Context Sys: {formatBytes(c.systemBytes)} ({c.systemCount})</text>
                        <text>Messages: {formatBytes(c.messagesBytes)} ({c.messageCount})</text>
                        <text>Tools: {formatBytes(c.toolsBytes)} ({c.toolCount})</text>
                        <text>Generation: {formatBytes(c.generationBytes)}</text>
                        <text>ProviderOptions: {formatBytes(c.providerOptionsBytes)}</text>
                        <text>HookEventBytes: {formatBytes(c.hookEventBytes)}</text>
                      </>
                    )}
                    {d.loadedSkills.length > 0 && <text>Skills:</text>}
                    {d.loadedSkills.map(s => <text>  {s.skillName} x{s.loadCount} first:{formatTimestamp(s.firstLoadedAt)}</text>)}
                    {d.timeline.length > 0 && <text>Recent Timeline:</text>}
                    {d.timeline.slice(-5).map((t) => <text>  {formatTimelineItem(t)}</text>)}
                    <text>Esc voltar para a sessao</text>
                  </box>
                );
              })()}
            </Show>
          }>
            <text>Failed to load debug.</text>
          </Show>
        }>
          <text>No observed run for this session.</text>
        </Show>
      }>
        <text>No active session. Open a session and run /celestion-debug again.</text>
      </Show>
    }>
      <text>loading...</text>
    </Show>
  );
}

export function createOverviewPage(ctx: Context): Page {
  return {
    name: 'celestion-debug',
    render: (input: { data?: unknown }) => <OverviewContent data={input.data} ctx={ctx} />
  };
}
