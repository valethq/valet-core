import type { RequestContext } from "./http";
import type { Disposable } from "./plugin";

export type ClientFrame =
  | { type: "sub"; topics: string[]; since?: Record<string, number> } // resume from per-topic seq
  | { type: "unsub"; topics: string[] }
  | { type: "call"; id: string; method: string; params?: unknown } // routed to a plugin handler by "<namespace>." prefix
  | { type: "ping" };

export type ServerFrame =
  | { type: "event"; topic: string; seq: number; name: string; data: unknown }
  | { type: "result"; id: string; ok: true; data?: unknown }
  | { type: "result"; id: string; ok: false; error: { code: string; message: string } } // code "denied" carries the Denial
  | { type: "gap"; topic: string } // asked-for seq fell off the buffer: refetch state over REST
  | { type: "pong" };

export interface WsHost {
  handle(method: string, fn: (params: unknown, ctx: RequestContext) => unknown | Promise<unknown>): Disposable;
  publish(topic: string, name: string, data: unknown): void;
}
