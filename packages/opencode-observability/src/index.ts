import { Plugin } from '@opencode-ai/plugin';
import type { Context } from '@opencode-ai/plugin/promise/plugin';
import type { StorageDomain } from '@opencode-ai/plugin/promise/storage';
import type { CommandDraft } from '@opencode-ai/plugin/promise/command';
import type { Registration } from '@opencode-ai/plugin/promise/registration';
import { createContextObserver } from './observer';
import { createCollector } from './collector';
import { HistoryPersistence } from './history-persistence';
import { StorageAdapter } from './storage-adapter';
import type { Store } from './store';
import { overviewDefinition, parseOverviewInput, readOverview, readDebug } from './rpc';
import { createHistoryRuntimeBridge, type HistoryRuntimeBridge } from './runtime-bridge';
import { registerHistoryHooks, type HookRegistrar, type Reg, type RuntimeEvent } from './runtime-hooks';
import type { PersistencePort } from './history-observer-shapes';
import type { HistoryEventReadSource } from './history-query';
import type { SessionHistoryEvent } from './history-domain';
import { createHistoryQuery } from './history-query';
import { createTokenFactory } from './server-security';
import { createDashboardAssets } from './server-assets';
import { createDashboardServer, type DashboardServer, type DashboardServerDeps } from './server';
import { createBrowserOpener, type BrowserOpener } from './browser-opener';
import { createCelestionHistoryCommand, type CelestionHistoryCommand } from './history-command';

  export { overviewDefinition };

type M0Observer = ReturnType<typeof createContextObserver>;

/** Complete local persistence contract for observability setup (PersistencePort + read source + subscribe + optional shutdown). */
type ObservabilityPersistence = PersistencePort &
  HistoryEventReadSource & {
    subscribeToAppends(listener: (event: SessionHistoryEvent) => void): () => void;
    readonly shutdown?: () => Promise<void>;
  };


export interface ObservabilitySetupDeps {
  readonly storage: StorageDomain;
  readonly registerM0: (observer: M0Observer) => Promise<Reg>;
  readonly createPersistence?: (storage: StorageDomain) => Promise<ObservabilityPersistence>;
  readonly createRegistrar: (deps: { readonly store: Store; readonly bridge: HistoryRuntimeBridge }) => HookRegistrar;
  readonly registerRpc: (store: Store) => Promise<Reg>;
  readonly registerCommand?: (cb: (draft: CommandDraft) => void) => Promise<Registration>;
  readonly createHistoryCommand?: (deps: { readonly server: DashboardServer; readonly opener: BrowserOpener }) => CelestionHistoryCommand;
  readonly createDashboardServer?: (deps: DashboardServerDeps) => DashboardServer;
 }

export default Plugin.define({
  id: 'celestion-observability-m0',
  async setup(ctx: Context) {
    return await setupObservabilityPlugin({
      storage: ctx.storage,
      registerM0: (observer) => ctx.session.hook('context', observer),
      createRegistrar: () => createRuntimeRegistrar(ctx),
      registerRpc: (store) => ctx.rpc.register(overviewDefinition, {
        getOverview: async (input: unknown) => {
          const parsed = parseOverviewInput(input);
          return readOverview(store, parsed);
        },
        getDebug: async (input: unknown) => {
          const parsed = parseOverviewInput(input);
          return readDebug(store, parsed);
        }
      }),
      registerCommand: (cb) => ctx.command.transform(cb)
    });
  }
});


export async function setupObservabilityPlugin(deps: ObservabilitySetupDeps): Promise<() => Promise<void>> {
  const observer = createContextObserver();
  let regM0: Reg | null = null;
  let bridge: HistoryRuntimeBridge | null = null;
  let rpcReg: Reg | null = null;
  let commandReg: Registration | null = null;
  let server: DashboardServer | null = null;
  let cleanupDone = false;
  try {
    regM0 = await deps.registerM0(observer);
    const store: Store = new StorageAdapter(deps.storage);
    const collector = createCollector({ store });
    const createdPersistence = await (deps.createPersistence ?? createDefaultPersistence)(deps.storage);
    bridge = await createHistoryRuntimeBridge({ store, persistence: createdPersistence });
    await registerHistoryHooks(deps.createRegistrar({ store, bridge }), store, collector, bridge);
    rpcReg = await deps.registerRpc(store);
    const historyQuery = createHistoryQuery(createdPersistence);
    const serverFactory = deps.createDashboardServer ?? createDashboardServer;
    server = serverFactory({
      queryService: historyQuery,
      tokenFactory: createTokenFactory(),
      assets: createDashboardAssets(),
      subscribe: (listener) => createdPersistence.subscribeToAppends(listener)
    });
    const opener = createBrowserOpener();
    const defaultHistoryCommand = (d: { readonly server: DashboardServer; readonly opener: BrowserOpener }) =>
      createCelestionHistoryCommand({ server: d.server, opener: d.opener, onDiagnostic: reportCodeOnly });
    const cmdFactory = deps.createHistoryCommand ?? defaultHistoryCommand;
    if (deps.registerCommand) {
      const cmd = cmdFactory({ server, opener });
      commandReg = await deps.registerCommand((draft) => {
        draft.add({ name: cmd.name, description: cmd.description, execute: (input) => cmd.execute({ sessionID: input.sessionID }) });
      });
    }

    return async () => {
      if (cleanupDone) return;
      cleanupDone = true;
      await cleanupSetupResources({ regM0, bridge, rpcReg, commandReg, server });
    };
  } catch (error) {
    await cleanupSetupResources({ regM0, bridge, rpcReg, commandReg, server });
    throw error;
  }
}


