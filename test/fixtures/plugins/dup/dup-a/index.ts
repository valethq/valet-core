import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin } from "@valethq/sdk";

export default definePlugin({
  activate(ctx) {
    writeFileSync(
      join(ctx.paths.data, "marker.json"),
      JSON.stringify({ activated: true, id: ctx.plugin.id }),
    );
  },
});
