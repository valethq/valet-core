import { definePlugin } from "@valethq/sdk";

export default definePlugin({
  async activate(ctx) {
    await ctx.store.projects.create({ name: "p", workspaceDir: "/tmp/fx" });
  },
});
