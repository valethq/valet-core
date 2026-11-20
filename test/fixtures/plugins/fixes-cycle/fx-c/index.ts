import { definePlugin } from "@valethq/sdk";

export default definePlugin({
  activate() {
    const g = globalThis as { __valet_fix_cycle?: string[] };
    g.__valet_fix_cycle = g.__valet_fix_cycle ?? [];
    g.__valet_fix_cycle.push("fx-c");
  },
});
