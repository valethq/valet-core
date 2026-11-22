import { type AclContext, type Decision, can, roleAtLeast } from "./acl";
import type { Caller } from "./events";

export type Role = "owner" | "trusted" | "guest";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolDefinition<Input = unknown> extends ToolSpec {
  /** Lowest role this tool serves (the run's effective role, section 8.3). The providing plugin enforces it: the SDK's `defineTool` applies it in `list` and again in `invoke`. Core and valet-agent do not. Default "owner". */
  minRole?: Role;
  /** Declared permission checked against the caller with `can`, in `list` and again in `invoke`. `minRole` stays a stricter tier floor. */
  permission?: string;
  timeoutMs?: number;
  invoke(input: Input, call: ToolCall): Promise<ToolResult>;
}

export interface ToolCall {
  sessionId: string;
  runId: string;
  callId: string;
  role: Role;
  /** Stamped by core: the plugin making the call and the principal behind the run. */
  caller: Caller;
  cwd: string;
  signal: AbortSignal;
  /** Streams partial output to the tool-call part and to WS subscribers. */
  progress(update: { outputDelta?: string; status?: string }): void;
}

export interface ToolResult {
  content: ({ type: "text"; text: string } | { type: "image"; mime: string; blobId: string })[];
  isError?: boolean;
  meta?: Record<string, unknown>;
}

export interface ToolProvider {
  /** Re-read on each run, so tools can depend on session or project. */
  list(scope: {
    sessionId: string;
    projectId: string;
    role: Role;
    /** The run's caller, so listing can be per subject. */
    caller?: Caller;
  }): ToolDefinition[] | Promise<ToolDefinition[]>;
}

/** The resource a tool call in this session carries: the session, with its project as the trusted ancestor. */
export function sessionResource(ctx: Pick<AclContext, "store">, sessionId: string) {
  const projectId = ctx.store.sessions.get(sessionId)?.projectId;
  return {
    id: `session:${sessionId}`,
    ...(projectId === undefined ? {} : { ancestors: [`project:${projectId}`] }),
  };
}

/** Whether `def` serves this subject: `minRole` against the run's role, then `permission` against the caller. */
export function toolAllowed(
  ctx: AclContext,
  def: Pick<ToolDefinition, "minRole" | "permission">,
  who: { role: Role; caller?: Caller; sessionId?: string },
): Decision {
  if (!roleAtLeast(who.role, def.minRole ?? (def.permission === undefined ? "owner" : "guest")))
    return { allow: false, by: ctx.plugin.id, reason: `not available to the ${who.role} role` };
  if (def.permission === undefined) return { allow: true };
  return can(
    ctx,
    who.caller ?? { plugin: ctx.plugin.id },
    def.permission,
    who.sessionId ? sessionResource(ctx, who.sessionId) : undefined,
  );
}

/** The tools of `defs` that `scope`'s subject may list. */
export function allowedTools<T extends ToolDefinition<never>>(
  ctx: AclContext,
  scope: { sessionId: string; role: Role; caller?: Caller },
  defs: readonly T[],
): T[] {
  return defs.filter((def) => toolAllowed(ctx, def, scope).allow);
}

/**
 * spec-gap: the doc gives `defineTool(def)` with no context; with `ctx` the returned tool re-checks `minRole` and
 * `permission` in `invoke`, and `allowedTools` applies them in `list`.
 */
export function defineTool<Input>(def: ToolDefinition<Input>, ctx?: AclContext): ToolDefinition<Input> {
  if (ctx === undefined) return def;
  return {
    ...def,
    invoke(input, call) {
      const d = toolAllowed(ctx, def, call);
      if (!d.allow)
        return Promise.resolve({
          content: [{ type: "text", text: `${def.name} denied: ${d.reason}` }],
          isError: true,
        });
      return def.invoke(input, call);
    },
  };
}
