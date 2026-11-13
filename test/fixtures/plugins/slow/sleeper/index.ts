import { definePlugin } from "@valethq/sdk";
export default definePlugin({
  activate(ctx) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1_500);
      ctx.signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      });
    });
  },
});
