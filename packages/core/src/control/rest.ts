import { basename } from "node:path";
import {
  type Caller,
  type CancelledResult,
  type Principal,
  type RequestContext,
  ServiceDeniedError,
  type Session,
  type Store,
} from "@valethq/sdk";
import { type PluginSettings, type PluginStatus, type ReloadResult, SettingsError } from "../kernel";
import { deleteSecret, isSecretName, listSecretFiles, secretSource, writeSecret } from "../secrets";
import type { SettingsPatch } from "../settings";
import { ProjectInUseError } from "../store/store";
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
      return errorJson(error.status, error.status === 404 ? "not_found" : "bad_request", error.message);
    if (error instanceof ProjectInUseError)
      return errorJson(409, "in_use", error.message, { sessions: error.sessions });
    const message = error instanceof Error ? error.message : String(error);
    if (/^unknown /.test(message)) return errorJson(404, "not_found", message);
    if (error instanceof SyntaxError) return errorJson(400, "bad_request", "invalid JSON body");
    throw error;
  }
}

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

type RestHandler = (req: Request, ctx: RequestContext, store: Store) => Promise<Response>;

interface RestRoute {
  method: string;
  pattern: string[];
  handler: RestHandler;
}

const num = (v: string | null): number | undefined => (v === null ? undefined : Number(v));

export interface RestDeps {
  plugins(): PluginStatus[];
  reload(): Promise<ReloadResult>;
  settings(): PluginSettings[];
  updateSettings(plugin: string, patch: SettingsPatch): Promise<PluginSettings>;
  /** Tells plugins a secret was written or removed (the name only). */
  secretChanged(name: string): void;
  valetHome: string;
  /** Raw db handle for blob metadata (the Store API exposes only put/path). */
  blobMeta(id: string): { sha256: string; mime: string | null; name: string | null } | undefined;
  blobPath(id: string): string;
}

