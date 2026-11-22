import { type Audience, matchPermission, type Role } from "@valethq/sdk";
import type { CheckEnv } from "./check";
import { evaluate } from "./check";
import type { CompiledPolicy } from "./compile";
import type { Subject } from "./selectors";
import type { PolicyTest } from "./types";

export interface TestStore {
  role(principalId: string): Role | undefined;
}

function subjectOf(test: PolicyTest, store: TestStore): Subject {
  const i = test.subject.indexOf(":");
  const kind = test.subject.slice(0, i);
  const name = test.subject.slice(i + 1);
  const tags = test.tags ?? [];
  const base = (role: Role): Subject => ({ role, ...(tags.length === 0 ? {} : { tags }) });
  switch (kind) {
    case "principal":
      return { ...base(store.role(name) ?? "guest"), principalId: name };
    case "autogroup":
      return base(name === "anyone" ? "guest" : (name as Role));
    case "tag":
      return { role: "guest", tags: [test.subject, ...tags] };
    default:
      // spec-gap: the store has no read-only identity lookup, so an identity is tested as a guest holding it.
      return { ...base("guest"), identities: [{ platform: kind, externalId: name }] };
  }
}

function holds(
  policy: CompiledPolicy,
  env: CheckEnv,
  store: TestStore,
  test: PolicyTest,
  permission: string,
): boolean {
  if (test.cap !== undefined && !test.cap.some((p) => matchPermission(p, permission))) return false;
  const scope = test.resource === undefined ? undefined : { id: test.resource };
  const subject = subjectOf(test, store);
  const ask = (s: Subject) => evaluate(policy, env, s, permission, scope).allow;
  const audience: Audience = test.audience ?? {};
  return (
    ask(subject) &&
    (audience.principals ?? [])
      .filter((id) => id !== subject.principalId)
      .every((id) => ask({ principalId: id, role: store.role(id) ?? "guest" })) &&
    (audience.tier === undefined || ask({ role: audience.tier }))
  );
}

export function runTests(
  policy: CompiledPolicy,
  env: CheckEnv,
  store: TestStore,
  tests: readonly PolicyTest[],
): string[] {
  const failures: string[] = [];
  tests.forEach((t, i) => {
    for (const p of t.allow ?? [])
      if (!holds(policy, env, store, t, p)) failures.push(`tests[${i}] (${t.subject}) expected allow ${p}`);
    for (const p of t.deny ?? [])
      if (holds(policy, env, store, t, p)) failures.push(`tests[${i}] (${t.subject}) expected deny ${p}`);
  });
  return failures;
}
