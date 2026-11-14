import { randomUUID, timingSafeEqual } from "node:crypto";
import type { HttpHost } from "./http";
import type { ToolSurface } from "./inference";
import type { ToolResult } from "./tools";

/** The MCP server entry a harness connects to: Streamable HTTP, bearer token in the headers. */
export interface McpServerEntry {
  name: string;
  url: string;
  headers: Record<string, string>;
}

export interface ToolEndpointOptions {
  serverName: string;
  version: string;
  /** Reads a blob's bytes, so image results can go to the harness inline. Without it they are placeholders. */
  readBlob?(blobId: string): Promise<Uint8Array>;
}

export interface ToolEndpoint {
  /** Serves `surface` to one session at a token-guarded URL on the plugin's own route, and returns how to reach it. */
  expose(sessionId: string, surface: ToolSurface): McpServerEntry;
  /** Stops serving the session. Its token stops working. */
  revoke(sessionId: string): void;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

interface Exposure {
  token: string;
  surface: ToolSurface;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function toMcpResult(result: ToolResult, readBlob: ToolEndpointOptions["readBlob"]) {
  const content = await Promise.all(
    result.content.map(async (c) => {
      if (c.type === "text") return c;
      if (!readBlob) return { type: "text", text: `[image ${c.mime} blob ${c.blobId}]` };
      const bytes = await readBlob(c.blobId);
      return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: c.mime };
    }),
  );
  return { content, ...(result.isError ? { isError: true } : {}) };
}

/**
 * Serves a session's ToolSurface as an MCP server (Streamable HTTP, JSON replies only). Each plugin that
 * talks to an MCP-speaking harness mounts one of these on its own route, so the plugin serves the tools
 * itself and valet's core stays out of the transport.
 */
export function toolEndpoint(http: HttpHost, opts: ToolEndpointOptions): ToolEndpoint {
  const sessions = new Map<string, Exposure>();
  const bearer = (token: string) => `Bearer ${token}`;

  http.route(
    "POST",
    "/mcp/:sessionId",
    (req, { params }) => serve(req, sessions.get(params.sessionId ?? "")),
    { public: true },
  );
  http.route(
    "GET",
    "/mcp/:sessionId",
    () => new Response(null, { status: 405, headers: { allow: "POST" } }),
    {
      public: true,
    },
  );

  const serve = async (req: Request, exposure: Exposure | undefined): Promise<Response> => {
    if (!exposure || !authorized(exposure.token, req.headers.get("authorization"))) {
      return Response.json(
        { error: { code: "unauthorized", message: "bad or missing MCP token" } },
        { status: 401 },
      );
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } },
        { status: 400 },
      );
    }
    const batch = Array.isArray(body);
    const messages: unknown[] = Array.isArray(body) ? body : [body];
    const replies: unknown[] = [];
    for (const msg of messages) {
      const reply = await dispatch(exposure.surface, msg, req.signal);
      if (reply) replies.push(reply);
    }
    if (replies.length === 0) return new Response(null, { status: 202 });
    return Response.json(batch ? replies : replies[0]);
  };

  const dispatch = async (surface: ToolSurface, msg: unknown, signal: AbortSignal) => {
    const m = msg as {
      jsonrpc?: unknown;
      id?: string | number;
      method?: unknown;
      params?: Record<string, unknown>;
    };
    if (m?.jsonrpc !== "2.0" || typeof m.method !== "string") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
    }
    if (m.id === undefined) return undefined; // notification
    try {
      const result = await method(surface, m.method, m.params ?? {}, signal);
      return { jsonrpc: "2.0", id: m.id, result };
    } catch (error) {
      const code = error instanceof RpcError ? error.code : -32603;
      return {
        jsonrpc: "2.0",
        id: m.id,
        error: { code, message: error instanceof Error ? error.message : String(error) },
      };
    }
  };

  const method = async (
    surface: ToolSurface,
    name: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) => {
    switch (name) {
      case "initialize": {
        const asked = params.protocolVersion;
        return {
          protocolVersion:
            typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: opts.serverName, version: opts.version },
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: surface
            .list()
            .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        };
      case "tools/call": {
        const tool = params.name;
        if (typeof tool !== "string") throw new RpcError(-32602, "tools/call needs a tool name");
        const result = await surface.call(tool, params.arguments ?? {}, {
          callId: `mcp_${randomUUID()}`,
          signal,
        });
        return toMcpResult(result, opts.readBlob);
      }
      default:
        throw new RpcError(-32601, `method not found: ${name}`);
    }
  };

  return {
    expose(sessionId, surface) {
      const token = randomUUID();
      sessions.set(sessionId, { token, surface });
      return {
        name: opts.serverName,
        url: http.url(`/mcp/${sessionId}`),
        headers: { authorization: bearer(token) },
      };
    },
    revoke(sessionId) {
      sessions.delete(sessionId);
    },
  };
}

function authorized(token: string, header: string | null): boolean {
  if (!header) return false;
  const want = Buffer.from(bearer(token));
  const got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

const bearer = (token: string) => `Bearer ${token}`;
