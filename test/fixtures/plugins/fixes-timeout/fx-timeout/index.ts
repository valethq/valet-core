import { definePlugin } from "@valethq/sdk";

export default definePlugin({
  activate(ctx) {
    const state = { aborted: false, lateActive: true, done: false };
    (globalThis as { __valet_fix_timeout?: typeof state }).__valet_fix_timeout = state;
    setTimeout(() => {
      const sub = ctx.events.before("core.ready", () => {});
      state.aborted = ctx.signal.aborted;
      state.lateActive = sub.active;
      state.done = true;
    }, 80);
    return new Promise(() => {});
  },
});
