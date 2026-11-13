import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "@valethq/sdk";

declare module "@valethq/sdk" {
  interface ValetScopes {
    fxscope: { ping(): string };
  }
}

export default definePlugin({
  activate(ctx) {
    ctx.scopes.define({ name: "fxscope", version: 1, cardinality: "one" });
    ctx.scopes.provide("fxscope", (caller) => {
      writeFileSync(join(ctx.paths.data, "caller.json"), JSON.stringify(caller));
      return { ping: () => "pong" };
    });
  },
});
