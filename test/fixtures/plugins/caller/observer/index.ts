import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "@valethq/sdk";

declare module "@valethq/sdk" {
  interface ValetEvents {
    "emitx.ping": { n: number };
  }
}

export default definePlugin({
  activate(ctx) {
    ctx.events.after("emitx.ping", (e) => {
      writeFileSync(join(ctx.paths.data, "event-caller.json"), JSON.stringify(e.caller));
    });
    ctx.events.before("project.create", (e) => {
      writeFileSync(join(ctx.paths.data, "store-caller.json"), JSON.stringify(e.caller));
    });
  },
});
