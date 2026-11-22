import type { Caller } from "./events";
import type { PluginContext } from "./plugin";
import type { Role } from "./tools";

export interface AclDoc {
  permissions: Record<string, PermissionDef>; // key is the name without the namespace
}
export interface PermissionDef {
  summary: string;
  /** Lowest role that holds the permission when no grant says otherwise. Default "owner". */
  default?: Role;
  /** Resource kind the check carries, e.g. "session". Documentation and policy validation only. */
  resource?: string;
  /** Requires evidence of a verified control-plane login, independently of policy grants. */
  requireVerifiedLogin?: boolean;
}

export interface Audience {
  /** Tier for readers the platform cannot enumerate. Omit only when the reader list is complete. */
  tier?: Role;
  /** Readers the platform can enumerate. */
  principals?: string[];
}

export type Decision = { allow: true } | { allow: false; by: string; reason: string };

export interface ResourceScope {
  id: string;
  ancestors?: readonly string[];
}

/** The current state of one credential, as its identity provider sees it. */
export interface CredentialState {
  active: boolean;
  cap?: readonly string[];
  tags?: readonly string[];
}

/** spec-gap: the doc does not say how `can` reaches declared permissions and credential state; core serves them on `ctx.acl`. */
export interface AclHost {
  /** A declared permission by full name ("exec:run"): core's, every active plugin's `acl`, and each namespace's implicit `<ns>:control`. */
  permission(name: string): PermissionDef | undefined;
  /** Every declared permission name, for policy validation. */
  names(): string[];
  /** The issuing identity provider's view of a core-stamped credential reference; undefined when no provider can answer. */
  credential(credentialId: string): CredentialState | undefined;
}

export const ROLE_RANK: Readonly<Record<Role, number>> = { guest: 0, trusted: 1, owner: 2 };

export const roleAtLeast = (role: Role, min: Role): boolean => ROLE_RANK[role] >= ROLE_RANK[min];

export const lowestRole = (roles: readonly Role[]): Role =>
  roles.reduce<Role>((low, r) => (ROLE_RANK[r] < ROLE_RANK[low] ? r : low), "owner");

/** A pattern is a full name, `<namespace>:*` or `*`. */
export function matchPermission(pattern: string, permission: string): boolean {
  if (pattern === "*" || pattern === permission) return true;
  return pattern.endsWith(":*") && permission.startsWith(pattern.slice(0, -1));
}

export const scopeOf = (resource: string | ResourceScope | undefined): ResourceScope | undefined =>
  typeof resource === "string" ? { id: resource } : resource;

export type AclContext = Pick<PluginContext, "acl" | "scopes" | "store" | "log"> & {
  readonly plugin: { readonly id: string };
};

const warned = new Set<string>();
const deny = (by: string, reason: string): Decision => ({ allow: false, by, reason });
const ALLOW: Decision = { allow: true };

/**
 * Effective permission (Subject): credential liveness and cap, verified login, the principal's grants, then every
 * audience reader's grants. With a `policy@1` provider each grant is its decision; without one, the declared default
 * tier. An undeclared permission is denied and logged once.
 */
export function can(
  ctx: AclContext,
  caller: Caller,
  permission: string,
  resource?: string | ResourceScope,
): Decision {
  const by = ctx.plugin.id;
  const def = ctx.acl.permission(permission);
  if (def === undefined) {
    if (!warned.has(permission)) {
      warned.add(permission);
      ctx.log.warn(`undeclared permission "${permission}" denied`);
    }
    return deny(by, `undeclared permission ${permission}`);
  }
  const actor = caller.actor;
  if (caller.credentialId !== undefined) {
    const state = ctx.acl.credential(caller.credentialId);
    if (state === undefined || !state.active) return deny(by, "credential is not active");
    if (state.cap !== undefined && !state.cap.some((p) => matchPermission(p, permission)))
      return deny(by, `credential is not allowed ${permission}`);
  }
  if (actor?.cap !== undefined && !actor.cap.some((p) => matchPermission(p, permission)))
    return deny(by, `caller is not allowed ${permission}`);
  if (def.requireVerifiedLogin && caller.verifiedLogin !== true)
    return deny(by, `${permission} requires a verified login`);

  const scope = scopeOf(resource);
  const action =
    caller.authenticatedBy === undefined ? undefined : { authenticatedBy: caller.authenticatedBy };
  const policy = policyOf(ctx);
  const grant = (subject: { principalId?: string; role: Role; tags?: readonly string[] }): Decision => {
    if (policy !== undefined) {
      try {
        return policy.check(subject, permission, scope, action);
      } catch (error) {
        ctx.log.error("policy provider failed; using role defaults", { error: String(error) });
      }
    }
    return roleAtLeast(subject.role, def.default ?? "owner")
      ? ALLOW
      : deny(by, `${subject.principalId ?? subject.role} does not hold ${permission}`);
  };
  const roleOf = (id: string): Role => ctx.store.principals.get(id)?.role ?? "guest";

  const self = actor
    ? grant({
        principalId: actor.principalId,
        role: roleOf(actor.principalId),
        ...(actor.tags === undefined ? {} : { tags: actor.tags }),
      })
    : grant({ role: "guest" });
  if (!self.allow) return self;
  for (const reader of actor?.audience?.principals ?? []) {
    if (reader === actor?.principalId) continue;
    const d = grant({ principalId: reader, role: roleOf(reader) });
    if (!d.allow) return deny(d.by, `audience member ${reader} does not hold ${permission}`);
  }
  const tier = actor?.audience?.tier;
  if (tier !== undefined) {
    const d = grant({ role: tier });
    if (!d.allow) return deny(d.by, `a ${tier} reader does not hold ${permission}`);
  }
  return ALLOW;
}

function policyOf(ctx: AclContext) {
  try {
    return ctx.scopes.maybe("policy");
  } catch (error) {
    ctx.log.error("policy provider unavailable; using role defaults", { error: String(error) });
    return undefined;
  }
}
