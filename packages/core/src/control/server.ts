import type { Server } from "bun";
import {
  type AuthResult,
  type Caller,
  type Logger,
  type Principal,
  type RequestContext,
  ServiceDeniedError,
} from "@valethq/sdk";
import type { RouteRecord } from "../hosts";
import type { PluginStatus, ValetKernel } from "../kernel";
import { VALET_VERSION } from "../version";
import { deniedJson, dispatchRest, errorJson, json, type RestDeps } from "./rest";
import { matchSegments, splitPath } from "./router";
import { WsHub, type WsSocketData } from "./ws";

const CSP = "default-src 'none'";

type Resolved =
  | { kind: "status"; public: true }
  | { kind: "rest"; public: false }
  | { kind: "ws"; public: false }
  | { kind: "plugin"; public: boolean; route: RouteRecord; params: Record<string, string> }
  | { kind: "notfound"; public: false };

export interface ControlServerOptions {
  /** Overrides config.server.host/port (tests bind port 0). */
  host?: string;
  port?: number;
  /** spec-gap: WS ring-buffer size, overridable so tests can exercise gap replay. */
  ringSize?: number;
  logger?: Logger;
}

export interface ControlServer {
  /** Serve after core.ready (5.2 step 6). */
  start(): void;
  /** Stopped first on shutdown, before core.shutdown. */
  stop(): void;
  readonly port: number;
  baseUrl(): string;
  /** Core-side publish for the 10.3 core topics. */
  publish(topic: string, name: string, data: unknown): void;
}

/**
 * The one Bun.serve control plane (10.1): `/` status doc, `/api/core/*` REST,
 * `/ws` and `/plugins/<id>/*` routes from the kernel's HttpRegistry. Every
 * request is identified through identity@1 providers and admitted through the
 * `control.request` action event (10.2). No HTML, no static files.
 */
