/** @jsxImportSource @opentui/solid */
import { createSignal, onMount, onCleanup } from 'solid-js';
import type { Context } from '@opencode-ai/plugin/tui/context';
import { overviewDefinition, type DebugReadModel } from '../rpc';
import { formatBytes } from './session-navigation';

export interface SidebarMetricsProps {
  readonly input: { readonly sessionID: string };
  readonly ctx: Context;
}

export function SidebarMetrics(props: SidebarMetricsProps) {
  const ctx = props.ctx;
  const [metrics, setMetrics] = createSignal<{ context: string; system: string; messages: string; tools: string; calls: string; skills: string } | null>(null);
  const sid = props.input.sessionID;

  const load = async (): Promise<DebugReadModel | null> => {
    try {
      const rpc = ctx.client.rpc(overviewDefinition);
      return await rpc.getDebug({ sessionID: sid });
    } catch (error: unknown) {
      if (error instanceof Error) return null;
      throw error;
    }
  };

  onMount(() => {
    if (!sid) return;
    const fetch = async () => {
      const d = await load();
      if (d && d.contextComponents) {
        const c = d.contextComponents;
        setMetrics({
          context: formatBytes(c.hookEventBytes),
          system: formatBytes(c.systemBytes),
          messages: formatBytes(c.messagesBytes),
          tools: formatBytes(c.toolsBytes),
          calls: String(d.overview.modelCalls ?? 0),
          skills: String(d.loadedSkills.length)
        });
      } else {
        setMetrics(null);
      }
    };
    fetch();
    const iv = setInterval(fetch, 2000);
    onCleanup(() => clearInterval(iv));
  });

  return (
    <box flexDirection="column" padding={0}>
      <text>Celestion</text>
      <text>Context: {metrics()?.context ?? 'N/A'}</text>
      <text>System: {metrics()?.system ?? 'N/A'}</text>
      <text>Messages: {metrics()?.messages ?? 'N/A'}</text>
      <text>Tools: {metrics()?.tools ?? 'N/A'}</text>
      <text>Calls: {metrics()?.calls ?? 'N/A'}</text>
      <text>Skills: {metrics()?.skills ?? 'N/A'}</text>
    </box>
  );
}
