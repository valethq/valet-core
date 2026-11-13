import { definePlugin } from "@valethq/sdk";

declare module "@valethq/sdk" {
  interface ValetEvents {
    "stamper.ping": { n: number };
  }
}

export default definePlugin({
  async activate(ctx) {
    const g = globalThis as unknown as Record<string, string[] | undefined>;
    const order = g.__valet_order ?? [];
    g.__valet_order = order;
    order.push("valet-stamper");
    await ctx.events.emit("stamper.ping", { n: 1 });
    await ctx.store.projects.create({ name: "p", workspaceDir: "/tmp/ws" });
  },
});
