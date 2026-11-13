import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "@valethq/sdk";

export default definePlugin({
  activate(ctx) {
    const out = ctx.scopes.get("fxscope").ping();
    writeFileSync(join(ctx.paths.data, "result.json"), JSON.stringify({ out }));
  },
});
