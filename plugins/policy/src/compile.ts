import type { Grant, PolicyFile } from "./types";

export interface CompiledPolicy {
  useDefaults: boolean;
  groups: Readonly<Record<string, readonly string[]>>;
  grants: readonly Grant[];
}

export function compile(file: PolicyFile): CompiledPolicy {
  const tagGrants = Object.entries(file.tags).map(
    ([tag, { owners }]): Grant => ({ to: owners, allow: ["policy:tag.assign"], on: [tag] }),
  );
  return { useDefaults: file.useDefaults, groups: file.groups, grants: [...file.grants, ...tagGrants] };
}

export interface Known {
  permissions: readonly string[];
  hasPrincipal(id: string): boolean;
}

const knownPermission = (pattern: string, names: readonly string[]): boolean =>
  pattern === "*" ||
  (pattern.endsWith(":*") ? names.some((n) => n.startsWith(pattern.slice(0, -1))) : names.includes(pattern));

export function warnings(file: PolicyFile, known: Known): string[] {
  const out: string[] = [];
  const permissions = (patterns: readonly string[] | undefined, where: string) => {
    for (const p of patterns ?? [])
      if (!knownPermission(p, known.permissions)) out.push(`${where}: unknown permission "${p}"`);
  };
  const selectors = (list: readonly string[], where: string) => {
    for (const s of list) {
      if (s.startsWith("group:") && file.groups[s] === undefined) out.push(`${where}: unknown group "${s}"`);
      if (s.startsWith("principal:") && !known.hasPrincipal(s.slice(10)))
        out.push(`${where}: unknown principal "${s}"`);
    }
  };
  for (const [name, members] of Object.entries(file.groups)) selectors(members, name);
  for (const [name, { owners }] of Object.entries(file.tags)) selectors(owners, name);
  file.grants.forEach((g, i) => {
    selectors(g.to, `grants[${i}]`);
    permissions(g.allow, `grants[${i}]`);
  });
  file.tests.forEach((t, i) => {
    selectors([t.subject], `tests[${i}]`);
    permissions(t.allow, `tests[${i}]`);
    permissions(t.deny, `tests[${i}]`);
  });
  return out;
}
