import { basename } from "node:path";
import {
  type Caller,
  type CancelledResult,
  type MessageDelivery,
  type Principal,
  type RequestContext,
  type ResourceScope,
  ServiceDeniedError,
  type Session,
  type Store,
} from "@valethq/sdk";
import { type PluginSettings, type PluginStatus, type ReloadResult, SettingsError } from "../kernel";
import { deleteSecret, isSecretName, listSecretFiles, secretSource, writeSecret } from "../secrets";
import type { SettingsPatch } from "../settings/overlay";
import { LastOwnerError, ProjectInUseError } from "../store/store";
import { FsError, listDirs, makeDir, normalizeDir } from "./fs";
import { matchSegments, splitPath } from "./router";

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function errorJson(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return json({ error: { code, message, ...extra } }, status);
}

export function deniedJson(
  denial: { by?: string; reason: string } | undefined,
  cancelReason?: string,
): Response {
  return json(
    {
      error: {
        code: "denied",
        ...(denial?.by === undefined ? {} : { by: denial.by }),
        reason: denial?.reason ?? cancelReason ?? "request denied",
      },
    },
    403,
  );
}

function isCancelled(value: unknown): value is CancelledResult {
  return typeof value === "object" && value !== null && (value as CancelledResult).cancelled === true;
}

/** Maps store failures: ServiceDeniedError -> 403 denied, CancelledResult -> 409, "unknown x" -> 404. */
async function guard(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ServiceDeniedError) {
      return deniedJson({ by: error.by, reason: error.reason || error.message });
    }
    if (error instanceof FsError) {
      return errorJson(
        error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400,
        error.code,
        error.message,
      );
    }
    if (error instanceof SettingsError)
      return errorJson(
        error.status,
        error.status === 404 ? "not_found" : error.status === 422 ? "refused" : "bad_request",
        error.message,
        error.errors === undefined ? {} : { errors: error.errors },
      );
    if (error instanceof LastOwnerError) return errorJson(409, "last_owner", error.message);
    if (error instanceof ProjectInUseError)
      return errorJson(409, "in_use", error.message, { sessions: error.sessions });
    const message = error instanceof Error ? error.message : String(error);
    if (/^unknown /.test(message)) return errorJson(404, "not_found", message);
    if (error instanceof SyntaxError) return errorJson(400, "bad_request", "invalid JSON body");
    throw error;
  }
}

const projectParam = (req: Request): string | undefined =>
  new URL(req.url).searchParams.get("project") ?? undefined;

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text === "") return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function result<T>(value: T | CancelledResult, status = 200): Response {
  if (isCancelled(value)) {
    return errorJson(409, "cancelled", value.cancelReason ?? "action cancelled");
  }
  return json(value, status);
}

const projectConflict = (taken: { id: string; name: string }, allowed: boolean): Response =>
  allowed
    ? errorJson(409, "conflict", `already registered as "${taken.name}"`, { projectId: taken.id })
    : errorJson(409, "conflict", "workspaceDir is already registered");

type RestHandler = (req: Request, ctx: RequestContext, store: Store) => Promise<Response>;

/** The permission a core route checks in `dispatch`; `collection` routes filter each item instead. */
export interface RestAcl {
  permission: string;
  resource?: (params: Record<string, string>, store: Store) => ResourceScope | undefined;
  collection?: boolean;
  /** The handler checks the permission itself once it knows the resource (for example POST /sessions). */
  manual?: boolean;
}

interface RestRoute {
  method: string;
  pattern: string[];
  acl: RestAcl;
  handler: RestHandler;
}

export const sessionScope = (id: string, projectId: string | undefined): ResourceScope => ({
  id: `session:${id}`,
  ...(projectId === undefined ? {} : { ancestors: [`project:${projectId}`] }),
});

const P = (permission: string, resource?: RestAcl["resource"]): RestAcl => ({
  permission,
  ...(resource === undefined ? {} : { resource }),
});
const C = (permission: string): RestAcl => ({ permission, collection: true });
const project: RestAcl["resource"] = (params) => ({ id: `project:${params.id}` });
const plugin: RestAcl["resource"] = (params) => ({ id: `plugin:${params.plugin}` });
const session: RestAcl["resource"] = (params, store) =>
  sessionScope(params.id as string, store.sessions.get(params.id as string)?.projectId);
