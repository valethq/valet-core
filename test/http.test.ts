import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerFrame } from "@valethq/sdk";
import { boot, type ValetKernel } from "@valethq/core";

const FIXTURES = join(import.meta.dir, "fixtures");
const HTTP_PLUGIN = join(import.meta.dir, "..", "plugins", "http");
const AUTH = { authorization: "Bearer tok" };

const running: { kernel: ValetKernel; home: string }[] = [];
afterEach(async () => {
  for (const env of running.splice(0)) {
    await env.kernel.shutdown();
    rmSync(env.home, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  await s.stop(true);
  return port;
}

async function up(config: Record<string, unknown>): Promise<ValetKernel> {
  const home = mkdtempSync(join(tmpdir(), "valet-http-"));
  const plugins = join(home, "first-party");
  mkdirSync(plugins);
  symlinkSync(HTTP_PLUGIN, join(plugins, "http"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      ...config,
      pluginPaths: [join(FIXTURES, "auth"), join(FIXTURES, "routes"), plugins],
      plugins: {
        "valet-fixture-auth": { config: { token: "tok" } },
        ...(config.plugins as Record<string, unknown> | undefined),
      },
    }),
  );
  const kernel = await boot({ valetHome: home, dbPath: ":memory:", out: () => {} });
  running.push({ kernel, home });
  return kernel;
}

describe("valet-http (transport@1)", () => {
  test("serves the control plane through ctx.control with CSP, CORS and the html guard", async () => {
    const port = await freePort();
    const kernel = await up({
      plugins: { "valet-http": { config: { host: "127.0.0.1", port, allowedOrigins: ["https://ui.test"] } } },
    });
    expect(kernel.plugins().find((p) => p.id === "valet-http")?.state).toBe("active");
    expect(kernel.scopes.providers("transport").map((p) => p.plugin)).toEqual(["valet-http"]);
    const base = `http://127.0.0.1:${port}`;
    expect(kernel.http.forPlugin("valet-x").url("/hook")).toBe(`${base}/plugins/valet-x/hook`);

    const status = await fetch(`${base}/`);
    expect(status.status).toBe(200);
    expect(status.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect((await fetch(`${base}/api/core/projects`)).status).toBe(401);
    const listed = await fetch(`${base}/api/core/projects`, {
      headers: { ...AUTH, origin: "https://ui.test" },
    });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("access-control-allow-origin")).toBe("https://ui.test");
    expect((await fetch(`${base}/`, { headers: { origin: "https://evil.test" } })).status).toBe(403);
    expect((await fetch(`${base}/plugins/valet-fixture-routes/page`, { headers: AUTH })).status).toBe(500);

    const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: AUTH });
    const frames: ServerFrame[] = [];
    sock.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data)) as ServerFrame));
    await new Promise((resolve) => sock.addEventListener("open", resolve, { once: true }));
    sock.send(JSON.stringify({ type: "sub", topics: ["plugins"], since: { plugins: 0 } }));
    sock.send("not json");
    sock.send(JSON.stringify({ type: "ping" }));
    for (let i = 0; i < 100 && !frames.some((f) => f.type === "pong"); i++) await Bun.sleep(10);
    expect(frames.some((f) => f.type === "event" && f.topic === "plugins")).toBe(true);
    expect(frames.some((f) => f.type === "result" && !f.ok && f.error.code === "bad_frame")).toBe(true);
    sock.close();

    const anon = await fetch(`${base}/ws`, { headers: { upgrade: "websocket" } });
    expect(anon.status).toBe(401);
  });

  test("with no config of its own it takes over the legacy server block", async () => {
    const port = await freePort();
    const kernel = await up({ server: { port, allowedOrigins: ["https://legacy.test"] } });
    expect(kernel.plugins().find((p) => p.id === "valet-http")?.state).toBe("active");
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { origin: "https://legacy.test" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://legacy.test");
  });

  test("an invalid listener config fails the plugin instead of listening somewhere unexpected", async () => {
    const kernel = await up({ plugins: { "valet-http": { config: { host: "" } } } });
    expect(kernel.plugins().find((p) => p.id === "valet-http")?.state).toBe("failed");
    expect(kernel.scopes.providers("transport")).toEqual([]);
  });

  test("valet start does not open the built-in listener while a transport is active", async () => {
    const [httpPort, builtInPort] = [await freePort(), await freePort()];
    const home = mkdtempSync(join(tmpdir(), "valet-http-cli-"));
    const plugins = join(home, "first-party");
    mkdirSync(plugins);
    symlinkSync(HTTP_PLUGIN, join(plugins, "http"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        server: { port: builtInPort },
        pluginPaths: [plugins],
        plugins: { "valet-http": { config: { port: httpPort } } },
      }),
    );
    const cli = join(import.meta.dir, "..", "packages", "core", "src", "cli.ts");
    const proc = Bun.spawn(["bun", cli, "start", "--home", home], { stdout: "ignore", stderr: "ignore" });
    try {
      let ok = false;
      for (let i = 0; i < 100 && !ok; i++) {
        ok = await fetch(`http://127.0.0.1:${httpPort}/`).then(
          (r) => r.status === 200,
          () => false,
        );
        if (!ok) await Bun.sleep(50);
      }
      expect(ok).toBe(true);
      expect(
        await fetch(`http://127.0.0.1:${builtInPort}/`).then(
          () => "open",
          () => "closed",
        ),
      ).toBe("closed");
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
