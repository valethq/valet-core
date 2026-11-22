import type { Server, ServerWebSocket } from "bun";
import { type ClientFrame, type ControlChannel, ControlRefusedError, type Logger } from "@valethq/sdk";
import type { ValetKernel } from "../kernel";
import { errorJson } from "./rest";

const CSP = "default-src 'none'";

export interface ControlServerOptions {
  /** Overrides config.server.host/port (tests bind port 0). */
  host?: string;
  port?: number;
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

interface SocketData {
  channel: ControlChannel;
}

const sendFrame = (ws: ServerWebSocket<SocketData>, frame: unknown): void => {
  try {
    // send() === 0 means the frame was dropped; close so the client resumes via `since` instead of missing it.
    if (ws.send(JSON.stringify(frame)) === 0) {
      ws.data.channel.close();
      ws.close(1011, "send dropped");
    }
  } catch {
    // socket closing
  }
};

/**
 * The built-in listener: a transport over `kernel.control` kept for installs with no `transport@1` provider
 * (spec-gap: retired only once a recovery CLI exists). It owns Bun.serve, CORS with `server.allowedOrigins`, the CSP
 * header, the text/html guard and WebSocket framing; every decision is core's `dispatch`/`connect`.
 */
export function createControlServer(kernel: ValetKernel, opts: ControlServerOptions = {}): ControlServer {
  const log = opts.logger ?? kernel.log.forPlugin("control");
  let server: Server<SocketData> | undefined;
  let host = "127.0.0.1";
  const allowed = (origin: string | null): boolean =>
    origin !== null && kernel.config.server.allowedOrigins.includes(origin);

  /** Every response gets the control-plane CSP; allowed origins get credentialed CORS. */
  const finalize = (res: Response, origin: string | null): Response => {
    const headers = new Headers(res.headers);
    headers.set("content-security-policy", CSP);
    if (allowed(origin)) {
      headers.set("access-control-allow-origin", origin as string);
      headers.set("access-control-allow-credentials", "true");
      headers.set("vary", "Origin");
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  async function onRequest(req: Request, srv: Server<SocketData>): Promise<Response | undefined> {
    const path = new URL(req.url).pathname;
    const origin = req.headers.get("origin");

    // CORS preflight (10.1): handled before identity; disallowed origins are refused.
    if (req.method === "OPTIONS" && req.headers.has("access-control-request-method")) {
      if (!allowed(origin)) return finalize(errorJson(403, "forbidden", "origin not allowed"), origin);
      return finalize(
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "access-control-allow-headers":
              req.headers.get("access-control-request-headers") ?? "authorization, content-type",
            "access-control-max-age": "600",
          },
        }),
        origin,
      );
    }
    if (origin !== null && !allowed(origin))
      return finalize(errorJson(403, "forbidden", "origin not allowed"), origin);

    if (path === "/ws") {
      let channel: ControlChannel;
      try {
        channel = await kernel.control.connect(req);
      } catch (error) {
        if (error instanceof ControlRefusedError) return finalize(error.response, origin);
        throw error;
      }
      if (srv.upgrade(req, { data: { channel } })) return undefined;
      channel.close();
      return finalize(errorJson(400, "bad_request", "websocket upgrade required"), origin);
    }

    const res = await kernel.control.dispatch(req);
    // 10.1: a plugin route answering text/html is a 500 plus a log line.
    if (res.headers.get("content-type")?.includes("text/html")) {
      log.error("route returned text/html", { path });
      return finalize(errorJson(500, "html_not_allowed", "control plane does not serve HTML"), origin);
    }
    return finalize(res, origin);
  }

  return {
    start(): void {
      host = opts.host ?? kernel.config.server.host;
      const port = opts.port ?? kernel.config.server.port;
      server = Bun.serve<SocketData>({
        hostname: host,
        port,
        fetch: (req, srv) => onRequest(req, srv),
        websocket: {
          open(ws) {
            ws.data.channel.onFrame((frame) => sendFrame(ws, frame));
            ws.data.channel.onClose((code, reason) => {
              try {
                ws.close(code, reason);
              } catch {
                // already closing
              }
            });
          },
          message(ws, msg) {
            let frame: ClientFrame;
            try {
              frame = JSON.parse(typeof msg === "string" ? msg : msg.toString("utf8")) as ClientFrame;
            } catch {
              sendFrame(ws, {
                type: "result",
                id: "",
                ok: false,
                error: { code: "bad_frame", message: "invalid JSON" },
              });
              return;
            }
            ws.data.channel.send(frame);
          },
          close: (ws) => ws.data.channel.close(),
        },
      });
      log.info("control plane listening", { host, port: server.port });
    },

    stop(): void {
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

    publish: (topic, name, data) => kernel.control.publish(topic, name, data),
  };
}
