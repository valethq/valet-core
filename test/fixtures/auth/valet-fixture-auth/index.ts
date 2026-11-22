import { definePlugin, ServiceDeniedError } from "@valethq/sdk";

interface AuthConfig {
  /** Bearer token that authenticates. */
  token?: string;
  /** External id for the fixture principal (created at activate via resolveIdentity). */
  externalId?: string;
  displayName?: string;
  /** Default "owner". */
  role?: "owner" | "trusted" | "guest";
  /** Report verified login evidence (default true). */
  verified?: boolean;
  /** Credential cap and tags returned on the AuthResult. */
  cap?: string[];
  tags?: string[];
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
    const role = cfg.role ?? "owner";
    if (role !== principal.role) await ctx.store.principals.setRole(principal.id, role);
    ctx.scopes.provide("identity", {
      credential: (id) => (id === "fixture-bearer" ? { active: !revoked } : undefined),
      authenticate(req) {
        if (cfg.deny === true) throw new ServiceDeniedError("fixture identity denied");
        if (
          cfg.token !== undefined &&
          !revoked &&
          req.headers.get("authorization") === `Bearer ${cfg.token}`
        ) {
          return {
            principalId: principal.id,
            credentialId: "fixture-bearer",
            verifiedLogin: cfg.verified ?? true,
            ...(cfg.cap === undefined ? {} : { cap: cfg.cap }),
            ...(cfg.tags === undefined ? {} : { tags: cfg.tags }),
          };
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
