import { definePlugin } from "@valethq/sdk";

type Cfg = Record<string, unknown>;

export default definePlugin<Cfg>({
  activate(ctx) {
    const state = { ctx, calls: [] as Cfg[], checks: [] as Cfg[] };
    (globalThis as unknown as { __valet_v3?: typeof state }).__valet_v3 = state;
    ctx.onConfigCheck((next) => {
      state.checks.push(next);
      if (next.header === "veto") throw new Error("vetoed by plugin");
    });
    ctx.onConfigChange((next) => {
      if (typeof next.header === "string" && next.header.includes("boom"))
        throw new Error(`cannot use ${next.header}`);
      state.calls.push(next);
    });
  },
});
