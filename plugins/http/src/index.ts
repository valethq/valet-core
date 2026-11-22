import { definePlugin } from "@valethq/sdk";
import { type HttpConfig, resolveListen } from "./config";
import { listen } from "./server";

export default definePlugin<HttpConfig>({
  activate(ctx) {
    const cfg = resolveListen(ctx.config, ctx.paths.valetHome);
    let origins = cfg.allowedOrigins;
    const listener = listen(ctx.control, cfg, ctx.log, () => origins);
    ctx.onDispose(() => listener.stop());
    ctx.log.info("control plane listening", { url: listener.baseUrl(), from: cfg.source });
    ctx.scopes.provide("transport", { baseUrl: () => listener.baseUrl() });
    ctx.onConfigChange((next) => {
      const want = resolveListen(next, ctx.paths.valetHome);
      if (want.host !== cfg.host || want.port !== cfg.port)
        throw new Error("host or port change needs a restart");
      origins = want.allowedOrigins;
    });
  },
});
