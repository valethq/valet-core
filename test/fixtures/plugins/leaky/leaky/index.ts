import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "@valethq/sdk";

declare module "@valethq/sdk" {
  interface ValetScopes {
    leakyscope: { x: number };
  }
}

export default definePlugin({
  activate(ctx) {
    ctx.events.before("project.create", () => {});
    ctx.scopes.define({ name: "leakyscope", version: 1, cardinality: "many" });
    ctx.scopes.provide("leakyscope", { x: 1 });
    ctx.http.route("GET", "/ping", () => new Response("ok"));
    ctx.ws.handle("fx-leaky.ping", () => ({}));
    ctx.onDispose(() => {
      writeFileSync(join(ctx.paths.data, "disposed.json"), JSON.stringify({ disposed: true }));
    });
    throw new Error("activation blew up");
  },
});
