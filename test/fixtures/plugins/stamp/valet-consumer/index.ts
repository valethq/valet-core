import { definePlugin } from "@valethq/sdk";

export default definePlugin({
  activate(ctx) {
    const g = globalThis as unknown as Record<string, string>;
    g.__valet_whoami = ctx.scopes.get("stamp-scope").whoami();
  },
});