const runSession = (store: Store, runId: string | undefined): ResourceScope | undefined => {
  const run = runId === undefined ? undefined : store.runs.get(runId);
  return run === undefined
    ? undefined
    : sessionScope(run.sessionId, store.sessions.get(run.sessionId)?.projectId);
};
const messageSession = (
  deps: RestDeps,
  store: Store,
  messageId: string | undefined,
): ResourceScope | undefined => {
  const sessionId = messageId === undefined ? undefined : deps.messageSession(messageId);
  return sessionId === undefined
    ? undefined
    : sessionScope(sessionId, store.sessions.get(sessionId)?.projectId);
};

type QueryNum = number | undefined | Response;

function parseLimit(v: string | null): QueryNum {
  if (v === null) return undefined;
  if (!/^[1-9]\d*$/.test(v)) return errorJson(400, "bad_request", "limit must be a positive integer");
  return Number(v);
}

function parseFiniteQuery(v: string | null, name: string): QueryNum {
  if (v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return errorJson(400, "bad_request", `${name} must be a finite number`);
  return n;
}

function parseDelivery(v: unknown): MessageDelivery | undefined | Response {
  if (v === undefined || v === "queue" || v === "interrupt") return v;
  return errorJson(400, "bad_request", 'delivery must be "queue" or "interrupt"');
}

export interface RestDeps {
  plugins(): PluginStatus[];
  reload(): Promise<ReloadResult>;
  settings(project?: string): PluginSettings[];
  updateSettings(plugin: string, patch: SettingsPatch): Promise<PluginSettings>;
  /** Tells plugins a secret was written or removed (the name only). */
  secretChanged(name: string): void;
  valetHome: string;
  /** Raw db handle for blob metadata (the Store API exposes only put/path). */
  blobMeta(id: string): { sha256: string; mime: string | null; name: string | null } | undefined;
  blobPath(id: string): string;
  /** The session a message belongs to (resource resolution for `/messages/:id/complete`). */
  messageSession(messageId: string): string | undefined;
  /** `can` for collection filtering. */
  can(caller: Caller, permission: string, resource?: ResourceScope): boolean;
}

export function restRoutes(deps: RestDeps): RestRoute[] {
  const r = (method: string, pattern: string, acl: RestAcl, handler: RestHandler): RestRoute => ({
    method,
    pattern: splitPath(pattern),
    acl,
    handler,
  });

  return [
    r("GET", "/projects", C("core:project.read"), async (_req, ctx, store) =>
      json(
        store.projects
          .list()
          .filter((p) => deps.can(ctx.caller, "core:project.read", { id: `project:${p.id}` })),
      ),
    ),
    r("POST", "/projects", P("core:project.write"), async (req, ctx, store) => {
      const b = await body(req);
      if (typeof b.workspaceDir !== "string" || (b.name !== undefined && typeof b.name !== "string")) {
        return errorJson(400, "bad_request", "workspaceDir is required; name must be a string");
      }
      const workspaceDir = await normalizeDir(b.workspaceDir);
      const taken = store.projects.list().find((p) => p.workspaceDir === workspaceDir);
      if (taken)
        return projectConflict(
          taken,
          deps.can(ctx.caller, "core:project.read", { id: `project:${taken.id}` }),
        );
      const name = (b.name as string | undefined)?.trim() || basename(workspaceDir);
      return result(
        await store.projects.create({
          name,
          workspaceDir,
          ...(b.settings === undefined ? {} : { settings: b.settings as Record<string, unknown> }),
        }),
        201,
      );
    }),
    r("GET", "/projects/:id", P("core:project.read", project), async (_req, ctx, store) => {
      const project = store.projects.get(ctx.params.id as string);
      return project ? json(project) : errorJson(404, "not_found", "unknown project");
    }),
    r("PATCH", "/projects/:id", P("core:project.write", project), async (req, ctx, store) => {
      if (!store.projects.get(ctx.params.id as string)) return errorJson(404, "not_found", "unknown project");
      const b = await body(req);
      const patch: { name?: string; workspaceDir?: string; settings?: Record<string, unknown> } = {};
      if (b.name !== undefined) patch.name = String(b.name);
      if (b.workspaceDir !== undefined) {
        const dir = await normalizeDir(String(b.workspaceDir));
        const taken = store.projects.list().find((p) => p.workspaceDir === dir && p.id !== ctx.params.id);
        if (taken)
          return projectConflict(
            taken,
            deps.can(ctx.caller, "core:project.read", { id: `project:${taken.id}` }),
          );
        patch.workspaceDir = dir;
      }
      if (b.settings !== undefined) patch.settings = b.settings as Record<string, unknown>;
      return result(await store.projects.update(ctx.params.id as string, patch));
    }),
    r("DELETE", "/projects/:id", P("core:project.write", project), async (_req, ctx, store) => {
      if (!store.projects.get(ctx.params.id as string)) return errorJson(404, "not_found", "unknown project");
      return result(await store.projects.delete(ctx.params.id as string));
    }),
    r("GET", "/fs/list", P("core:fs.read"), async (req) => {
      const q = new URL(req.url).searchParams;
      return json(await listDirs(q.get("path"), q.get("hidden") === "1"));
    }),
    r("POST", "/fs/mkdir", P("core:fs.write"), async (req) => {
      const b = await body(req);
      if (typeof b.parent !== "string" || typeof b.name !== "string") {
        return errorJson(400, "bad_request", "parent and name are required strings");
      }
      return json({ path: await makeDir(b.parent, b.name) }, 201);
    }),

    r("GET", "/sessions", C("core:session.read"), async (req, ctx, store) => {
      const q = new URL(req.url).searchParams;
      const limit = parseLimit(q.get("limit"));
      if (limit instanceof Response) return limit;
      const before = parseFiniteQuery(q.get("before"), "before");
      if (before instanceof Response) return before;
      // spec-gap: filtering after `limit` can return fewer rows than asked for.
      return json(
        store.sessions
          .list({
            ...(q.get("projectId") === null ? {} : { projectId: q.get("projectId") as string }),
            ...(q.get("status") === null ? {} : { status: q.get("status") as Session["status"] }),
            ...(limit === undefined ? {} : { limit }),
            ...(before === undefined ? {} : { before }),
          })
          .filter((sess) => deps.can(ctx.caller, "core:session.read", sessionScope(sess.id, sess.projectId))),
      );
    }),
    r("POST", "/sessions", { permission: "core:session.write", manual: true }, async (req, ctx, store) => {
      const b = await body(req);
      if (typeof b.projectId !== "string") return errorJson(400, "bad_request", "projectId is required");
      const allowed = deps.can(ctx.caller, "core:session.write", {
        id: "session:new",
        ancestors: [`project:${b.projectId}`],
      });
      if (!allowed) return deniedJson({ by: "core", reason: "core:session.write denied for this project" });
      if (!store.projects.get(b.projectId)) return errorJson(404, "not_found", "unknown project");
      if (b.parentSessionId !== undefined) {
        if (typeof b.parentSessionId !== "string")
          return errorJson(400, "bad_request", "parentSessionId must be a string");
        const parentId = b.parentSessionId;
        const parent = store.sessions.get(parentId);
        const parentAllowed = deps.can(
          ctx.caller,
          "core:session.read",
          parent ? sessionScope(parent.id, parent.projectId) : { id: `session:${parentId}` },
        );
        if (!parentAllowed)
          return deniedJson({ by: "core", reason: "core:session.read denied for parent session" });
        if (!parent) return errorJson(404, "not_found", "unknown parent session");
      }
      return result(
        await store.sessions.create({
          projectId: b.projectId,
          ...(b.title === undefined ? {} : { title: String(b.title) }),
          ...(b.settings === undefined ? {} : { settings: b.settings as Session["settings"] }),
          ...(b.parentSessionId === undefined ? {} : { parentSessionId: String(b.parentSessionId) }),
        }),
        201,
      );
    }),
    r("GET", "/sessions/:id", P("core:session.read", session), async (_req, ctx, store) => {
      const session = store.sessions.get(ctx.params.id as string);
      return session ? json(session) : errorJson(404, "not_found", "unknown session");
    }),
    r("PATCH", "/sessions/:id", P("core:session.write", session), async (req, ctx, store) => {
      if (!store.sessions.get(ctx.params.id as string)) return errorJson(404, "not_found", "unknown session");
      const b = await body(req);
      const patch: Partial<Pick<Session, "title" | "color" | "status" | "settings">> = {};
      if (b.title !== undefined) patch.title = b.title === null ? null : String(b.title);
      if (b.color !== undefined) patch.color = b.color === null ? null : String(b.color);
      if (b.status !== undefined) patch.status = b.status as Session["status"];
      if (b.settings !== undefined) patch.settings = b.settings as Session["settings"];
      return result(await store.sessions.update(ctx.params.id as string, patch));
    }),
    r("DELETE", "/sessions/:id", P("core:session.write", session), async (_req, ctx, store) => {
      if (!store.sessions.get(ctx.params.id as string)) return errorJson(404, "not_found", "unknown session");
      return result(await store.sessions.delete(ctx.params.id as string));
    }),
    r("GET", "/sessions/:id/messages", P("core:session.read", session), async (req, ctx, store) => {
      if (!store.sessions.get(ctx.params.id as string)) return errorJson(404, "not_found", "unknown session");
      const q = new URL(req.url).searchParams;
      const beforeSeq = parseFiniteQuery(q.get("beforeSeq"), "beforeSeq");
      if (beforeSeq instanceof Response) return beforeSeq;
      const limit = parseLimit(q.get("limit"));
      if (limit instanceof Response) return limit;
      return json(
        store.messages.list(ctx.params.id as string, {
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          ...(limit === undefined ? {} : { limit }),
        }),
      );
    }),
    r("POST", "/sessions/:id/messages", P("core:message.write", session), async (req, ctx, store) => {
      const sessionRow = store.sessions.get(ctx.params.id as string);
      if (!sessionRow) return errorJson(404, "not_found", "unknown session");
      const b = await body(req);
      if (typeof b.role !== "string" || !Array.isArray(b.parts)) {
        return errorJson(400, "bad_request", "role and parts are required");
      }
      const clientId = b.clientMessageId;
      if (clientId !== undefined && (typeof clientId !== "string" || clientId.length > 100)) {
        return errorJson(400, "bad_request", "clientMessageId must be a string of at most 100 chars");
      }
      const delivery = parseDelivery(b.delivery);
      if (delivery instanceof Response) return delivery;
      if (clientId !== undefined) {
        const recent = store.messages.list(ctx.params.id as string, { limit: 50 });
        const dup = recent.find((m) => m.message.meta.clientMessageId === clientId);
        if (dup) {
          const readable = deps.can(
            ctx.caller,
            "core:session.read",
            sessionScope(ctx.params.id as string, sessionRow.projectId),
          );
          if (!readable)
            return deniedJson({
              by: "core",
              reason: "reading an existing message requires core:session.read",
            });
          return json(dup);
        }
      }
      return result(
        await store.messages.create({
          sessionId: ctx.params.id as string,
          ...(clientId === undefined ? {} : { meta: { clientMessageId: clientId } }),
          ...(delivery === undefined ? {} : { delivery }),
          role: b.role as "user" | "assistant" | "system" | "tool",
          parts: b.parts as Parameters<Store["messages"]["create"]>[0]["parts"],
          ...(ctx.caller.actor === undefined ? {} : { authorPrincipalId: ctx.caller.actor.principalId }),
          ...(b.runId === undefined ? {} : { runId: String(b.runId) }),
          ...(b.status === undefined
            ? {}
            : { status: b.status as "streaming" | "complete" | "error" | "interrupted" }),
        }),
        201,
      );
    }),
    r(
      "POST",
      "/messages/:id/complete",
      P("core:message.write", (params, store) => messageSession(deps, store, params.id)),
      async (req, ctx, store) => {
        const b = await body(req);
        const status = (b.status ?? "complete") as "complete" | "error" | "interrupted";
        if (!["complete", "error", "interrupted"].includes(status)) {
          return errorJson(400, "bad_request", "status must be complete, error or interrupted");
        }
        await store.messages.complete(ctx.params.id as string, status);
        return json({ ok: true });
      },
    ),

    r(
      "GET",
      "/runs/:id",
      P("core:run.read", (params, store) => runSession(store, params.id)),
      async (_req, ctx, store) => {
        const run = store.runs.get(ctx.params.id as string);
        return run ? json(run) : errorJson(404, "not_found", "unknown run");
      },
    ),
    r(
      "POST",
      "/runs/:id/cancel",
      P("core:run.cancel", (params, store) => runSession(store, params.id)),
      async (_req, ctx, store) => {
        await store.runs.cancel(ctx.params.id as string, ctx.caller.actor?.principalId ?? "core");
        return json({ ok: true });
      },
    ),

    r("GET", "/principals/:id", P("core:principal.read"), async (_req, ctx, store) => {
      const principal = store.principals.get(ctx.params.id as string);
      return principal ? json(principal) : errorJson(404, "not_found", "unknown principal");
    }),
    r("POST", "/principals/:id/link", P("core:principal.admin"), async (req, ctx, store) => {
      const b = await body(req);
      if (typeof b.platform !== "string" || typeof b.externalId !== "string") {
        return errorJson(400, "bad_request", "platform and externalId are required strings");
      }
      await store.principals.link(
        ctx.params.id as string,
        b.platform,
        b.externalId,
        typeof b.code === "string" ? { code: b.code } : undefined,
      );
      return json({ ok: true });
    }),
    r("POST", "/principals/:id/role", P("core:principal.admin"), async (req, ctx, store) => {
      const b = await body(req);
      if (!["owner", "trusted", "guest"].includes(b.role as string)) {
        return errorJson(400, "bad_request", "role must be owner, trusted or guest");
      }
      await store.principals.setRole(ctx.params.id as string, b.role as Principal["role"]);
      return json({ ok: true });
    }),

    r("POST", "/principals/:id/link-challenge", P("core:principal.link"), async (_req, ctx, store) => {
      const self = ctx.caller.actor?.principalId;
      if (self === undefined || (ctx.params.id !== "me" && ctx.params.id !== self))
        return deniedJson({ by: "core", reason: "a link challenge is only minted for your own principal" });
      return json({ code: store.principals.linkChallenge(self), expiresInSec: 600 }, 201);
    }),

    r("GET", "/plugins", P("core:plugin.read"), async () => json(deps.plugins())),
    r("GET", "/part-types", P("core:plugin.read"), async (_req, _ctx, store) => json(store.partTypes.list())),
    r("POST", "/config/reload", P("core:config.reload"), async () => {
      const result = await deps.reload();
      return json(result, result.ok ? 200 : 400);
    }),

    r("GET", "/settings", C("core:settings.read"), async (req, ctx) =>
      json(
        deps
          .settings(projectParam(req))
          .filter((p) => deps.can(ctx.caller, "core:settings.read", { id: `plugin:${p.plugin}` })),
      ),
    ),
    r("GET", "/settings/:plugin", P("core:settings.read", plugin), async (req, ctx) => {
      const found = deps.settings(projectParam(req)).find((p) => p.plugin === ctx.params.plugin);
      return found ? json(found) : errorJson(404, "not_found", "unknown plugin");
    }),
    r("PATCH", "/settings/:plugin", P("core:settings.write", plugin), async (req, ctx) => {
      const b = await body(req);
      const config = b.config;
      if (config !== undefined && (typeof config !== "object" || config === null || Array.isArray(config)))
        return errorJson(400, "bad_request", "config must be an object");
      if (b.enabled !== undefined && typeof b.enabled !== "boolean")
        return errorJson(400, "bad_request", "enabled must be a boolean");
      if (b.scope !== undefined && b.scope !== "user" && b.scope !== "project")
        return errorJson(400, "bad_request", 'scope must be "user" or "project"');
      if (b.project !== undefined && typeof b.project !== "string")
        return errorJson(400, "bad_request", "project must be a string");
      const patch: SettingsPatch = {
        ...(b.scope === undefined ? {} : { scope: b.scope as "user" | "project" }),
        ...(b.project === undefined ? {} : { project: b.project as string }),
        ...(config === undefined ? {} : { config: config as Record<string, unknown> }),
        ...(b.enabled === undefined ? {} : { enabled: b.enabled as boolean }),
      };
      return json(await deps.updateSettings(ctx.params.plugin as string, patch));
    }),

    r("GET", "/secrets", P("core:secret.read"), async () =>
      json(listSecretFiles(deps.valetHome).map((name) => ({ name, source: "file" }))),
    ),
    r("GET", "/secrets/:name", P("core:secret.read"), async (_req, ctx) => {
      const name = ctx.params.name as string;
      if (!isSecretName(name)) return errorJson(400, "bad_request", "invalid secret name");
      return json({ name, source: secretSource(deps.valetHome, name) });
    }),
    r("PUT", "/secrets/:name", P("core:secret.write"), async (req, ctx) => {
      const name = ctx.params.name as string;
      const b = await body(req);
      if (!isSecretName(name)) return errorJson(400, "bad_request", "invalid secret name");
      if (typeof b.value !== "string" || b.value.trim() === "")
        return errorJson(400, "bad_request", "value must be a non-empty string");
      writeSecret(deps.valetHome, name, b.value.trim());
      deps.secretChanged(name);
      return json({ name, source: "file" });
    }),
    r("DELETE", "/secrets/:name", P("core:secret.write"), async (_req, ctx) => {
      const name = ctx.params.name as string;
      if (!isSecretName(name)) return errorJson(400, "bad_request", "invalid secret name");
      if (deleteSecret(deps.valetHome, name)) deps.secretChanged(name);
      return json({ name, source: secretSource(deps.valetHome, name) });
    }),

    r("GET", "/blobs/:id", P("core:blob.read"), async (_req, ctx) => {
      const meta = deps.blobMeta(ctx.params.id as string);
      if (!meta) return errorJson(404, "not_found", "unknown blob");
      const path = deps.blobPath(ctx.params.id as string);
      const mime = meta.mime ?? "application/octet-stream";
      const html = mime.split(";")[0]?.trim().toLowerCase() === "text/html";
      return new Response(Bun.file(path), {
        headers: {
          "content-type": html ? "application/octet-stream" : mime,
          ...(html ? { "content-disposition": "attachment" } : {}),
        },
      });
    }),
    r("POST", "/blobs", P("core:blob.write"), async (req, _ctx, store) => {
      const b = await body(req);
      if (typeof b.data !== "string") return errorJson(400, "bad_request", "data (base64) is required");
      const bytes = Buffer.from(b.data, "base64");
      return json(
        await store.blobs.put(bytes, {
          ...(b.mime === undefined ? {} : { mime: String(b.mime) }),
          ...(b.name === undefined ? {} : { name: String(b.name) }),
        }),
        201,
      );
    }),
  ];
}

export function matchRest(
  deps: RestDeps,
  method: string,
  path: string,
): { handler: RestHandler; acl: RestAcl; params: Record<string, string> } | undefined {
  const segments = splitPath(path).slice(2); // strip "api", "core"
  for (const route of restRoutes(deps)) {
    if (route.method !== method) continue;
    const params = matchSegments(route.pattern, segments);
    if (params) return { handler: route.handler, acl: route.acl, params };
  }
  return undefined;
}

/** Wraps a matched core REST handler: builds the caller-scoped store and maps failures. */
export function runRest(
  match: { handler: RestHandler; params: Record<string, string> },
  store: { forCaller(caller: Caller): Store },
  req: Request,
  ctx: RequestContext,
): Promise<Response> {
  const boundCtx: RequestContext = { ...ctx, params: match.params };
  return guard(() => match.handler(req, boundCtx, store.forCaller(ctx.caller)));
}
