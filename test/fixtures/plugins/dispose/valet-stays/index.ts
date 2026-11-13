import { definePlugin } from "@valethq/sdk";

export default definePlugin({
  activate(ctx) {
    const g = globalThis as unknown as Record<string, unknown>;
    g.__valet_order = (g.__valet_order as string[] | undefined) ?? [];
    (g.__valet_order as string[]).push("valet-stays");
    ctx.events.before("dispose.probe", () => {});
    ctx.scopes.provide("dispose-scope", { ping: () => "pong2" }, { key: "stays" });
    ctx.http.route("GET", "/stays", () => new Response("{}"));
    ctx.ws.handle("stays.ping", () => "pong");
    ctx.onDispose(() => {
      g.__valet_disposed = (g.__valet_disposed as string[] | undefined) ?? [];
      (g.__valet_disposed as string[]).push("valet-stays");
    });
    ctx.signal.addEventListener("abort", () => {
      g.__valet_aborted = true;
    });
  },
  deactivate() {
    const g = globalThis as unknown as Record<string, string[]>;
    g.__valet_deactivated = g.__valet_deactivated ?? [];
    g.__valet_deactivated.push("valet-stays");
  },
});
