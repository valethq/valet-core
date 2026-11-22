import {
  type AclContext,
  type AuthResult,
  type Caller,
  type ClientFrame,
  type ControlChannel,
  type ControlPlane,
  ControlRefusedError,
  type Decision,
  type Principal,
  type RequestContext,
  type ResourceScope,
  type ServerFrame,
  ServiceDeniedError,
  can,
} from "@valethq/sdk";
import type { AclRegistry } from "../acl";
import type { RouteRecord } from "../hosts";
import type { PluginStatus, ValetKernel } from "../kernel";
import { VALET_VERSION } from "../version";
import { deniedJson, errorJson, json, matchRest, type RestDeps, runRest, sessionScope } from "./rest";
import { matchSegments, splitPath } from "./router";
import { type HubSocket, WsHub, type WsSocketData } from "./ws";

type Resolved =
  | { kind: "status"; public: true }
  | { kind: "rest"; public: false; match: ReturnType<typeof matchRest> }
  | { kind: "ws"; public: false }
  | { kind: "plugin"; public: boolean; route: RouteRecord; params: Record<string, string> }
  | { kind: "notfound"; public: false };

type Identified =
  | { ok: true; principal: Principal | undefined; caller: Caller }
  | { ok: false; res: Response };

/** Core's side of the control plane: `dispatch` and `connect` for transports, plus the topic hub. */
export interface CorePlane extends ControlPlane {
  /** Core-side publish for the 10.3 core topics and `ctx.ws.publish`. */
  publish(topic: string, name: string, data: unknown): void;
  /** Re-identifies every channel and re-checks its subscriptions. */
  revalidate(): Promise<void>;
  close(): void;
}

export interface PlaneOptions {
  /** spec-gap: WS ring-buffer size, overridable so tests can exercise gap replay. */
  ringSize?: number;
}

const REVALIDATE_MS = 60_000;

/**
 * 10 rewritten around `dispatch` and `connect`: resolve, identify through identity@1, stamp the caller from the
 * evidence, check the route's permission with `can`, emit `control.request`, run the handler. No listener, no CORS,
 * no CSP: those belong to the transport.
 */
