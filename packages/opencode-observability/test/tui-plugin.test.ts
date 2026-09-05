import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Context, Page, SlotClaim } from '@opencode-ai/plugin/tui/context';
import tuiPlugin from '../src/tui';

describe('tui plugin setup', () => {
  it('mounts the slash command through the global app slot without accessing the component-owned keymap layer', () => {
    let registeredPage: Page | undefined;
    const registeredSlots: string[] = [];
    let directKeymapCalls = 0;
    const context = {
      ui: {
        router: {
          register(page: Page) {
            registeredPage = page;
            return () => {};
          }
        },
        slot(claim: SlotClaim) {
          if ('append' in claim) registeredSlots.push(claim.append);
          return () => {};
        }
      },
      keymap: {
        layer() {
          directKeymapCalls++;
          throw new Error('Keymap.Provider is missing');
        }
      }
    } as unknown as Context;

    assert.doesNotThrow(() => tuiPlugin.setup(context));
    assert.equal(registeredPage?.name, 'celestion-debug');
    assert.ok(registeredSlots.includes('app'));
    assert.ok(registeredSlots.includes('sidebar.content'));
    assert.equal(directKeymapCalls, 0);
  });

  it('renders the global command layer without requiring PluginContextProvider', () => {
    let renderSlot: (() => unknown) | undefined;
    let commandMode: string | undefined;
    let commandID: string | undefined;
    let commandName: string | undefined;
    const context = {
      ui: {
        router: {
          register() {
            return () => {};
          }
        },
        slot(claim: SlotClaim) {
          if ('append' in claim && claim.append === 'app') {
            renderSlot = () => claim.render({});
          }
          return () => {};
        }
      },
      keymap: {
        layer(input: () => { mode?: string; commands?: ReadonlyArray<{ id?: string; slash?: { name: string } }> }) {
          const layer = input();
          commandMode = layer.mode;
          commandID = layer.commands?.[0]?.id;
          commandName = layer.commands?.[0]?.slash?.name;
        }
      }
    } as unknown as Context;

    tuiPlugin.setup(context);
    assert.ok(renderSlot);
    assert.doesNotThrow(renderSlot);
    assert.equal(commandMode, 'global');
    assert.equal(commandID, 'celestion-debug.open');
    assert.equal(commandName, 'celestion-debug');
  });

  it('passes setup context into the overview route before reaching the host renderer boundary', () => {
    let renderPage: (() => unknown) | undefined;
    const context = {
      ui: {
        router: {
          register(page: Page) {
            renderPage = () => page.render({});
            return () => {};
          }
        },
        slot() {
          return () => {};
        }
      }
    } as unknown as Context;

    tuiPlugin.setup(context);
    assert.ok(renderPage);
    assert.throws(renderPage, (error: unknown) => {
      return error instanceof Error && error.message === 'No renderer found';
    });
  });

  it('registers both app and sidebar.content slots and wires sidebar render with sessionID', () => {
    const registered: string[] = [];
    let sidebarRender: SlotClaim<'sidebar.content'>['render'] | undefined;
    const context = {
      ui: {
        router: { register() { return () => {}; } },
        slot(claim: SlotClaim) {
          if ('append' in claim) {
            registered.push(claim.append);
            if (claim.append === 'sidebar.content') sidebarRender = claim.render;
          }
          return () => {};
        }
      },
      keymap: { layer() { return () => {}; } }
    } as unknown as Context;
    tuiPlugin.setup(context);
    assert.ok(registered.includes('app'));
    assert.ok(registered.includes('sidebar.content'));
    assert.ok(sidebarRender);
    assert.throws(() => sidebarRender?.({ sessionID: 'ses_sidebar' }), (e: unknown) => e instanceof Error && e.message === 'No renderer found');
  });

});