export function restRoutes(deps: RestDeps): RestRoute[] {
  const r = (method: string, pattern: string, handler: RestHandler): RestRoute => ({
    method,
    pattern: splitPath(pattern),
    handler,
  });

  return [
    r("GET", "/projects", async (_req, _ctx, store) => json(store.projects.list())),
    r("POST", "/projects", async (req, _ctx, store) => {
      const b = await body(req);
      if (typeof b.workspaceDir !== "string" || (b.name !== undefined && typeof b.name !== "string")) {
        return errorJson(400, "bad_request", "workspaceDir is required; name must be a string");
      }
      const workspaceDir = await normalizeDir(b.workspaceDir);
      const taken = store.projects.list().find((p) => p.workspaceDir === workspaceDir);
      if (taken)
        return errorJson(409, "conflict", `already registered as "${taken.name}"`, { projectId: taken.id });
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
    r("GET", "/projects/:id", async (_req, ctx, store) => {
      const project = store.projects.get(ctx.params.id as string);
      return project ? json(project) : errorJson(404, "not_found", "unknown project");
    }),
    r("PATCH", "/projects/:id", async (req, ctx, store) => {
      if (!store.projects.get(ctx.params.id as string)) return errorJson(404, "not_found", "unknown project");
      const b = await body(req);
      const patch: { name?: string; workspaceDir?: string; settings?: Record<string, unknown> } = {};
      if (b.name !== undefined) patch.name = String(b.name);
      if (b.workspaceDir !== undefined) {
        const dir = await normalizeDir(String(b.workspaceDir));
        const taken = store.projects.list().find((p) => p.workspaceDir === dir && p.id !== ctx.params.id);
        if (taken)
          return errorJson(409, "conflict", `already registered as "${taken.name}"`, { projectId: taken.id });
        patch.workspaceDir = dir;
      }
      if (b.settings !== undefined) patch.settings = b.settings as Record<string, unknown>;
      return result(await store.projects.update(ctx.params.id as string, patch));
    }),
    r("DELETE", "/projects/:id", async (_req, ctx, store) => {
      if (!store.projects.get(ctx.params.id as string)) return errorJson(404, "not_found", "unknown project");
      return result(await store.projects.delete(ctx.params.id as string));
    }),
    r("GET", "/fs/list", async (req) => {
      const q = new URL(req.url).searchParams;
      return json(await listDirs(q.get("path"), q.get("hidden") === "1"));
    }),
    r("POST", "/fs/mkdir", async (req) => {
      const b = await body(req);
      if (typeof b.parent !== "string" || typeof b.name !== "string") {
        return errorJson(400, "bad_request", "parent and name are required strings");
      }
      return json({ path: await makeDir(b.parent, b.name) }, 201);
    }),

    r("GET", "/sessions", async (req, _ctx, store) => {
      const q = new URL(req.url).searchParams;
      return json(
        store.sessions.list({
          ...(q.get("projectId") === null ? {} : { projectId: q.get("projectId") as string }),
          ...(q.get("status") === null ? {} : { status: q.get("status") as Session["status"] }),
          ...(num(q.get("limit")) === undefined ? {} : { limit: num(q.get("limit")) }),
          ...(num(q.get("before")) === undefined ? {} : { before: num(q.get("before")) }),
        }),
      );
    }),
    r("POST", "/sessions", async (req, _ctx, store) => {
      const b = await body(req);
      if (typeof b.projectId !== "string") return errorJson(400, "bad_request", "projectId is required");
      if (!store.projects.get(b.projectId)) return errorJson(404, "not_found", "unknown project");
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
    r("GET", "/sessions/:id", async (_req, ctx, store) => {
      const session = store.sessions.get(ctx.params.id as string);
      return session ? json(session) : errorJson(404, "not_found", "unknown session");
    }),
    r("PATCH", "/sessions/:id", async (req, ctx, store) => {
      if (!store.sessions.get(ctx.params.id as string)) return errorJson(404, "not_found", "unknown session");
      const b = await body(req);
      const patch: Partial<Pick<Session, "title" | "color" | "status" | "settings">> = {};
      if (b.title !== undefined) patch.title = b.title === null ? null : String(b.title);
      if (b.color !== undefined) patch.color = b.color === null ? null : String(b.color);
      if (b.status !== undefined) patch.status = b.status as Session["status"];
      if (b.settings !== undefined) patch.settings = b.settings as Session["settings"];
      return result(await store.sessions.update(ctx.params.id as string, patch));
    }),
    r("DELETE", "/sessions/:id", async (_req, ctx, store) => {
      if (!store.sessions.get(ctx.params.id as string)) return errorJson(404, "not_found", "unknown session");
      return result(await store.sessions.delete(ctx.params.id as string));
    }),
    r("GET", "/sessions/:id/messages", async (req, ctx, store) => {
      if (!store.sessions.get(ctx.params.id as string)) return errorJson(404, "not_found", "unknown session");
      const q = new URL(req.url).searchParams;
      return json(
        store.messages.list(ctx.params.id as string, {
          ...(num(q.get("beforeSeq")) === undefined ? {} : { beforeSeq: num(q.get("beforeSeq")) }),
          ...(num(q.get("limit")) === undefined ? {} : { limit: num(q.get("limit")) }),
        }),
      );
    }),
    r("POST", "/sessions/:id/messages", async (req, ctx, store) => {
      if (!store.sessions.get(ctx.params.id as string)) return errorJson(404, "not_found", "unknown session");
      const b = await body(req);
      if (typeof b.role !== "string" || !Array.isArray(b.parts)) {
        return errorJson(400, "bad_request", "role and parts are required");
      }
      const clientId = b.clientMessageId;
      if (clientId !== undefined && (typeof clientId !== "string" || clientId.length > 100)) {
        return errorJson(400, "bad_request", "clientMessageId must be a string of at most 100 chars");
      }
      if (clientId !== undefined) {
        const recent = store.messages.list(ctx.params.id as string, { limit: 50 });
        const dup = recent.find((m) => m.message.meta.clientMessageId === clientId);
        if (dup) return json(dup);
      }
      return result(
        await store.messages.create({
          sessionId: ctx.params.id as string,
          ...(clientId === undefined ? {} : { meta: { clientMessageId: clientId } }),
          role: b.role as "user" | "assistant" | "system" | "tool",
          parts: b.parts as Parameters<Store["messages"]["create"]>[0]["parts"],
          ...(b.authorPrincipalId === undefined && ctx.caller.actor === undefined
            ? {}
            : { authorPrincipalId: (b.authorPrincipalId ?? ctx.caller.actor?.principalId) as string }),
          ...(b.runId === undefined ? {} : { runId: String(b.runId) }),
          ...(b.status === undefined
            ? {}
            : { status: b.status as "streaming" | "complete" | "error" | "interrupted" }),
        }),
        201,
      );
    }),
    r("POST", "/messages/:id/complete", async (req, ctx, store) => {
      const b = await body(req);
      const status = (b.status ?? "complete") as "complete" | "error" | "interrupted";
      if (!["complete", "error", "interrupted"].includes(status)) {
        return errorJson(400, "bad_request", "status must be complete, error or interrupted");
      }
      await store.messages.complete(ctx.params.id as string, status);
      return json({ ok: true });
    }),

    r("GET", "/runs/:id", async (_req, ctx, store) => {
      const run = store.runs.get(ctx.params.id as string);
      return run ? json(run) : errorJson(404, "not_found", "unknown run");
    }),
    r("POST", "/runs/:id/cancel", async (_req, ctx, store) => {
      await store.runs.cancel(ctx.params.id as string, ctx.caller.actor?.principalId ?? "core");
      return json({ ok: true });
    }),

    r("GET", "/principals/:id", async (_req, ctx, store) => {
      const principal = store.principals.get(ctx.params.id as string);
      return principal ? json(principal) : errorJson(404, "not_found", "unknown principal");
    }),
    r("POST", "/principals/:id/link", async (req, ctx, store) => {
      const b = await body(req);
      if (typeof b.platform !== "string" || typeof b.externalId !== "string") {
        return errorJson(400, "bad_request", "platform and externalId are required strings");
      }
      await store.principals.link(ctx.params.id as string, b.platform, b.externalId);
      return json({ ok: true });
    }),
    r("POST", "/principals/:id/role", async (req, ctx, store) => {
      const b = await body(req);
      if (!["owner", "trusted", "guest"].includes(b.role as string)) {
        return errorJson(400, "bad_request", "role must be owner, trusted or guest");
      }
      await store.principals.setRole(ctx.params.id as string, b.role as Principal["role"]);
      return json({ ok: true });
    }),

    r("GET", "/plugins", async () => json(deps.plugins())),
    r("GET", "/part-types", async (_req, _ctx, store) => json(store.partTypes.list())),
    r("POST", "/config/reload", async () => {
      const result = await deps.reload();
      return json(result, result.ok ? 200 : 400);
    }),

    r("GET", "/settings", async () => json(deps.settings())),
    r("GET", "/settings/:plugin", async (_req, ctx) => {
      const found = deps.settings().find((p) => p.plugin === ctx.params.plugin);
      return found ? json(found) : errorJson(404, "not_found", "unknown plugin");
    }),
    r("PATCH", "/settings/:plugin", async (req, ctx) => {
      const b = await body(req);
      const config = b.config;
      if (config !== undefined && (typeof config !== "object" || config === null || Array.isArray(config)))
        return errorJson(400, "bad_request", "config must be an object");
      if (b.enabled !== undefined && typeof b.enabled !== "boolean")
        return errorJson(400, "bad_request", "enabled must be a boolean");
      const patch: SettingsPatch = {
        ...(config === undefined ? {} : { config: config as Record<string, unknown> }),
        ...(b.enabled === undefined ? {} : { enabled: b.enabled as boolean }),
      };
      return json(await deps.updateSettings(ctx.params.plugin as string, patch));
    }),

    r("GET", "/secrets", async () =>
      json(listSecretFiles(deps.valetHome).map((name) => ({ name, source: "file" }))),
    ),
    r("GET", "/secrets/:name", async (_req, ctx) => {
      const name = ctx.params.name as string;
      if (!isSecretName(name)) return errorJson(400, "bad_request", "invalid secret name");
      return json({ name, source: secretSource(deps.valetHome, name) });
    }),
    r("PUT", "/secrets/:name", async (req, ctx) => {
      const name = ctx.params.name as string;
      const b = await body(req);
      if (!isSecretName(name)) return errorJson(400, "bad_request", "invalid secret name");
      if (typeof b.value !== "string" || b.value.trim() === "")
        return errorJson(400, "bad_request", "value must be a non-empty string");
      writeSecret(deps.valetHome, name, b.value.trim());
      deps.secretChanged(name);
      return json({ name, source: "file" });
    }),
    r("DELETE", "/secrets/:name", async (_req, ctx) => {
      const name = ctx.params.name as string;
      if (!isSecretName(name)) return errorJson(400, "bad_request", "invalid secret name");
      if (deleteSecret(deps.valetHome, name)) deps.secretChanged(name);
      return json({ name, source: secretSource(deps.valetHome, name) });
    }),

    r("GET", "/blobs/:id", async (_req, ctx) => {
      const meta = deps.blobMeta(ctx.params.id as string);
      if (!meta) return errorJson(404, "not_found", "unknown blob");
      const path = deps.blobPath(ctx.params.id as string);
      return new Response(Bun.file(path), {
        headers: { "content-type": meta.mime ?? "application/octet-stream" },
      });
    }),
    r("POST", "/blobs", async (req, _ctx, store) => {
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
): { handler: RestHandler; params: Record<string, string> } | undefined {
  const segments = splitPath(path).slice(2); // strip "api", "core"
  for (const route of restRoutes(deps)) {
    if (route.method !== method) continue;
    const params = matchSegments(route.pattern, segments);
    if (params) return { handler: route.handler, params };
  }
  return undefined;
}

/** Wraps a core REST handler: builds the caller-scoped store and maps failures. */
export function dispatchRest(
  deps: RestDeps,
  store: { forCaller(caller: Caller): Store },
  method: string,
  path: string,
  req: Request,
  ctx: RequestContext,
): Promise<Response> {
  const match = matchRest(deps, method, path);
  if (!match) return Promise.resolve(errorJson(404, "not_found", "not found"));
  const boundCtx: RequestContext = { ...ctx, params: match.params };
  return guard(() => match.handler(req, boundCtx, store.forCaller(ctx.caller)));
}
