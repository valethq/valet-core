import { definePlugin } from "@valethq/sdk";

export default definePlugin({
  async activate(ctx) {
    await ctx.events.emit("emitx.ping", { n: 7 });
  },
});
