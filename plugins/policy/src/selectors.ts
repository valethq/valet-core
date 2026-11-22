import { type Role, roleAtLeast } from "@valethq/sdk";
import type { PolicySubject } from "@valethq/sdk";

export type Identity = { platform: string; externalId: string };
export type Subject = PolicySubject & { identities?: readonly Identity[] };

export interface SelectorEnv {
  groups: Readonly<Record<string, readonly string[]>>;
  identities(principalId: string): Identity[];
}

const AUTOGROUPS = ["owner", "trusted", "guest", "anyone"];

const split = (selector: string): [string, string] => {
  const i = selector.indexOf(":");
  return [selector.slice(0, i), selector.slice(i + 1)];
};

export function selectorError(selector: string, opts: { group?: boolean } = {}): string | undefined {
  const i = selector.indexOf(":");
  if (i <= 0 || i === selector.length - 1) return `invalid selector "${selector}"`;
  const [kind, name] = split(selector);
  if (kind === "autogroup" && !AUTOGROUPS.includes(name)) return `unknown autogroup "${selector}"`;
  if (kind === "group" && opts.group === false) return `"${selector}" is not allowed here`;
  return undefined;
}

export const normalizeTag = (tag: string): string => (tag.startsWith("tag:") ? tag : `tag:${tag}`);

function matchesOne(selector: string, subject: Subject, env: SelectorEnv): boolean {
  const [kind, name] = split(selector);
  switch (kind) {
    case "principal":
      return subject.principalId === name;
    case "tag": {
      const tag = normalizeTag(selector);
      return subject.tags?.some((t) => normalizeTag(t) === tag) ?? false;
    }
    case "autogroup":
      return name === "anyone" || name === "guest" || roleAtLeast(subject.role, name as Role);
    case "group":
      return false;
    default: {
      const identities =
        subject.identities ?? (subject.principalId === undefined ? [] : env.identities(subject.principalId));
      return identities.some((i) => i.platform === kind && i.externalId === name);
    }
  }
}

export function matches(selector: string, subject: Subject, env: SelectorEnv): boolean {
  if (!selector.startsWith("group:")) return matchesOne(selector, subject, env);
  return (env.groups[selector] ?? []).some((member) => matchesOne(member, subject, env));
}
