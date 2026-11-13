import { definePlugin } from "@valethq/sdk";
export default definePlugin({
  activate() {
    throw new Error("activation blew up");
  },
});
