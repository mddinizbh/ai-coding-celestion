import { Plugin } from '@opencode-ai/plugin/tui';
import type { Context, SlotClaim } from '@opencode-ai/plugin/tui/context';
import { createOverviewPage } from './overview-page';
import { SidebarMetrics } from './sidebar-metrics';
import { CelestionApp } from './celestion-app';

export default Plugin.define({
  id: 'celestion-debug-tui',
  setup(ctx: Context) {
    const cleanupPage = ctx.ui.router.register(createOverviewPage(ctx));
    const sidebarClaim: SlotClaim<'sidebar.content'> = {
      append: 'sidebar.content',
      render: (input) => SidebarMetrics({ input, ctx })
    };
    const cleanupSidebar = ctx.ui.slot(sidebarClaim);
    const appClaim: SlotClaim<'app'> = {
      append: 'app',
      render: () => CelestionApp({ ctx })
    };
    const cleanupSlot = ctx.ui.slot(appClaim);
    return () => {
      cleanupPage();
      cleanupSidebar();
      cleanupSlot();
    };
  }
});
