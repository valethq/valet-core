import { definePlugin } from "@valethq/sdk";

interface Live {
  n?: number;
  fail?: boolean;
}

export default definePlugin<Live>({
  activate(ctx) {
    const g = globalThis as unknown as { __valet_live?: { ctx: typeof ctx; calls: [Live, Live][] } };
    const state = { ctx, calls: [] as [Live, Live][] };
    g.__valet_live = state;
    ctx.onConfigChange((next, prev) => {
      state.calls.push([next, prev]);
      if (next.fail) throw new Error("cannot apply live");
    });
  },
});
