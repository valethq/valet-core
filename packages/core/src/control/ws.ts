import {
  type Caller,
  type ClientFrame,
  type Decision,
  type Logger,
  type Principal,
  type RequestContext,
  type ServerFrame,
  ServiceDeniedError,
} from "@valethq/sdk";
import type { CoreBus } from "../bus/types";
import type { WsRegistry } from "../hosts";

/** Per-connection state stamped at connect (10.2/10.3). */
export interface WsSocketData {
  caller: Caller;
  principal: Principal | undefined;
  url: URL;
  subs: Set<string>;
  /** Connect request headers (cookie, authorization, ...) so identity providers can re-identify the channel. */
  headers: [string, string][];
  closed?: boolean;
  /** Inbound frames run one at a time so a later unsub cannot lose to an in-flight sub. */
  chain?: Promise<void>;
}

/** One connection as the hub sees it; `send` returns 0 when the transport dropped the frame. */
export interface HubSocket {
  data: WsSocketData;
  send(frame: ServerFrame): number;
  close(code: number, reason: string): void;
}

const send = (ws: HubSocket, frame: ServerFrame): void => {
  try {
    // send() === 0 means the frame was dropped; close so the client resumes via `since` instead of missing it.
    if (ws.send(frame) === 0) ws.close(1011, "send dropped");
  } catch {
    // socket closing; subscriptions are removed on close
  }
};

/** What re-identification found for a channel. */
export type Reidentified = { ok: true; caller: Caller; principal: Principal } | { ok: false };

export interface WsHubDeps {
  bus: CoreBus;
  ws: WsRegistry;
  logger: Logger;
  /** Re-runs connect-time identification and credential checks with the stored headers. */
  reidentify(data: WsSocketData): Promise<Reidentified>;
  /** The permission check for a sub (topic) or call (method) frame. */
  authorize(caller: Caller, kind: "ws.sub" | "ws.call", target: string, frame: ClientFrame): Decision;
  /** The plugin owning a topic or method, for `control.request`. */
  ownerOf(kind: "ws.sub" | "ws.call", target: string): string | undefined;
  /** Ring buffer per topic (10.3: 2,000 frames). */
  ringSize?: number;
}

const DEFAULT_RING = 2000;

const deniedFrame = (id: string, d: { by?: string; reason: string }): ServerFrame => ({
  type: "result",
  id,
  ok: false,
  error: { code: "denied", message: `${d.by ?? "?"}: ${d.reason}` },
});

/**
 * The multiplexed protocol (10.3): sub/unsub/call/ping, per-topic seq with a ring buffer, `since` replay and
 * `gap`, the permission check and `control.request` admission on sub and call frames. Transport-agnostic: a
 * transport feeds parsed frames in and delivers frames out through a HubSocket.
 */
export class WsHub {
  readonly #deps: WsHubDeps;
  readonly #ringSize: number;
  readonly #sockets = new Set<HubSocket>();
  readonly #seq = new Map<string, number>();
  readonly #buffers = new Map<string, { seq: number; name: string; data: unknown }[]>();

  constructor(deps: WsHubDeps) {
    this.#deps = deps;
    this.#ringSize = deps.ringSize ?? DEFAULT_RING;
  }

  /** publish(): per-topic seq, ring-buffered, fanned out to subscribers. */
  publish = (topic: string, name: string, data: unknown): void => {
    const seq = (this.#seq.get(topic) ?? 0) + 1;
    this.#seq.set(topic, seq);
    const buffer = this.#buffers.get(topic) ?? [];
    buffer.push({ seq, name, data });
    if (buffer.length > this.#ringSize) buffer.splice(0, buffer.length - this.#ringSize);
    this.#buffers.set(topic, buffer);
    const frame: ServerFrame = { type: "event", topic, seq, name, data };
    for (const ws of this.#sockets) {
      if (!ws.data.closed && ws.data.subs.has(topic)) send(ws, frame);
    }
  };

  open(ws: HubSocket): void {
    this.#sockets.add(ws);
  }

  close(ws: HubSocket): void {
    ws.data.closed = true;
    this.#sockets.delete(ws);
    ws.data.subs.clear();
  }

  #kick(ws: HubSocket): void {
    this.close(ws);
    // spec-gap: ServerFrame has no error frame, so the close code is the only signal.
    try {
      ws.close(4401, "unauthenticated");
    } catch {
      // already closing
    }
  }

  /**
   * Re-identifies every channel: a different or missing principal, or an inactive credential, closes it (4401).
   * Subscriptions whose permission no longer holds are dropped with a `denied` result; nothing is ever widened.
   */
  async revalidate(): Promise<void> {
    await Promise.all(
      [...this.#sockets].map(async (ws) => {
        let found: Reidentified = { ok: false };
        try {
          found = await this.#deps.reidentify(ws.data);
        } catch (error) {
          this.#deps.logger.error("ws re-identify failed", { error: String(error) });
        }
        if (!found.ok || found.principal.id !== ws.data.principal?.id) return this.#kick(ws);
        ws.data.principal = found.principal;
        ws.data.caller = found.caller;
        for (const topic of [...ws.data.subs]) {
          const d = this.#deps.authorize(found.caller, "ws.sub", topic, { type: "sub", topics: [topic] });
          if (d.allow) continue;
          ws.data.subs.delete(topic);
          send(ws, deniedFrame(topic, d));
        }
      }),
    );
  }

