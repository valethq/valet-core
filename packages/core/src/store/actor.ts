import type { Database } from "bun:sqlite";
import { type ActorRef, type Caller, type Role, type RunSubject, lowestRole } from "@valethq/sdk";

export function roleOf(db: Database, principalId: string): Role | undefined {
  const row = db.query<{ role: string }, string>("SELECT role FROM principals WHERE id = ?").get(principalId);
  return row?.role as Role | undefined;
}

export function subjectOf(db: Database, runId: string): { found: boolean; subject: RunSubject | null } {
  const row = db
    .query<{ subject: string | null }, string>("SELECT subject FROM runs WHERE id = ?")
    .get(runId);
  if (row === null) return { found: false, subject: null };
  return { found: true, subject: row.subject === null ? null : (JSON.parse(row.subject) as RunSubject) };
}

/** The stored role of a run with a subject: the lowest of the principal, every enumerated reader and the tier. */
export function subjectRole(db: Database, subject: RunSubject): Role {
  const roles: Role[] = [
    subject.principalId === null ? "guest" : (roleOf(db, subject.principalId) ?? "guest"),
  ];
  for (const p of subject.audience?.principals ?? []) roles.push(roleOf(db, p) ?? "guest");
  if (subject.audience?.tier !== undefined) roles.push(subject.audience.tier);
  return lowestRole(roles);
}

/**
 * `store.as()` and `emit(…, { as })`: stamps the principal and, with `runId`, the run's subject on `caller.actor`.
 * Rejects an unknown principal or run, and a run whose subject names another principal.
 */
export function stampActor(db: Database, caller: Caller, ref: ActorRef): Caller {
  const role = roleOf(db, ref.principalId);
  // spec-gap: claiming a principal that does not exist is a bug; fail loudly.
  if (role === undefined) throw new Error(`store.as: unknown principal "${ref.principalId}"`);
  const base = { ...caller, actor: { principalId: ref.principalId, role } };
  if (ref.runId === undefined) return base;
  const { found, subject } = subjectOf(db, ref.runId);
  if (!found) throw new Error(`store.as: unknown run "${ref.runId}"`);
  if (subject === null) return { ...base, actor: { ...base.actor, runId: ref.runId } };
  if (subject.principalId !== ref.principalId)
    throw new Error(`store.as: run "${ref.runId}" belongs to another principal`);
  return subjectCaller(caller, role, ref.runId, subject);
}

export function subjectCaller(caller: Caller, role: Role, runId: string, subject: RunSubject): Caller {
  const { credentialId: _c, verifiedLogin: _v, authenticatedBy: _a, ...rest } = caller;
  return {
    ...rest,
    ...(subject.credentialId === undefined ? {} : { credentialId: subject.credentialId }),
    actor: {
      principalId: subject.principalId as string,
      role,
      runId,
      ...(subject.tags === undefined ? {} : { tags: subject.tags }),
      ...(subject.cap === undefined ? {} : { cap: subject.cap }),
      ...(subject.audience === undefined ? {} : { audience: subject.audience }),
    },
  };
}
