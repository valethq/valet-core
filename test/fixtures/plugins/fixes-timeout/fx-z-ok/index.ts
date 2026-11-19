import { definePlugin } from "@valethq/sdk";

export default definePlugin({
  activate() {
    (globalThis as { __valet_fix_zok?: boolean }).__valet_fix_zok = true;
  },
});