export function createControlPlane(
  kernel: Omit<ValetKernel, "control">,
  acl: AclRegistry,
  opts: PlaneOptions = {},
): CorePlane {
  const log = kernel.log.forPlugin("control");
  let closed = false;
  const coreScopes = kernel.scopes.forPlugin("core", []);
  const coreStore = kernel.store.forPlugin("core");
  const aclCtx: AclContext = {
    plugin: { id: "core" },
    acl: acl.host,
    scopes: coreScopes,
    store: coreStore,
    log,
  };
  const check = (caller: Caller, permission: string, resource?: ResourceScope): Decision =>
    can(aclCtx, caller, permission, resource);

  const nsOf = (pluginId: string): string => acl.namespaceOf(pluginId) ?? pluginId.replace(/^valet-/, "");

  const restDeps: RestDeps = {
    plugins: () => kernel.plugins(),
    reload: () => kernel.reload(),
    settings: (project) => kernel.settings(project),
    updateSettings: (plugin, patch) => kernel.updateSettings(plugin, patch),
    secretChanged: (name) => kernel.bus.signalAs({ plugin: "core" }, "core.secrets.changed", { name }),
    valetHome: kernel.valetHome,
    blobMeta: (id) =>
      kernel.store.db
        .query<{ sha256: string; mime: string | null; name: string | null }, string>(
          "SELECT sha256, mime, name FROM blobs WHERE id = ?",
        )
        .get(id) ?? undefined,
    blobPath: (id) => kernel.store.forCaller({ plugin: "core" }).blobs.path(id),
    messageSession: (id) =>
      kernel.store.db
        .query<{ session_id: string }, string>("SELECT session_id FROM messages WHERE id = ?")
        .get(id)?.session_id,
    can: (caller, permission, resource) => check(caller, permission, resource).allow,
  };

  function resolve(method: string, path: string): Resolved {
    if (path === "/") return { kind: "status", public: true };
    if (path === "/ws") return { kind: "ws", public: false };
    if (path.startsWith("/api/core/") || path === "/api/core")
      return { kind: "rest", public: false, match: matchRest(restDeps, method, path) };
    const segments = splitPath(path);
    if (segments[0] === "plugins" && segments.length >= 2) {
      const pluginId = segments[1] as string;
      const rest = segments.slice(2);
      for (const route of kernel.http.routes()) {
        if (route.plugin !== pluginId || route.method !== method) continue;
        const params = matchSegments(splitPath(route.path), rest);
        if (params) return { kind: "plugin", public: route.public, route, params };
      }
    }
    return { kind: "notfound", public: false };
  }

  const stamp = (principal: Principal | undefined, key: string | undefined, auth?: AuthResult): Caller => ({
    plugin: "core",
    ...(principal === undefined
      ? {}
      : {
          actor: {
            principalId: principal.id,
            role: principal.role,
            ...(auth?.tags === undefined ? {} : { tags: auth.tags }),
            ...(auth?.cap === undefined ? {} : { cap: auth.cap }),
          },
        }),
    ...(principal === undefined || key === undefined ? {} : { authenticatedBy: key }),
    ...(principal === undefined || auth?.credentialId === undefined
      ? {}
      : { credentialId: `${key}:${auth.credentialId}` }),
    ...(principal !== undefined && auth?.verifiedLogin === true ? { verifiedLogin: true } : {}),
  });

  /** 10.2 step 1: ask identity@1 providers in load order; the evidence, never the calling plugin, names the actor. */
  async function identify(req: Request): Promise<Identified> {
    for (const provider of coreScopes.all("identity")) {
      let auth: AuthResult | undefined;
      try {
        auth = await provider.impl.authenticate(req);
      } catch (error) {
        if (error instanceof ServiceDeniedError) {
          return {
            ok: false,
            res: deniedJson({ by: error.by ?? provider.plugin, reason: error.reason || error.message }),
          };
        }
        // A broken provider fails closed downstream (anonymous -> 401 on non-public routes).
        log.error("identity provider failed", { plugin: provider.plugin, error: String(error) });
        continue;
      }
      if (auth !== undefined) {
        // Unknown principal -> anonymous (10.2).
        const principal = coreStore.principals.get(auth.principalId);
        return { ok: true, principal, caller: stamp(principal, provider.key, auth) };
      }
    }
    return { ok: true, principal: undefined, caller: stamp(undefined, undefined) };
  }

  function routeCheck(resolved: Resolved, req: Request, caller: Caller): Decision | undefined {
    if (resolved.kind === "rest") {
      const m = resolved.match;
      if (m === undefined || m.acl.collection || m.acl.manual) return undefined;
      return check(
        caller,
        m.acl.permission,
        m.acl.resource ? m.acl.resource(m.params, coreStore) : undefined,
      );
    }
    if (resolved.kind === "plugin" && !resolved.public) {
      const a = resolved.route.acl;
      if (a.collection) return undefined;
      let resource: ResourceScope | undefined;
      try {
        resource = a.resource?.(req);
      } catch (error) {
        return { allow: false, by: "core", reason: `cannot resolve the route resource: ${String(error)}` };
      }
      return check(caller, a.permission ?? `${nsOf(resolved.route.plugin)}:control`, resource);
    }
    return undefined;
  }

  async function admit(caller: Caller, kind: "http", method: string, path: string, owner?: string) {
    const emitted = await kernel.bus.emitAs(caller, "control.request", {
      kind,
      method,
      path,
      ...(owner === undefined ? {} : { plugin: owner }),
    });
    if (!emitted.cancelled) return undefined;
    return { by: emitted.denied?.by, reason: emitted.denied?.reason ?? emitted.cancelReason ?? "denied" };
  }

  async function dispatch(req: Request): Promise<Response> {
    if (closed) return errorJson(503, "shutting_down", "valet is shutting down");
    const url = new URL(req.url);
    const path = url.pathname;
    const resolved = resolve(req.method, path);
    const identified = await identify(req);
    if (!identified.ok) return identified.res;
    const { principal, caller } = identified;

    // Fail closed: anonymous reaches only public routes (10.2).
    if (principal === undefined && !resolved.public)
      return errorJson(401, "unauthorized", "authentication required");

    const decision = routeCheck(resolved, req, caller);
    if (decision !== undefined && !decision.allow) return deniedJson(decision);

    let denied: { by?: string; reason: string } | undefined;
    try {
      denied = await admit(
        caller,
        "http",
        req.method,
        path,
        resolved.kind === "plugin" ? resolved.route.plugin : undefined,
      );
    } catch (error) {
      log.error("control.request before-hook failed", { error: String(error) });
      return errorJson(500, "internal", "control.request hook failed");
    }
    if (denied) return deniedJson(denied);

    const ctx: RequestContext = {
      caller,
      principal,
      params: resolved.kind === "plugin" ? resolved.params : {},
      url,
    };
    try {
      switch (resolved.kind) {
        case "status":
          return json({
            name: "valet",
            version: VALET_VERSION,
            plugins: kernel.plugins().map((p: PluginStatus) => ({ id: p.id, state: p.state })),
          });
        case "rest":
          return resolved.match
            ? await runRest(resolved.match, kernel.store, req, ctx)
            : errorJson(404, "not_found", "not found");
        case "plugin":
          return await resolved.route.handler(req, ctx);
        case "ws":
          return errorJson(400, "bad_request", "websocket upgrade required");
        case "notfound":
          return errorJson(404, "not_found", "not found");
      }
    } catch (error) {
      log.error("control-plane request failed", { path, error: String(error) });
      return errorJson(500, "internal", "internal error");
    }
  }

  // ---- topics and calls ------------------------------------------------------

  function topicCheck(caller: Caller, topic: string): Decision {
    if (topic === "plugins") return check(caller, "core:plugin.read");
    if (topic.startsWith("session:")) {
      const id = topic.slice("session:".length);
      return check(caller, "core:session.read", sessionScope(id, coreStore.sessions.get(id)?.projectId));
    }
    if (topic.startsWith("sessions:"))
      return check(caller, "core:session.read", { id: `project:${topic.slice("sessions:".length)}` });
    const declared = kernel.ws
      .topics()
      .filter((t) => topic.startsWith(t.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];
    if (declared) {
      let resource: ResourceScope | undefined;
      try {
        resource = declared.acl.resource?.(topic);
      } catch (error) {
        return { allow: false, by: "core", reason: `cannot resolve the topic resource: ${String(error)}` };
      }
      return check(caller, declared.acl.permission, resource);
    }
    const sep = topic.search(/[:.]/);
    const ns = sep === -1 ? topic : topic.slice(0, sep);
    return check(caller, acl.permission(`${ns}:control`) ? `${ns}:control` : "core:control");
  }

  const hub = new WsHub({
    bus: kernel.bus,
    ws: kernel.ws,
    logger: log,
    ...(opts.ringSize === undefined ? {} : { ringSize: opts.ringSize }),
    authorize(caller, kind, target, frame: ClientFrame) {
      if (kind === "ws.sub") return topicCheck(caller, target);
      const handler = kernel.ws.handlers().get(target);
      if (handler === undefined) return { allow: true }; // answered as unknown_method
      let resource: ResourceScope | undefined;
      try {
        resource = handler.acl.resource?.(frame);
      } catch (error) {
        return { allow: false, by: "core", reason: `cannot resolve the call resource: ${String(error)}` };
      }
      return check(caller, handler.acl.permission ?? `${nsOf(handler.plugin)}:control`, resource);
    },
    ownerOf(kind, target) {
      if (kind === "ws.call") return kernel.ws.handlers().get(target)?.plugin;
      const declared = kernel.ws.topics().find((t) => target.startsWith(t.prefix));
      if (declared) return declared.plugin;
      const sep = target.search(/[:.]/);
      if (sep === -1) return undefined;
      const ns = target.slice(0, sep);
      for (const [method, record] of kernel.ws.handlers())
        if (method.startsWith(`${ns}.`)) return record.plugin;
      return kernel.plugins().find((p) => p.id === `valet-${ns}` || p.id === ns)?.id;
    },
    async reidentify(data: WsSocketData) {
      const found = await identify(new Request(data.url.href, { headers: data.headers }));
      if (!found.ok || found.principal === undefined) return { ok: false };
      const ref = found.caller.credentialId;
      if (ref !== undefined && acl.host.credential(ref)?.active !== true) return { ok: false };
      return { ok: true, caller: found.caller, principal: found.principal };
    },
  });

  async function connect(req: Request): Promise<ControlChannel> {
    if (closed) throw new ControlRefusedError(errorJson(503, "shutting_down", "valet is shutting down"));
    const url = new URL(req.url);
    const identified = await identify(req);
    if (!identified.ok) throw new ControlRefusedError(identified.res);
    const { principal, caller } = identified;
    if (principal === undefined)
      throw new ControlRefusedError(errorJson(401, "unauthorized", "authentication required"));
    const denied = await admit(caller, "http", req.method, url.pathname);
    if (denied) throw new ControlRefusedError(deniedJson(denied));

    const frameFns: ((frame: ServerFrame) => void)[] = [];
    const closeFns: ((code: number, reason: string) => void)[] = [];
    const data: WsSocketData = { caller, principal, url, subs: new Set(), headers: [...req.headers] };
    const sock: HubSocket = {
      data,
      send(frame) {
        for (const fn of frameFns) fn(frame);
        return 1;
      },
      close(code, reason) {
        hub.close(sock);
        for (const fn of closeFns) fn(code, reason);
      },
    };
    hub.open(sock);
    return {
      get principal() {
        return data.principal;
      },
      send: (frame) => void hub.message(sock, frame),
      onFrame: (fn) => void frameFns.push(fn),
      onClose: (fn) => void closeFns.push(fn),
      close: () => hub.close(sock),
    };
  }

  // ---- 10.3 core topics, driven by store after-hooks and signals ----------------
  // Topic id comes from the payload: session.delete's row is already gone. Skip cancelled actions.
  const coreEvents = kernel.bus.forPlugin("core");
  coreEvents.after("session.create", (e) => {
    if (!e.cancelled) hub.publish(`sessions:${e.payload.session.projectId}`, "session.create", e.payload);
  });
  coreEvents.after("session.update", (e) => {
    if (!e.cancelled) hub.publish(`sessions:${e.payload.session.projectId}`, "session.update", e.payload);
  });
  coreEvents.after("session.delete", (e) => {
    if (!e.cancelled) hub.publish(`sessions:${e.payload.session.projectId}`, "session.delete", e.payload);
  });
  coreEvents.after("message.create", (e) => {
    if (!e.cancelled) hub.publish(`session:${e.payload.message.sessionId}`, "message.create", e.payload);
  });
  coreEvents.after("message.complete", (e) => {
    if (!e.cancelled) hub.publish(`session:${e.payload.message.sessionId}`, "message.complete", e.payload);
  });
  coreEvents.onSignal("message.delta", (p) => hub.publish(`session:${p.sessionId}`, "message.delta", p));
  coreEvents.after("run.start", (e) =>
    hub.publish(`session:${e.payload.run.sessionId}`, "run.start", e.payload),
  );
  coreEvents.after("run.update", (e) =>
    hub.publish(`session:${e.payload.run.sessionId}`, "run.update", e.payload),
  );
  coreEvents.after("run.end", (e) => hub.publish(`session:${e.payload.run.sessionId}`, "run.end", e.payload));
  coreEvents.onSignal("part.update", (p) => hub.publish(`session:${p.sessionId}`, "part.update", p));
  coreEvents.onSignal("run.status", (p) => hub.publish(`session:${p.sessionId}`, "run.status", p));

  // Revalidate on identity, principal and policy changes (debounced 250 ms) and every 60 s.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void hub.revalidate();
    }, 250);
  };
  coreEvents.after("identity.changed", soon);
  coreEvents.after("principal.update", (e) => {
    if (!e.cancelled) soon();
  });
  coreEvents.after("principal.link", (e) => {
    if (!e.cancelled) soon();
  });
  coreEvents.after("policy.changed", soon);
  const interval = setInterval(() => void hub.revalidate(), REVALIDATE_MS);

  kernel.ws.setBroadcast(hub.publish);
  // Seed the "plugins" topic so late subscribers can catch up on boot-time states.
  for (const p of kernel.plugins()) hub.publish("plugins", "plugin.state", p);

  return {
    dispatch,
    connect,
    publish: hub.publish,
    revalidate: () => hub.revalidate(),
    close() {
      closed = true;
      clearInterval(interval);
      clearTimeout(timer);
      kernel.ws.setBroadcast(undefined);
    },
  };
}
