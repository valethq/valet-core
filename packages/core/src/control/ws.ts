import type { ServerWebSocket } from "bun";
import {
  type Caller,
  type ClientFrame,
  type Logger,
  type Principal,
  type RequestContext,
  type ServerFrame,
  ServiceDeniedError,
} from "@valethq/sdk";
import type { CoreBus } from "../bus/types";
import type { WsRegistry } from "../hosts";
import type { PluginStatus } from "../kernel";

/** Per-socket state stamped at upgrade (10.2/10.3). */
export interface WsSocketData {
  caller: Caller;
  principal: Principal | undefined;
  url: URL;
  subs: Set<string>;
  /** Upgrade request headers (cookie, authorization, ...) so identity providers can re-identify the socket. */
  headers: [string, string][];
  closed?: boolean;
}

const send = (ws: ServerWebSocket<WsSocketData>, frame: ServerFrame): void => {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // socket closing; subscriptions are removed on close
  }
};

export interface WsHubDeps {
  bus: CoreBus;
  ws: WsRegistry;
  plugins(): PluginStatus[];
  logger: Logger;
  /** Re-runs the upgrade-time identification; undefined means anonymous or refused. */
  identify(req: Request): Promise<Principal | undefined>;
  /** Ring buffer per topic (10.3: 2,000 frames). */
  ringSize?: number;
}

const DEFAULT_RING = 2000;

/**
 * The /ws multiplexed protocol (10.3): sub/unsub/call/ping, per-topic seq with a
 * ring buffer, `since` replay and `gap`, and control.request admission on
 * sub and call frames. Call handlers come from the kernel's WsRegistry.
 */
export class WsHub {
  readonly #deps: WsHubDeps;
  readonly #ringSize: number;
  readonly #sockets = new Set<ServerWebSocket<WsSocketData>>();
  readonly #seq = new Map<string, number>();
  readonly #buffers = new Map<string, { seq: number; name: string; data: unknown }[]>();

  constructor(deps: WsHubDeps) {
    this.#deps = deps;
    this.#ringSize = deps.ringSize ?? DEFAULT_RING;
  }

  /**
   * spec-gap: the plugin owning a "<ns>:<rest>" topic is inferred from registered
   * "<ns>.*" call handlers, then from a plugin whose default namespace matches.
   */
  ownerOf(prefixed: string): string | undefined {
    const sep = prefixed.search(/[:.]/);
    if (sep === -1) return undefined;
    const ns = prefixed.slice(0, sep);
    for (const [method, record] of this.#deps.ws.handlers()) {
      if (method.startsWith(`${ns}.`)) return record.plugin;
    }
    return this.#deps.plugins().find((p) => p.id === `valet-${ns}` || p.id === ns)?.id;
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

  open(ws: ServerWebSocket<WsSocketData>): void {
    this.#sockets.add(ws);
  }

  close(ws: ServerWebSocket<WsSocketData>): void {
    ws.data.closed = true;
    this.#sockets.delete(ws);
    ws.data.subs.clear();
  }

  /** Closes (4401) every open socket whose credential no longer identifies the same principal. */
  async reidentifySockets(): Promise<void> {
    await Promise.all(
      [...this.#sockets].map(async (ws) => {
        const { headers, url, principal } = ws.data;
        let current: Principal | undefined;
        try {
          current = await this.#deps.identify(new Request(url.href, { headers }));
        } catch (error) {
          this.#deps.logger.error("ws re-identify failed", { error: String(error) });
        }
        if (current === undefined || current.id !== principal?.id) {
          ws.data.closed = true;
          ws.data.subs.clear();
          // spec-gap: ServerFrame has no error frame, so the close code is the only signal.
          try {
            ws.close(4401, "unauthenticated");
          } catch {
            // already closing
          }
        }
      }),
    );
  }

  async message(ws: ServerWebSocket<WsSocketData>, raw: string | Buffer): Promise<void> {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as ClientFrame;
    } catch {
      send(ws, { type: "result", id: "", ok: false, error: { code: "bad_frame", message: "invalid JSON" } });
      return;
    }
    try {
      switch (frame.type) {
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
    ws: ServerWebSocket<WsSocketData>,
    kind: "ws.sub" | "ws.call",
    method: string,
    path: string,
  ): Promise<{ denied?: { by?: string; reason: string } }> {
    const owner = kind === "ws.sub" ? this.ownerOf(path) : this.#deps.ws.handlers().get(path)?.plugin;
    const res = await this.#deps.bus.emitAs(ws.data.caller, "control.request", {
      kind,
      method,
      path,
      ...(owner === undefined ? {} : { plugin: owner }),
    });
    if (!res.cancelled) return {};
    return { denied: { by: res.denied?.by, reason: res.denied?.reason ?? res.cancelReason ?? "denied" } };
  }

  async #onSub(
    ws: ServerWebSocket<WsSocketData>,
    frame: { topics: string[]; since?: Record<string, number> },
  ): Promise<void> {
    for (const topic of frame.topics ?? []) {
      const { denied } = await this.#admit(ws, "ws.sub", "sub", topic);
      if (denied) {
        // spec-gap: sub carries no id, so a denied topic reports with the topic as id.
        send(ws, {
          type: "result",
          id: topic,
          ok: false,
          error: { code: "denied", message: `${denied.by ?? "?"}: ${denied.reason}` },
        });
        continue;
      }
      const since = frame.since?.[topic];
      const buffer = this.#buffers.get(topic) ?? [];
      const latest = this.#seq.get(topic) ?? 0;
      if (since !== undefined && buffer.length > 0 && since < latest - buffer.length) {
        send(ws, { type: "gap", topic });
      } else if (since !== undefined) {
        for (const entry of buffer) {
          if (entry.seq > since) {
            send(ws, { type: "event", topic, seq: entry.seq, name: entry.name, data: entry.data });
          }
        }
      }
      ws.data.subs.add(topic);
    }
  }

  async #onCall(
    ws: ServerWebSocket<WsSocketData>,
    frame: { id: string; method: string; params?: unknown },
  ): Promise<void> {
    const handler = this.#deps.ws.handlers().get(frame.method);
    const { denied } = await this.#admit(ws, "ws.call", frame.method, frame.method);
    if (denied) {
      send(ws, {
        type: "result",
        id: frame.id,
        ok: false,
        error: { code: "denied", message: `${denied.by ?? "?"}: ${denied.reason}` },
      });
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
