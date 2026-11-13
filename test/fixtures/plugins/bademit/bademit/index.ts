import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "@valethq/sdk";

declare module "@valethq/sdk" {
  interface ValetEvents {
    "bademit.ping": { n: number };
    "other.evt": { n: number };
  }
}

export default definePlugin({
  async activate(ctx) {
    const out: Record<string, string> = {};
    try {
      await ctx.events.emit("other.evt", { n: 1 });
      out.other = "emitted";
    } catch (error) {
      out.other = `threw: ${(error as Error).message}`;
    }
    try {
      await ctx.events.emit("bademit.ping", { n: 1 });
      out.own = "emitted";
    } catch (error) {
      out.own = `threw: ${(error as Error).message}`;
    }
    writeFileSync(join(ctx.paths.data, "emit.json"), JSON.stringify(out));
  },
});
