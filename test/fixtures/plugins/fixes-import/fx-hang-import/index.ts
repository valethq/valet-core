import { definePlugin } from "@valethq/sdk";

await new Promise(() => {});

export default definePlugin({
  activate() {
    (globalThis as { __valet_fix_import_bad?: boolean }).__valet_fix_import_bad = true;
  },
});
