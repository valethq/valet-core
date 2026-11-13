import { definePlugin } from "@valethq/sdk";
export default definePlugin({
  activate() {
    const g = globalThis as unknown as Record<string, string[]>;
    g.__valet_order = g.__valet_order ?? [];
    g.__valet_order.push("valet-soft-child");
  },
});
