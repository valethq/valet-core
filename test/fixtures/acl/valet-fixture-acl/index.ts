import { can, definePlugin } from "@valethq/sdk";

/** ACL fixture: declared, implicit and resource-scoped route permissions, a topic, a call, ctx.control and can(). */
export default definePlugin({
  activate(ctx) {
    ctx.http.route("GET", "/open", (_req, rc) => Response.json({ principal: rc.principal?.id ?? null }), {
      permission: "fxacl:open",
    });
    ctx.http.route("GET", "/implicit", () => Response.json({ ok: true }));
    ctx.http.route("GET", "/items/:id", (_req, rc) => Response.json({ id: rc.params.id }), {
      permission: "fxacl:item.read",
      resource: (req) => ({ id: `item:${new URL(req.url).pathname.split("/").pop()}` }),
    });
    ctx.http.route(
      "GET",
      "/can/:perm",
      (_req, rc) => Response.json(can(ctx, rc.caller, rc.params.perm ?? "")),
      {
        permission: "fxacl:open",
      },
    );
    ctx.http.route(
      "GET",
      "/relay",
      async (req) => {
        const res = await ctx.control.dispatch(
          new Request(`http://valet.invalid/api/core/projects`, { headers: req.headers }),
        );
        return Response.json({ status: res.status });
      },
      { public: true },
    );
    ctx.ws.topic("fxacl:feed:", { permission: "fxacl:feed" });
    ctx.ws.handle("fxacl.secret", () => ({ secret: true }), { permission: "fxacl:item.read" });
    ctx.ws.handle("fxacl.hello", () => ({ hello: true }), { permission: "fxacl:open" });
    ctx.http.route(
      "POST",
      "/publish",
      async (req) => {
        ctx.ws.publish("fxacl:feed:1", "tick", await req.json());
        return Response.json({ ok: true });
      },
      { public: true },
    );
  },
});
