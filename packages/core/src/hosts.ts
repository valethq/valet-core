import type { Disposable, HttpHost, RouteHandler, WsHost } from "@valethq/sdk";
import type { RequestContext } from "@valethq/sdk";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteRecord {
  readonly plugin: string;
  readonly method: Method;
  /** Path relative to /plugins/<plugin-id>; ":param" segments allowed. */
  readonly path: string;
  readonly handler: RouteHandler;
  readonly public: boolean;
}

export interface WsHandlerRecord {
  readonly plugin: string;
  readonly method: string;
  readonly fn: (params: unknown, ctx: RequestContext) => unknown | Promise<unknown>;
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
  /** Installed by the control-plane server so publish() reaches live sockets. */
  setBroadcast(fn: ((topic: string, name: string, data: unknown) => void) | undefined): void;
  removePlugin(pluginId: string): void;
}

function normalizePath(path: string): string {
  const p = path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
  if (p.split("/").includes("..")) throw new Error(`route path may not contain "..": "${path}"`);
  return p;
}

/** Thin route table for M0: registration and disposal only; the phase-4 server reads it. */
export function createHttpRegistry(server: { host: string; port: number }): HttpRegistry {
  const routes: RouteRecord[] = [];
  const base = `http://${server.host}:${server.port}`;

  return {
    routes: () => routes,
    forPlugin(pluginId) {
      const tracked = new Set<Disposable>();
      const host: ScopedHttpHost = {
        route(method, path, handler, opts) {
          const record: RouteRecord = {
            plugin: pluginId,
            method,
            path: normalizePath(path),
            handler,
            public: opts?.public ?? false,
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
        url: (path) => `${base}/plugins/${pluginId}${normalizePath(path)}`,
        disposeAll: () => {
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
  let broadcast: ((topic: string, name: string, data: unknown) => void) | undefined;

  return {
    handlers: () => handlers,
    setBroadcast: (fn) => {
      broadcast = fn;
    },
    forPlugin(pluginId, namespace) {
      const tracked = new Set<Disposable>();
      const host: ScopedWsHost = {
        handle(method, fn) {
          if (!method.startsWith(`${namespace}.`)) {
            throw new Error(
              `plugin "${pluginId}" cannot handle ws method "${method}" outside its namespace "${namespace}"`,
            );
          }
          if (handlers.has(method)) {
            throw new Error(`ws method "${method}" already handled by "${handlers.get(method)?.plugin}"`);
          }
          const record: WsHandlerRecord = { plugin: pluginId, method, fn };
          handlers.set(method, record);
          const disposable: Disposable = {
            dispose: () => {
              if (handlers.get(method) === record) handlers.delete(method);
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
    },
  };
}
