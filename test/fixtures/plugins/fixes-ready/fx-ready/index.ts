import { definePlugin } from "@valethq/sdk";

let signal: AbortSignal | undefined;

export default definePlugin({
  activate(ctx) {
    signal = ctx.signal;
    ctx.events.before("core.ready", () => {
      throw new Error("ready blew up");
    });
  },
  deactivate() {
    const g = globalThis as { __valet_fix_stop?: string[] };
    g.__valet_fix_stop = g.__valet_fix_stop ?? [];
    g.__valet_fix_stop.push(`fx-ready:${signal?.aborted === true}`);
  },
});
