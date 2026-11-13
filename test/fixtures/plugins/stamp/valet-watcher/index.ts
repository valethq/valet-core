import { definePlugin } from "@valethq/sdk";

export default definePlugin({
  activate(ctx) {
    const g = globalThis as unknown as Record<string, [string, string][]>;
    g.__valet_stamp = g.__valet_stamp ?? [];
    const stamp = g.__valet_stamp;
    ctx.events.before("stamper.ping", (e) => {
      stamp.push(["event", e.caller.plugin]);
    });
    ctx.events.before("project.create", (e) => {
      stamp.push(["store", e.caller.plugin]);
    });
  },
});
