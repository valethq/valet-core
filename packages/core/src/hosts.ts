import type {
  CallAcl,
  Disposable,
  HttpHost,
  RequestContext,
  RouteAcl,
  RouteHandler,
  TopicAcl,
  WsHost,
} from "@valethq/sdk";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteRecord {
  readonly plugin: string;
  readonly method: Method;
  /** Path relative to /plugins/<plugin-id>; ":param" segments allowed. */
  readonly path: string;
  readonly handler: RouteHandler;
  readonly public: boolean;
  readonly acl: RouteAcl;
}

export interface WsHandlerRecord {
  readonly plugin: string;
  readonly method: string;
  readonly fn: (params: unknown, ctx: RequestContext) => unknown | Promise<unknown>;
  readonly acl: CallAcl;
}

export interface TopicRecord {
  readonly plugin: string;
  readonly namespace: string;
  readonly prefix: string;
  readonly acl: TopicAcl;
}

export interface ScopedHttpHost extends HttpHost {
  disposeAll(): void;
}

export interface ScopedWsHost extends WsHost {
  disposeAll(): void;
}

export interface HttpRegistry {
  forPlugin(pluginId: string): ScopedHttpHost;
  /** The route table the control-plane server serves (10.1). */
  routes(): readonly RouteRecord[];
  removePlugin(pluginId: string): void;
}

export interface WsRegistry {
  forPlugin(pluginId: string, namespace: string): ScopedWsHost;
  /** The handler table the /ws endpoint routes "call" frames to (10.3). */
  handlers(): ReadonlyMap<string, WsHandlerRecord>;
  /** Topic prefixes plugins declared with `ctx.ws.topic`. */
  topics(): readonly TopicRecord[];
  /** Installed by the control-plane server so publish() reaches live sockets. */
  setBroadcast(fn: ((topic: string, name: string, data: unknown) => void) | undefined): void;
  removePlugin(pluginId: string): void;
}

function normalizePath(path: string): string {
  const p = path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
  if (p.split("/").includes("..")) throw new Error(`route path may not contain "..": "${path}"`);
  return p;
}

/** Route table: registration and disposal; the control plane reads it. `baseUrl` comes from the transport. */
export function createHttpRegistry(baseUrl: () => string): HttpRegistry {
  const routes: RouteRecord[] = [];

  return {
    routes: () => routes,
    forPlugin(pluginId) {
      const tracked = new Set<Disposable>();
      let closed = false;
      const host: ScopedHttpHost = {
        route(method, path, handler, opts) {
          if (closed) return { dispose() {} };
          const record: RouteRecord = {
            plugin: pluginId,
            method,
            path: normalizePath(path),
            handler,
            public: opts?.public ?? false,
            acl: opts ?? {},
          };
          if (routes.some((r) => r.plugin === pluginId && r.method === method && r.path === record.path)) {
            throw new Error(`route ${method} ${record.path} already registered by "${pluginId}"`);
          }
          routes.push(record);
          const disposable: Disposable = {
            dispose: () => {
              const i = routes.indexOf(record);
              if (i >= 0) routes.splice(i, 1);
            },
          };
          tracked.add(disposable);
          return disposable;
        },
        url: (path) => `${baseUrl()}/plugins/${pluginId}${normalizePath(path)}`,
        disposeAll: () => {
          closed = true;
          for (const d of tracked) d.dispose();
          tracked.clear();
        },
      };
      return host;
    },
    removePlugin(pluginId) {
      for (let i = routes.length - 1; i >= 0; i--) {
        if (routes[i]?.plugin === pluginId) routes.splice(i, 1);
      }
    },
  };
}

/** Thin WS registry for M0: stores "call" handlers; publish() waits for the phase-4 server. */
export function createWsRegistry(): WsRegistry {
  const handlers = new Map<string, WsHandlerRecord>();
  const topics: TopicRecord[] = [];
  let broadcast: ((topic: string, name: string, data: unknown) => void) | undefined;

  return {
    handlers: () => handlers,
    topics: () => topics,
    setBroadcast: (fn) => {
      broadcast = fn;
    },
    forPlugin(pluginId, namespace) {
      const tracked = new Set<Disposable>();
      let closed = false;
      const host: ScopedWsHost = {
        handle(method, fn, opts) {
          if (closed) return { dispose() {} };
          if (!method.startsWith(`${namespace}.`)) {
            throw new Error(
              `plugin "${pluginId}" cannot handle ws method "${method}" outside its namespace "${namespace}"`,
            );
          }
          if (handlers.has(method)) {
            throw new Error(`ws method "${method}" already handled by "${handlers.get(method)?.plugin}"`);
          }
          const record: WsHandlerRecord = { plugin: pluginId, method, fn, acl: opts ?? {} };
          handlers.set(method, record);
          const disposable: Disposable = {
            dispose: () => {
              if (handlers.get(method) === record) handlers.delete(method);
            },
          };
          tracked.add(disposable);
          return disposable;
        },
        topic(prefix, acl) {
          if (closed) return { dispose() {} };
          if (!prefix.startsWith(`${namespace}:`))
            throw new Error(`plugin "${pluginId}" cannot declare topic "${prefix}" outside "${namespace}:"`);
          const record: TopicRecord = { plugin: pluginId, namespace, prefix, acl };
          topics.push(record);
          const disposable: Disposable = {
            dispose: () => {
              const i = topics.indexOf(record);
              if (i >= 0) topics.splice(i, 1);
            },
          };
          tracked.add(disposable);
          return disposable;
        },
        publish(topic, name, data) {
          if (!topic.startsWith(`${namespace}:`)) {
            throw new Error(
              `plugin "${pluginId}" cannot publish to topic "${topic}" outside its prefix "${namespace}:"`,
            );
          }
          broadcast?.(topic, name, data);
        },
        disposeAll: () => {
          closed = true;
          for (const d of tracked) d.dispose();
          tracked.clear();
        },
      };
      return host;
    },
    removePlugin(pluginId) {
      for (const [method, record] of handlers) {
        if (record.plugin === pluginId) handlers.delete(method);
      }
      for (let i = topics.length - 1; i >= 0; i--) if (topics[i]?.plugin === pluginId) topics.splice(i, 1);
    },
  };
}