export function createControlServer(kernel: ValetKernel, opts: ControlServerOptions = {}): ControlServer {
  const log = opts.logger ?? kernel.log.forPlugin("control");
  const hub = new WsHub({
    bus: kernel.bus,
    ws: kernel.ws,
    plugins: () => kernel.plugins(),
    logger: log,
    identify: async (req) => {
      const r = await identify(req);
      return r.ok ? r.principal : undefined;
    },
    ...(opts.ringSize === undefined ? {} : { ringSize: opts.ringSize }),
  });
  // Plugin ctx.ws.publish() reaches live sockets through the hub.
  kernel.ws.setBroadcast(hub.publish);

  // 10.3 core topics, driven by store after-hooks and signals.
  const coreEvents = kernel.bus.forPlugin("core");
  const publishSessions = (sessionId: string, name: string, payload: unknown): void => {
    const session = kernel.store.forCaller({ plugin: "core" }).sessions.get(sessionId);
    if (session) hub.publish(`sessions:${session.projectId}`, name, payload);
  };
  coreEvents.after("session.create", (e) =>
    publishSessions(e.payload.session.id, "session.create", e.payload),
  );
  coreEvents.after("session.update", (e) =>
    publishSessions(e.payload.session.id, "session.update", e.payload),
  );
  coreEvents.after("session.delete", (e) =>
    publishSessions(e.payload.session.id, "session.delete", e.payload),
  );
  coreEvents.after("message.create", (e) =>
    hub.publish(`session:${e.payload.message.sessionId}`, "message.create", e.payload),
  );
  coreEvents.after("message.complete", (e) =>
    hub.publish(`session:${e.payload.message.sessionId}`, "message.complete", e.payload),
  );
  coreEvents.onSignal("message.delta", (p) => hub.publish(`session:${p.sessionId}`, "message.delta", p));
  coreEvents.after("run.start", (e) =>
    hub.publish(`session:${e.payload.run.sessionId}`, "run.start", e.payload),
  );
  coreEvents.after("run.end", (e) => hub.publish(`session:${e.payload.run.sessionId}`, "run.end", e.payload));
  coreEvents.onSignal("run.status", (p) => hub.publish(`session:${p.sessionId}`, "run.status", p));

  let reidentifyTimer: ReturnType<typeof setTimeout> | undefined;
  coreEvents.after("identity.changed", () => {
    if (reidentifyTimer !== undefined) return;
    reidentifyTimer = setTimeout(() => {
      reidentifyTimer = undefined;
      void hub.reidentifySockets();
    }, 250);
  });
  let reidentifyInterval: ReturnType<typeof setInterval> | undefined;

  const coreScopes = kernel.scopes.forPlugin("core", []);
  let server: Server<WsSocketData> | undefined;
  let host = "127.0.0.1";

  const restDeps: RestDeps = {
    plugins: () => kernel.plugins(),
    blobMeta: (id) => {
      const row = kernel.store.db
        .query<{ sha256: string; mime: string | null; name: string | null }, string>(
          "SELECT sha256, mime, name FROM blobs WHERE id = ?",
        )
        .get(id);
      return row ?? undefined;
    },
    blobPath: (id) => kernel.store.forCaller({ plugin: "core" }).blobs.path(id),
  };

  const corsHeaders = (origin: string | null): Record<string, string> => {
    if (origin === null || !kernel.config.server.allowedOrigins.includes(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      vary: "Origin",
    };
  };

  /** Every response gets the control-plane CSP; allowed origins get credentialed CORS. */
  const finalize = (res: Response, origin: string | null): Response => {
    const headers = new Headers(res.headers);
    headers.set("content-security-policy", CSP);
    for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  function resolve(method: string, path: string): Resolved {
    if (path === "/") return { kind: "status", public: true };
    if (path === "/ws") return { kind: "ws", public: false };
    if (path.startsWith("/api/core/") || path === "/api/core") return { kind: "rest", public: false };
    const segments = splitPath(path);
    if (segments[0] === "plugins" && segments.length >= 2) {
      const pluginId = segments[1] as string;
      const rest = segments.slice(2);
      for (const route of kernel.http.routes()) {
        if (route.plugin !== pluginId || route.method !== method) continue;
        const params = matchSegments(splitPath(route.path), rest);
        if (params) return { kind: "plugin", public: route.public, route, params };
      }
      return { kind: "notfound", public: false };
    }
    return { kind: "notfound", public: false };
  }

  /** 10.2 step 1: ask identity@1 providers in load order. */
  async function identify(
    req: Request,
  ): Promise<
    | { ok: true; principal: Principal | undefined; authenticatedBy: string | undefined }
    | { ok: false; res: Response }
  > {
    for (const provider of coreScopes.all("identity")) {
      let auth: AuthResult | undefined;
      try {
        auth = await provider.impl.authenticate(req);
      } catch (error) {
        if (error instanceof ServiceDeniedError) {
          return {
            ok: false,
            res: deniedJson({
              by: error.by ?? provider.plugin,
              reason: error.reason || error.message,
            }),
          };
        }
        // A broken provider fails closed downstream (anonymous -> 401 on non-public routes).
        log.error("identity provider failed", { plugin: provider.plugin, error: String(error) });
        continue;
      }
      if (auth !== undefined) {
        const principal = kernel.store.forCaller({ plugin: "core" }).principals.get(auth.principalId);
        // Unknown principal -> anonymous (10.2).
        return { ok: true, principal, authenticatedBy: principal === undefined ? undefined : provider.key };
      }
    }
    return { ok: true, principal: undefined, authenticatedBy: undefined };
  }

  async function onRequest(req: Request, srv: Server<WsSocketData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = req.headers.get("origin");

    // CORS preflight (10.1): handled before identity; disallowed origins are refused.
    if (req.method === "OPTIONS" && req.headers.has("access-control-request-method")) {
      if (origin !== null && kernel.config.server.allowedOrigins.includes(origin)) {
        const res = new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": origin,
            "access-control-allow-credentials": "true",
            "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "access-control-allow-headers":
              req.headers.get("access-control-request-headers") ?? "authorization, content-type",
            "access-control-max-age": "600",
            vary: "Origin",
          },
        });
        return finalize(res, origin);
      }
      return finalize(errorJson(403, "forbidden", "origin not allowed"), origin);
    }

    if (origin !== null && !kernel.config.server.allowedOrigins.includes(origin)) {
      return finalize(errorJson(403, "forbidden", "origin not allowed"), origin);
    }

    const resolved = resolve(req.method, path);
    const identified = await identify(req);
    if (!identified.ok) return finalize(identified.res, origin);

    const { principal, authenticatedBy } = identified;
    const caller: Caller = {
      plugin: "core",
      ...(principal === undefined ? {} : { actor: { principalId: principal.id, role: principal.role } }),
      ...(authenticatedBy === undefined ? {} : { authenticatedBy }),
    };

    // Fail closed: anonymous reaches only public routes (10.2).
    if (principal === undefined && !resolved.public) {
      return finalize(errorJson(401, "unauthorized", "authentication required"), origin);
    }

    // 10.2 step 2: every admitted request is a control.request action event.
    const owner = resolved.kind === "plugin" ? resolved.route.plugin : undefined;
    let denied: { by?: string; reason: string } | undefined;
    try {
      const emitted = await kernel.bus.emitAs(caller, "control.request", {
        kind: "http",
        method: req.method,
        path,
        ...(owner === undefined ? {} : { plugin: owner }),
      });
      if (emitted.cancelled) {
        denied = {
          by: emitted.denied?.by,
          reason: emitted.denied?.reason ?? emitted.cancelReason ?? "denied",
        };
      }
    } catch (error) {
      log.error("control.request before-hook failed", { error: String(error) });
      return finalize(errorJson(500, "internal", "control.request hook failed"), origin);
    }
    if (denied) {
      return finalize(deniedJson(denied), origin);
    }

    const ctx: RequestContext = {
      caller,
      principal,
      params: resolved.kind === "plugin" ? resolved.params : {},
      url,
    };

    try {
      switch (resolved.kind) {
        case "status":
          return finalize(
            json({
              name: "valet",
              version: VALET_VERSION,
              plugins: kernel.plugins().map((p: PluginStatus) => ({ id: p.id, state: p.state })),
            }),
            origin,
          );
        case "rest":
          return finalize(await dispatchRest(restDeps, kernel.store, req.method, path, req, ctx), origin);
        case "plugin": {
          const res = await resolved.route.handler(req, ctx);
          // 10.1: a plugin route answering text/html is a 500 plus a log line.
          if (res.headers.get("content-type")?.includes("text/html")) {
            log.error("plugin route returned text/html", { plugin: resolved.route.plugin, path });
            return finalize(errorJson(500, "html_not_allowed", "control plane does not serve HTML"), origin);
          }
          return finalize(res, origin);
        }
        case "ws": {
          const upgraded = srv.upgrade(req, {
            data: { caller, principal, url, subs: new Set<string>(), headers: [...req.headers] },
          });
          return upgraded
            ? undefined
            : finalize(errorJson(400, "bad_request", "websocket upgrade required"), origin);
        }
        case "notfound":
          return finalize(errorJson(404, "not_found", "not found"), origin);
      }
    } catch (error) {
      log.error("control-plane request failed", { path, error: String(error) });
      return finalize(errorJson(500, "internal", "internal error"), origin);
    }
  }

  return {
    start(): void {
      host = opts.host ?? kernel.config.server.host;
      const port = opts.port ?? kernel.config.server.port;
      server = Bun.serve<WsSocketData>({
        hostname: host,
        port,
        fetch: (req, srv) => onRequest(req, srv),
        websocket: {
          open: (ws) => hub.open(ws),
          message: (ws, msg) => void hub.message(ws, msg),
          close: (ws) => hub.close(ws),
        },
      });
      reidentifyInterval = setInterval(() => void hub.reidentifySockets(), 60_000);
      // Seed the "plugins" topic so late subscribers can catch up on boot-time states.
      for (const p of kernel.plugins()) hub.publish("plugins", "plugin.state", p);
      log.info("control plane listening", { host, port: server.port });
    },

    stop(): void {
      clearInterval(reidentifyInterval);
      clearTimeout(reidentifyTimer);
      reidentifyInterval = undefined;
      reidentifyTimer = undefined;
      server?.stop(true);
      server = undefined;
    },

    get port() {
      return server?.port ?? -1;
    },

    baseUrl(): string {
      const display = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
      return `http://${display}:${server?.port ?? 0}`;
    },

    publish: (topic, name, data) => hub.publish(topic, name, data),
  };
}
