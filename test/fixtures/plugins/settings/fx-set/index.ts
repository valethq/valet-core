import { definePlugin } from "@valethq/sdk";

interface Cfg {
  mode?: string;
  level?: number;
  label?: string;
  reject?: boolean;
  veto?: boolean;
}

export default definePlugin<Cfg>({
  activate(ctx) {
    const state = { ctx, calls: [] as Cfg[] };
    (globalThis as unknown as { __valet_set?: typeof state }).__valet_set = state;
    ctx.scopes.provide("tools", { list: () => [] });
    ctx.onConfigCheck((next) => {
      if (next.veto) throw new Error("vetoed by plugin");
    });
    ctx.onConfigChange((next) => {
      if (next.reject) throw new Error("refused by plugin");
      state.calls.push(next);
    });
  },
});
