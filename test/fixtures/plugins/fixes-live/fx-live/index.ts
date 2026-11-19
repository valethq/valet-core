import { definePlugin } from "@valethq/sdk";

let signal: AbortSignal | undefined;

export default definePlugin({
  activate(ctx) {
    signal = ctx.signal;
    const timer = setInterval(() => {
      const g = globalThis as { __valet_fix_ticks?: number };
      g.__valet_fix_ticks = (g.__valet_fix_ticks ?? 0) + 1;
    }, 20);
    (globalThis as { __valet_fix_timer?: ReturnType<typeof setInterval> }).__valet_fix_timer = timer;
    ctx.signal.addEventListener("abort", () => {
      clearInterval(timer);
      (globalThis as { __valet_fix_aborted?: boolean }).__valet_fix_aborted = true;
    });
    ctx.onDispose(() => {
      clearInterval(timer);
      (globalThis as { __valet_fix_disposed?: boolean }).__valet_fix_disposed = true;
    });
  },
  deactivate() {
    const g = globalThis as { __valet_fix_stop?: string[] };
    g.__valet_fix_stop = g.__valet_fix_stop ?? [];
    g.__valet_fix_stop.push(`fx-live:${signal?.aborted === true}`);
  },
});