async function createDefaultPersistence(storage: StorageDomain): Promise<ObservabilityPersistence> {
  return await HistoryPersistence.create(storage, { onDiagnostic: reportCodeOnly });
}

function createRuntimeRegistrar(ctx: Context): HookRegistrar {
  return {
    registerPrompt: (cb) => ctx.session.hook('prompt', async (input) => {
      await cb({
        sessionID: input.sessionID,
        messageID: input.messageID,
        prompt: {
          text: input.prompt.text,
          files: input.prompt.files ?? [],
          agents: input.prompt.agents ?? [],
          skills: input.prompt.skills ?? []
        },
        delivery: input.delivery,
        metadata: input.metadata ?? {}
      });
    }),
    registerContext: (cb) => ctx.session.hook('context', cb),
    registerModelRequest: (cb) => ctx.session.hook('model.request', cb),
    registerRetry: (cb) => ctx.session.hook('retry', cb),
    registerToolBefore: (cb) => ctx.tool.hook('execute.before', cb),
    registerToolAfter: (cb) => ctx.tool.hook('execute.after', cb),
    registerPermission: (cb) => ctx.permission.hook('evaluate', cb),
    subscribeEvents: (options) => runtimeEvents(ctx, options)
  };
}

async function cleanupSetupResources(resources: { readonly regM0: Reg | null; readonly bridge: HistoryRuntimeBridge | null; readonly rpcReg: Reg | null; readonly commandReg?: Registration | null; readonly server?: DashboardServer | null }): Promise<void> {
  if (resources.regM0) { try { await disposeCodeOnly(resources.regM0); } catch { reportCodeOnly('REG_M0'); } }
  if (resources.bridge) { try { await resources.bridge.cleanup(); } catch { reportCodeOnly('BRIDGE'); } }
  if (resources.rpcReg) { try { await disposeCodeOnly(resources.rpcReg); } catch { reportCodeOnly('RPC'); } }
  if (resources.commandReg) { try { await disposeCodeOnly(resources.commandReg); } catch { reportCodeOnly('CMD'); } }
  if (resources.server) { try { await resources.server.stop(); } catch { reportCodeOnly('SERVER_STOP'); } }
}


function reportCodeOnly(_c: string) {}

async function disposeCodeOnly(registration: { readonly dispose: () => Promise<void> }): Promise<void> {
  try {
    await registration.dispose();
  } catch (error) {
    reportCodeOnly(error instanceof Error ? 'BRIDGE_ERROR' : 'BRIDGE_ERROR');
  }
}

async function* runtimeEvents(ctx: Context, options: { readonly signal?: AbortSignal }): AsyncIterable<RuntimeEvent> {
  for await (const ev of ctx.event.subscribe(options)) {
    switch (ev.type) {
      case 'session.created':
        yield { type: ev.type, data: { id: ev.data.sessionID, parentID: ev.data.parentID ?? null, title: ev.data.title ?? '', agent: ev.data.agent ?? null } };
        break;
      case 'session.renamed':
        yield { type: ev.type, data: { id: ev.data.sessionID, title: ev.data.title } };
        break;
      case 'session.deleted':
        yield { type: ev.type, data: { id: ev.data.sessionID } };
        break;
      case 'session.execution.started':
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted':
        yield { type: ev.type, id: ev.id, created: ev.created, data: { sessionID: ev.data.sessionID } };
        break;
      case 'session.skill.activated':
        yield { type: ev.type, id: ev.id, created: ev.created, data: { id: ev.data.id, name: ev.data.name, sessionID: ev.data.sessionID } };
        break;
      default:
        break;
    }
  }
}
