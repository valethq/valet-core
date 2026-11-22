import type { Server, ServerWebSocket } from "bun";
import {
  type ClientFrame,
  type ControlChannel,
  type ControlPlane,
  ControlRefusedError,
  type Logger,
} from "@valethq/sdk";
import type { Listen } from "./config";

const CSP = "default-src 'none'";

interface SocketData {
  channel: ControlChannel;
}

export interface Listener {
  readonly port: number;
  baseUrl(): string;
  stop(): void;
}

const error = (status: number, code: string, message: string): Response =>
  Response.json({ error: { code, message } }, { status });

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
 * Bun.serve for the control plane: bind, CORS for `allowedOrigins`, the CSP header, the text/html guard and
 * WebSocket framing. Every request goes to `control.dispatch`, every socket to `control.connect`; nothing here
 * decides who may do what.
 */
export function listen(control: ControlPlane, cfg: Listen, log: Logger, origins: () => string[]): Listener {
  const allowed = (origin: string | null): boolean => origin !== null && origins().includes(origin);

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
    if (req.method === "OPTIONS" && req.headers.has("access-control-request-method")) {
      if (!allowed(origin)) return finalize(error(403, "forbidden", "origin not allowed"), origin);
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
      return finalize(error(403, "forbidden", "origin not allowed"), origin);

    if (path === "/ws") {
      let channel: ControlChannel;
      try {
        channel = await control.connect(req);
      } catch (err) {
        if (err instanceof ControlRefusedError) return finalize(err.response, origin);
        throw err;
      }
      if (srv.upgrade(req, { data: { channel } })) return undefined;
      channel.close();
      return finalize(error(400, "bad_request", "websocket upgrade required"), origin);
    }

    const res = await control.dispatch(req);
    if (path.startsWith("/plugins/") && res.headers.get("content-type")?.includes("text/html")) {
      log.error("route returned text/html", { path });
      return finalize(error(500, "html_not_allowed", "control plane does not serve HTML"), origin);
    }
    return finalize(res, origin);
  }

  const server = Bun.serve<SocketData>({
    hostname: cfg.host,
    port: cfg.port,
    fetch: (req, srv) =>
      onRequest(req, srv).catch((err: unknown) => {
        log.error("request failed", { error: String(err) });
        return finalize(error(500, "internal", "internal error"), req.headers.get("origin"));
      }),
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
  const display = cfg.host === "0.0.0.0" || cfg.host === "::" ? "127.0.0.1" : cfg.host;
  return {
    get port() {
      return server.port ?? cfg.port;
    },
    baseUrl: () => `http://${display.includes(":") ? `[${display}]` : display}:${server.port}`,
    stop: () => void server.stop(true),
  };
}