  async message(ws: HubSocket, frame: ClientFrame): Promise<void> {
    const task = (ws.data.chain ?? Promise.resolve()).then(() => this.#handle(ws, frame));
    ws.data.chain = task.catch(() => undefined);
    await task;
  }

  async #handle(ws: HubSocket, frame: ClientFrame): Promise<void> {
    if (ws.data.closed) return;
    try {
      switch (frame?.type) {
        case "ping":
          send(ws, { type: "pong" });
          return;
        case "sub":
          await this.#onSub(ws, frame);
          return;
        case "unsub":
          for (const topic of frame.topics ?? []) ws.data.subs.delete(topic);
          return;
        case "call":
          await this.#onCall(ws, frame);
          return;
        default:
          send(ws, {
            type: "result",
            id: "",
            ok: false,
            error: { code: "bad_frame", message: "unknown frame type" },
          });
      }
    } catch (error) {
      this.#deps.logger.error("ws frame failed", { error: String(error) });
    }
  }

  async #admit(
    ws: HubSocket,
    kind: "ws.sub" | "ws.call",
    method: string,
    path: string,
    frame: ClientFrame,
  ): Promise<{ by?: string; reason: string } | undefined> {
    const d = this.#deps.authorize(ws.data.caller, kind, path, frame);
    if (!d.allow) return d;
    const owner = this.#deps.ownerOf(kind, path);
    const res = await this.#deps.bus.emitAs(ws.data.caller, "control.request", {
      kind,
      method,
      path,
      ...(owner === undefined ? {} : { plugin: owner }),
    });
    if (!res.cancelled) return undefined;
    return { by: res.denied?.by, reason: res.denied?.reason ?? res.cancelReason ?? "denied" };
  }

  async #onSub(ws: HubSocket, frame: { topics: string[]; since?: Record<string, number> }): Promise<void> {
    for (const topic of frame.topics ?? []) {
      // Before admit, so a sub with no `since` can replay frames published while it waited.
      const snapshot = this.#seq.get(topic) ?? 0;
      const denied = await this.#admit(ws, "ws.sub", "sub", topic, { type: "sub", topics: [topic] });
      if (denied) {
        // spec-gap: sub carries no id, so a denied topic reports with the topic as id.
        send(ws, deniedFrame(topic, denied));
        continue;
      }
      const since = frame.since?.[topic];
      const buffer = this.#buffers.get(topic) ?? [];
      const latest = this.#seq.get(topic) ?? 0;
      const floor = since ?? snapshot;
      // Oldest kept seq is latest - length + 1, so floor == latest - length is still contiguous.
      const behind = buffer.length > 0 && floor < latest - buffer.length;
      const ahead = since !== undefined && since > latest;
      if (behind || ahead) {
        send(ws, { type: "gap", topic });
      } else {
        for (const entry of buffer) {
          if (entry.seq > floor) {
            send(ws, { type: "event", topic, seq: entry.seq, name: entry.name, data: entry.data });
          }
        }
      }
      ws.data.subs.add(topic);
    }
  }

  async #onCall(ws: HubSocket, frame: { id: string; method: string; params?: unknown }): Promise<void> {
    const handler = this.#deps.ws.handlers().get(frame.method);
    const denied = await this.#admit(ws, "ws.call", frame.method, frame.method, { type: "call", ...frame });
    if (denied) {
      send(ws, deniedFrame(frame.id, denied));
      return;
    }
    if (!handler) {
      send(ws, {
        type: "result",
        id: frame.id,
        ok: false,
        error: { code: "unknown_method", message: `no handler for "${frame.method}"` },
      });
      return;
    }
    const ctx: RequestContext = {
      caller: ws.data.caller,
      principal: ws.data.principal,
      params: {},
      url: ws.data.url,
    };
    try {
      const data = await handler.fn(frame.params, ctx);
      send(ws, { type: "result", id: frame.id, ok: true, ...(data === undefined ? {} : { data }) });
    } catch (error) {
      const err =
        error instanceof ServiceDeniedError
          ? { code: "denied", message: `${error.by ?? handler.plugin}: ${error.reason || error.message}` }
          : { code: "error", message: error instanceof Error ? error.message : String(error) };
      send(ws, { type: "result", id: frame.id, ok: false, error: err });
    }
  }
}
