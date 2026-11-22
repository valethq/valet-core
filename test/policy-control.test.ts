import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, type ControlServer, createControlServer, type ValetKernel } from "@valethq/core";

const ROOT = join(import.meta.dir, "..");
const AUTH = { authorization: "Bearer tok" };
const running: { kernel: ValetKernel; control: ControlServer; home: string }[] = [];

async function up(policy: unknown) {
  const home = mkdtempSync(join(tmpdir(), "valet-policy-e2e-"));
  writeFileSync(join(home, "policy.json"), JSON.stringify(policy));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      pluginPaths: [join(ROOT, "plugins"), join(import.meta.dir, "fixtures", "auth")],
      plugins: {
        "valet-fixture-auth": {
          config: { token: "tok", externalId: "friend", displayName: "Friend", role: "guest" },
        },
      },
    }),
  );
  const kernel = await boot({ valetHome: home, dbPath: ":memory:", out: () => {} });
  const control = createControlServer(kernel, { host: "127.0.0.1", port: 0 });
  control.start();
  running.push({ kernel, control, home });
  return { kernel, base: control.baseUrl(), home };
}

afterEach(async () => {
  for (const env of running.splice(0)) {
    env.control.stop();
    await env.kernel.shutdown();
    rmSync(env.home, { recursive: true, force: true });
  }
});

async function project(kernel: ValetKernel, name: string): Promise<{ id: string }> {
  const workspaceDir = mkdtempSync(join(tmpdir(), "ws-"));
  const created = await kernel.store.forCaller({ plugin: "core" }).projects.create({ name, workspaceDir });
  if (!("id" in created)) throw new Error("project create was cancelled");
  return created;
}
const listed = async (base: string) =>
  ((await (await fetch(`${base}/api/core/projects`, { headers: AUTH })).json()) as { name: string }[]).map(
    (p) => p.name,
  );

test("a guest granted core:project.read by policy.json reads projects; other permissions stay 403", async () => {
  const { kernel, base } = await up({
    version: 1,
    grants: [{ to: ["fixture:friend"], allow: ["core:project.read"] }],
    tests: [
      { subject: "fixture:friend", allow: ["core:project.read"], deny: ["core:project.write", "exec:run"] },
    ],
  });
  expect(kernel.plugins().find((p) => p.id === "valet-policy")?.state).toBe("active");
  await project(kernel, "alpha");

  expect(await listed(base)).toEqual(["alpha"]);
  const write = await fetch(`${base}/api/core/projects`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    body: JSON.stringify({ name: "p", workspaceDir: tmpdir() }),
  });
  expect(write.status).toBe(403);
  expect((await fetch(`${base}/api/core/config/reload`, { method: "POST", headers: AUTH })).status).toBe(403);
  expect((await fetch(`${base}/api/core/projects`)).status).toBe(401);
});

test("without the grant the guest sees nothing", async () => {
  const { kernel, base } = await up({ version: 1 });
  await project(kernel, "alpha");
  expect(await listed(base)).toEqual([]);
});

test("a project-scoped grant, written after boot, shows only that project", async () => {
  const { kernel, base, home } = await up({ version: 1 });
  const alpha = await project(kernel, "alpha");
  await project(kernel, "beta");
  expect(await listed(base)).toEqual([]);

  writeFileSync(
    join(home, "policy.json"),
    JSON.stringify({
      version: 1,
      grants: [{ to: ["fixture:friend"], allow: ["core:project.read"], on: [`project:${alpha.id}`] }],
    }),
  );
  const deadline = Date.now() + 5000;
  while ((await listed(base)).length === 0 && Date.now() < deadline) await Bun.sleep(25);
  expect(await listed(base)).toEqual(["alpha"]);
});
