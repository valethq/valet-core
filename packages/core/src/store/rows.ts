import type { Message, Part, Principal, Project, Run, Session } from "@valethq/sdk";

type Row = Record<string, unknown>;

const json = (value: unknown): Record<string, unknown> =>
  typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>) : {};

export function rowToProject(r: Row): Project {
  return {
    id: r.id as string,
    name: r.name as string,
    workspaceDir: r.workspace_dir as string,
    settings: json(r.settings),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function rowToSession(r: Row): Session {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    title: (r.title as string | null) ?? null,
    color: (r.color as string | null) ?? null,
    parentSessionId: (r.parent_session_id as string | null) ?? null,
    status: r.status as Session["status"],
    settings: json(r.settings) as Session["settings"],
    providerState: json(r.provider_state),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    lastMessageAt: (r.last_message_at as number | null) ?? null,
  };
}

export function rowToRun(r: Row): Run {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    triggerMessageId: (r.trigger_message_id as string | null) ?? null,
    status: r.status as Run["status"],
    role: r.role as Run["role"],
    provider: (r.provider as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    startedAt: (r.started_at as number | null) ?? null,
    endedAt: (r.ended_at as number | null) ?? null,
    error: (r.error as string | null) ?? null,
    usage: json(r.usage) as Record<string, number>,
  };
}

export function rowToMessage(r: Row): Message {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    seq: r.seq as number,
    role: r.role as Message["role"],
    authorPrincipalId: (r.author_principal_id as string | null) ?? null,
    runId: (r.run_id as string | null) ?? null,
    status: r.status as Message["status"],
    origin: r.origin === null ? null : (JSON.parse(r.origin as string) as Message["origin"]),
    meta: json(r.meta),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function rowToPart(r: Row): Part {
  return {
    id: r.id as string,
    messageId: r.message_id as string,
    idx: r.idx as number,
    status: r.status as Part["status"],
    type: r.type as Part["type"],
    data: JSON.parse(r.data as string) as Part["data"],
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function rowToPrincipal(r: Row): Principal {
  return {
    id: r.id as string,
    displayName: r.display_name as string,
    role: r.role as Principal["role"],
  };
}
