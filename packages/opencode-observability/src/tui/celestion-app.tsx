/** @jsxImportSource @opentui/solid */
import type { Context } from '@opencode-ai/plugin/tui/context';
import { activeSessionToDestination } from './session-navigation';

export function CelestionApp(props: { ctx: Context }) {
  const ctx = props.ctx;
  ctx.keymap.layer(() => ({
    mode: 'global',
    commands: [{
      id: 'celestion-debug.open',
      slash: { name: 'celestion-debug' },
      run: () => {
        const current = ctx.ui.router.current();
        const dest = activeSessionToDestination(current);
        if (dest) {
          ctx.ui.router.navigate(dest);
        } else {
          ctx.ui.router.navigate({ type: 'plugin', name: 'celestion-debug' });
        }
      }
    }]
  }));
  return null;
}
