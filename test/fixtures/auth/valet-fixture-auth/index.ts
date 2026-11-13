import { definePlugin, ServiceDeniedError } from "@valethq/sdk";

interface AuthConfig {
  /** Bearer token that authenticates. */
  token?: string;
  /** External id for the fixture principal (created at activate via resolveIdentity). */
  externalId?: string;
  displayName?: string;
  role?: "owner" | "trusted" | "guest";
  /** Reject every request outright (10.2: provider throwing ServiceDeniedError -> 403). */
  deny?: boolean;
}

export default definePlugin<AuthConfig>({
  async activate(ctx) {
    const cfg = ctx.config;
    let revoked = false;
    const principal = ctx.store.principals.resolveIdentity("fixture", cfg.externalId ?? "fixture-user", {
      displayName: cfg.displayName ?? "Fixture User",
    });
    if (cfg.role !== undefined && cfg.role !== principal.role) {
      await ctx.store.principals.setRole(principal.id, cfg.role);
    }
    ctx.scopes.provide("identity", {
      authenticate(req) {
        if (cfg.deny === true) throw new ServiceDeniedError("fixture identity denied");
        if (
          cfg.token !== undefined &&
          !revoked &&
          req.headers.get("authorization") === `Bearer ${cfg.token}`
        ) {
          return { principalId: principal.id, credentialId: "fixture-bearer" };
        }
        return undefined;
      },
    });
    ctx.http.route(
      "POST",
      "/revoke",
      async () => {
        revoked = true;
        await ctx.events.emit("identity.changed", {});
        return Response.json({ ok: true });
      },
      { public: true },
    );
  },
});
