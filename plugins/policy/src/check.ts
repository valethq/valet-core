import {
  type Decision,
  matchPermission,
  type PolicyAction,
  type ResourceScope,
  type Role,
  roleAtLeast,
} from "@valethq/sdk";
import type { CompiledPolicy } from "./compile";
import { matches, type SelectorEnv, type Subject } from "./selectors";
import type { Grant } from "./types";

export interface CheckEnv extends Omit<SelectorEnv, "groups"> {
  by: string;
  defaultTier(permission: string): Role;
}

const resourceMatches = (patterns: readonly string[], scope: ResourceScope | undefined): boolean => {
  if (scope === undefined) return false;
  const ids = [scope.id, ...(scope.ancestors ?? [])];
  return patterns.some((p) => ids.some((id) => (p.endsWith("*") ? id.startsWith(p.slice(0, -1)) : id === p)));
};

function grantApplies(
  g: Grant,
  subject: Subject,
  permission: string,
  scope: ResourceScope | undefined,
  action: PolicyAction | undefined,
  env: CheckEnv,
  groups: CompiledPolicy["groups"],
): boolean {
  if (!g.allow.some((p) => matchPermission(p, permission))) return false;
  if (g.on !== undefined && !resourceMatches(g.on, scope)) return false;
  if (g.via === "authenticated" && action?.authenticatedBy === undefined) return false;
  return g.to.some((s) => matches(s, subject, { ...env, groups }));
}

export function evaluate(
  policy: CompiledPolicy,
  env: CheckEnv,
  subject: Subject,
  permission: string,
  scope?: ResourceScope,
  action?: PolicyAction,
): Decision {
  if (subject.role === "owner") return { allow: true };
  if (policy.useDefaults && roleAtLeast(subject.role, env.defaultTier(permission))) return { allow: true };
  for (const g of policy.grants)
    if (grantApplies(g, subject, permission, scope, action, env, policy.groups)) return { allow: true };
  return {
    allow: false,
    by: env.by,
    reason: `${subject.principalId ?? subject.role} does not hold ${permission}`,
  };
}
