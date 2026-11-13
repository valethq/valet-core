import { definePlugin } from "@valethq/sdk";

declare module "@valethq/sdk" {
  interface ValetEvents {
    "emitter.allowed": { n: number };
    "other.nope": { n: number };
  }
}

export default definePlugin({
  async activate(ctx) {
    const out: Record<string, string> = {};
    const attempt = async (
      key: string,
      name: "emitter.allowed" | "other.nope" | "core.ready" | "tool.call",
      payload: never,
    ) => {
      try {
        await ctx.events.emit(name, payload);
        out[key] = "ok";
      } catch (error) {
        out[key] = (error as Error).message;
      }
    };
    await attempt("own", "emitter.allowed", { n: 1 } as never);
    await attempt("foreign", "other.nope", { n: 1 } as never);
    await attempt("coreEvt", "core.ready", {} as never);
    await attempt("toolcall", "tool.call", {
      runId: "r",
      callId: "c",
      name: "t",
      input: {},
      role: "owner",
    } as never);
    (globalThis as unknown as Record<string, unknown>).__valet_emit = out;
  },
});
