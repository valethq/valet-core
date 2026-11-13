import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "@valethq/sdk";

declare module "@valethq/sdk" {
  interface ValetScopes {
    cleanscope: { y: number };
  }
}

export default definePlugin({
  activate(ctx) {
    ctx.events.before("project.create", () => {});
    ctx.scopes.define({ name: "cleanscope", version: 1, cardinality: "many" });
    ctx.scopes.provide("cleanscope", { y: 2 });
    ctx.http.route("GET", "/ping", () => new Response("ok"));
    ctx.ws.handle("fx-clean.ping", () => ({}));
    ctx.onDispose(() => {
      writeFileSync(
        join(ctx.paths.data, "disposed.json"),
        JSON.stringify({ disposed: true, aborted: ctx.signal.aborted }),
      );
    });
  },
});
