import { definePlugin } from "@valethq/sdk";

/** Observer fixture: records event callers/payloads, exposes them over a public route. */
export default definePlugin({
  activate(ctx) {
    const seen: unknown[] = [];
    const names = ["control.request", "project.create", "session.create", "message.create"] as const;
    for (const name of names) {
      ctx.events.after(name, (e) => {
        seen.push({ name: e.name, caller: e.caller, payload: e.payload });
      });
    }
    ctx.http.route("GET", "/seen", () => Response.json(seen), { public: true });
  },
});
