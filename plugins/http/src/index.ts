import { watch } from "node:fs";
import { definePlugin } from "@valethq/sdk";
import { type HttpConfig, resolveListen } from "./config";
import { listen } from "./server";

const DEBOUNCE_MS = 250;

export default definePlugin<HttpConfig>({
  activate(ctx) {
    const cfg = resolveListen(ctx.config, ctx.paths.valetHome);
    let origins = cfg.allowedOrigins;
    const listener = listen(ctx.control, cfg, ctx.log, () => origins);

    // The legacy `server` block lives in core's config file, not this plugin's config, so plugin config
    // reloads do not see it. Watch the file for allowedOrigins-only changes; host/port changes need a restart.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = (): void => {
      const next = resolveListen(ctx.config, ctx.paths.valetHome);
      if (next.host !== cfg.host || next.port !== cfg.port)
        ctx.log.error("transport host/port change needs a restart", { host: next.host, port: next.port });
      origins = next.allowedOrigins;
    };
    const watcher = watch(ctx.paths.valetHome, { persistent: false }, (_event, filename) => {
      if (filename !== "config.toml" && filename !== "config.json") return;
      clearTimeout(timer);
      timer = setTimeout(refresh, DEBOUNCE_MS);
    });

    ctx.onDispose(() => {
      clearTimeout(timer);
      watcher.close();
      listener.stop();
    });
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
