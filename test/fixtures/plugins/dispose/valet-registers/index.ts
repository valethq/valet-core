import { definePlugin } from "@valethq/sdk";

declare module "@valethq/sdk" {
  interface ValetEvents {
    "dispose.probe": { n: number };
  }
  interface ValetScopes {
    "dispose-scope": { ping(): string };
  }
}

export default definePlugin({
  activate(ctx) {
    const g = globalThis as unknown as Record<string, string[]>;
    g.__valet_order = g.__valet_order ?? [];
    g.__valet_order.push("valet-registers");
    ctx.events.before("dispose.probe", () => {});
    ctx.events.after("dispose.probe", () => {});
    ctx.scopes.define({ name: "dispose-scope", version: 1, cardinality: "many" });
    ctx.scopes.provide("dispose-scope", { ping: () => "pong" });
    ctx.http.route("GET", "/probe", () => new Response("{}"));
    ctx.ws.handle("registers.ping", () => "pong");
    ctx.onDispose(() => {
      g.__valet_disposed = g.__valet_disposed ?? [];
      g.__valet_disposed.push("valet-registers");
    });
    throw new Error("activation failed after registering");
  },
});
