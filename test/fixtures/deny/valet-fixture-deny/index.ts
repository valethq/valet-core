import { definePlugin } from "@valethq/sdk";

interface DenyRule {
  kind?: "http" | "ws.sub" | "ws.call";
  path?: string;
}
interface DenyConfig {
  deny?: DenyRule[];
}

/** Policy fixture: denies control.request events matching a configured {kind, path} rule. */
export default definePlugin<DenyConfig>({
  activate(ctx) {
    ctx.events.before("control.request", (e) => {
      for (const rule of ctx.config.deny ?? []) {
        const kindOk = rule.kind === undefined || e.payload.kind === rule.kind;
        const pathOk = rule.path === undefined || e.payload.path === rule.path;
        if (kindOk && pathOk) e.deny(`fixture deny ${rule.kind ?? "*"}`);
      }
    });
  },
});
