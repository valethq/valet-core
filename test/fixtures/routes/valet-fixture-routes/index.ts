import { definePlugin, ServiceDeniedError } from "@valethq/sdk";

/** Route/WS fixture: a :param route, a public webhook route, an HTML route, ws methods. */
export default definePlugin({
  activate(ctx) {
    ctx.http.route("GET", "/echo/:word", (_req, c) =>
      Response.json({ word: c.params.word, principal: c.principal?.id ?? null }),
    );
    ctx.http.route("POST", "/hook", async (req) => Response.json({ ok: true, body: await req.text() }), {
      public: true,
    });
    ctx.http.route(
      "GET",
      "/page",
      () => new Response("<html>hi</html>", { headers: { "content-type": "text/html" } }),
    );
    ctx.ws.handle("fx.ping", (params) => ({ pong: params }));
    ctx.ws.handle("fx.shout", (params) => {
      ctx.ws.publish("fx:news", "fx.shout", params);
      return { sent: true };
    });
    ctx.ws.handle("fx.fail", () => {
      throw new ServiceDeniedError("fixture call denied");
    });
  },
});
