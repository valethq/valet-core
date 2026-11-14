import { describe, expect, test } from "bun:test";

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC replies are untyped in these tests
type Json = any;
const json = async (r: Response): Promise<Json> => r.json();
import type { HttpHost, RouteHandler, ToolSurface, ToolResult, ToolSpec } from "../src/index";
import { toolEndpoint } from "../src/index";

function fakeHttp() {
  const routes = new Map<string, RouteHandler>();
  const http: HttpHost = {
    route(method, path, handler) {
      routes.set(`${method} ${path}`, handler);
      return { dispose() {} };
    },
    url: (path) => `http://127.0.0.1:7437/plugins/test${path}`,
  };
  return { http, routes };
}

function fakeSurface(opts: { calls: unknown[] }): ToolSurface {
  const spec: ToolSpec = { name: "echo", description: "echoes", inputSchema: { type: "object" } };
  return {
    list: () => [spec],
    async authorize(_name, input) {
      return { input };
    },
    async call(name, input, call) {
      opts.calls.push({ name, input, callId: call.callId });
      if (name !== "echo") return { content: [{ type: "text", text: `unknown ${name}` }], isError: true };
      const result: ToolResult = { content: [{ type: "text", text: `echo:${JSON.stringify(input)}` }] };
      return result;
    },
  };
}

function setup() {
  const { http, routes } = fakeHttp();
  const endpoint = toolEndpoint(http, { serverName: "valet", version: "0.1.0" });
  const calls: unknown[] = [];
  const entry = endpoint.expose("ses_1", fakeSurface({ calls }));
  const post = routes.get("POST /mcp/:sessionId") as RouteHandler;
  const send = (body: unknown, headers: Record<string, string> = entry.headers) =>
    post(
      new Request(entry.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      { params: { sessionId: "ses_1" }, caller: {} as never, principal: undefined, url: new URL(entry.url) },
    );
  return { entry, routes, endpoint, calls, send };
}

describe("toolEndpoint", () => {
  test("exposes a route with a per-session URL and bearer token", () => {
    const { entry, routes } = setup();
    expect(entry.name).toBe("valet");
    expect(entry.url).toBe("http://127.0.0.1:7437/plugins/test/mcp/ses_1");
    expect(entry.headers.authorization).toMatch(/^Bearer [0-9a-f-]{36}$/);
    expect(routes.has("POST /mcp/:sessionId")).toBe(true);
    expect(routes.has("GET /mcp/:sessionId")).toBe(true);
  });

  test("initialize, tools/list and tools/call go through the surface", async () => {
    const { send, calls } = setup();
    const init: Json = await (
      await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
    ).json();
    expect(init.result.serverInfo).toEqual({ name: "valet", version: "0.1.0" });
    const list = await json(await send({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(list.result.tools).toEqual([
      { name: "echo", description: "echoes", inputSchema: { type: "object" } },
    ]);
    const called: Json = await (
      await send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { a: 1 } },
      })
    ).json();
    expect(called.result).toEqual({ content: [{ type: "text", text: 'echo:{"a":1}' }] });
    expect(calls).toEqual([{ name: "echo", input: { a: 1 }, callId: expect.stringMatching(/^mcp_/) }]);
  });

  test("image results reach the harness as base64 when a blob reader is given", async () => {
    const { http, routes } = fakeHttp();
    const endpoint = toolEndpoint(http, {
      serverName: "valet",
      version: "0.1.0",
      readBlob: async (id) => new TextEncoder().encode(`bytes-of-${id}`),
    });
    const surface: ToolSurface = {
      list: () => [{ name: "pic", description: "", inputSchema: { type: "object" } }],
      call: async () => ({ content: [{ type: "image", mime: "image/png", blobId: "blb_1" }] }),
      authorize: async (_n, input) => ({ input }),
    };
    const entry = endpoint.expose("ses_2", surface);
    const post = routes.get("POST /mcp/:sessionId") as RouteHandler;
    const res = await post(
      new Request(entry.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...entry.headers },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "pic", arguments: {} },
        }),
      }),
      { params: { sessionId: "ses_2" }, caller: {} as never, principal: undefined, url: new URL(entry.url) },
    );
    const body: Json = await json(res);
    expect(body.result.content).toEqual([
      { type: "image", data: Buffer.from("bytes-of-blb_1").toString("base64"), mimeType: "image/png" },
    ]);
  });

  test("a wrong or missing token is refused before anything runs", async () => {
    const { send, calls } = setup();
    const ping = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} } };
    expect((await send(ping, {})).status).toBe(401);
    expect((await send(ping, { authorization: "Bearer nope" })).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  test("notifications get 202, batches get an array, unknown methods are JSON-RPC errors", async () => {
    const { send } = setup();
    expect((await send({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const batch = await (
      await send([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ])
    ).json();
    expect(batch).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
    const missing = await json(await send({ jsonrpc: "2.0", id: 3, method: "resources/list" }));
    expect(missing.error.code).toBe(-32601);
  });

  test("revoke stops a session's endpoint", async () => {
    const { send, endpoint } = setup();
    endpoint.revoke("ses_1");
    expect((await send({ jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
  });
});
