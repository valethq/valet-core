import { definePlugin, type PluginContext } from "@valethq/sdk";

let ctx: PluginContext | undefined;

export default definePlugin({
  activate(context) {
    ctx = context;
  },
  async deactivate() {
    const signal = ctx?.signal;
    const state = { aborted: signal?.aborted === true, lateActive: true, lateDone: false };
    (globalThis as { __valet_fix_shutdown?: typeof state }).__valet_fix_shutdown = state;
    if (signal !== undefined && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    setTimeout(() => {
      const sub = ctx?.events.before("core.ready", () => {});
      state.lateActive = sub?.active === true;
      state.lateDone = true;
    }, 40);
  },
});
