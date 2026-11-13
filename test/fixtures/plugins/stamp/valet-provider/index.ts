import { definePlugin } from "@valethq/sdk";

declare module "@valethq/sdk" {
  interface ValetScopes {
    "stamp-scope": { whoami(): string };
  }
}

export default definePlugin({
  activate(ctx) {
    const g = globalThis as unknown as Record<string, string>;
    ctx.scopes.define({ name: "stamp-scope", version: 1, cardinality: "many" });
    ctx.scopes.provide("stamp-scope", (caller) => {
      g.__valet_scope_caller = caller.plugin;
      return { whoami: () => caller.plugin };
    });
  },
});
