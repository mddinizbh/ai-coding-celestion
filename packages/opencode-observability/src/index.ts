import { Plugin } from '@opencode-ai/plugin';
import type { Context } from '@opencode-ai/plugin/promise/plugin';
import { createContextObserver } from './observer';

export default Plugin.define({
  id: 'celestion-observability-m0',
  async setup(ctx: Context) {
    const observer = createContextObserver();
    const registration = await ctx.session.hook('context', observer);
    return registration.dispose;
  }
});
