import { definePlugin } from "@valethq/sdk";

/** Identity fixture that throws a non-ServiceDeniedError: a broken provider must fail closed. */
export default definePlugin({
  activate(ctx) {
    ctx.scopes.provide("identity", {
      authenticate() {
        throw new Error("credential store is corrupt");
      },
    });
  },
});
