import { definePlugin } from "@valethq/sdk";

export default definePlugin({
  activate() {
    (globalThis as { __valet_fix_import_ok?: boolean }).__valet_fix_import_ok = true;
  },
});
