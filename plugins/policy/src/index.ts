import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { definePlugin, type PluginContext } from "@valethq/sdk";
import type { CheckEnv } from "./check";
import { evaluate } from "./check";
import { type CompiledPolicy, compile, warnings } from "./compile";
import { parsePolicy } from "./parse";
import { loadLastGood, saveLastGood } from "./store";
import { runTests } from "./tests";
import { emptyPolicyFile } from "./types";

type Mode = "policy" | "last-good" | "defaults";
interface Active {
  mode: Mode;
  policy: CompiledPolicy;
}

const DEBOUNCE_MS = 100;

export default definePlugin({
  async activate(ctx: PluginContext) {
    const { log } = ctx;
    const path = join(ctx.paths.valetHome, "policy.json");
    const env: CheckEnv = {
      by: ctx.plugin.id,
      identities: (id) => ctx.store.principals.identities(id),
      defaultTier: (permission) => ctx.acl.permission(permission)?.default ?? "owner",
    };
    const store = { role: (id: string) => ctx.store.principals.get(id)?.role };
    let active: Active = { mode: "defaults", policy: compile(emptyPolicyFile()) };

    const guard = async (what: string, emit: () => Promise<unknown>) => {
      try {
        await emit();
      } catch (error) {
        log.error(`emit ${what} failed`, { error: String(error) });
      }
    };
    const changed = (mode: Mode, reason?: string) =>
      guard("policy.changed", () =>
        ctx.events.emit("policy.changed", reason === undefined ? { mode } : { mode, reason }),
      );

    async function read(): Promise<string> {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
        throw error;
      }
    }

    async function attempt(): Promise<string | undefined> {
      try {
        const file = parsePolicy(await read());
        const policy = compile(file);
        const failures = runTests(policy, env, store, file.tests);
        if (failures.length > 0) throw new Error(`policy tests failed: ${failures.join("; ")}`);
        for (const w of warnings(file, {
          permissions: ctx.acl.names(),
          hasPrincipal: (id) => ctx.store.principals.get(id) !== undefined,
        }))
          log.warn(w);
        active = { mode: "policy", policy };
        await saveLastGood(ctx.paths.data, file);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }

    async function load(): Promise<void> {
      const reason = await attempt();
      if (reason === undefined) {
        log.info("policy loaded", { path });
        await changed("policy");
        return;
      }
      log.error("policy rejected", { reason });
      await guard("policy.rejected", () => ctx.events.emit("policy.rejected", { reason }));
      if (active.mode === "defaults") {
        const lastGood = await loadLastGood(ctx.paths.data);
        if (lastGood !== undefined) active = { mode: "last-good", policy: compile(lastGood) };
      } else active = { mode: "last-good", policy: active.policy };
      if (active.mode === "defaults")
        log.warn("no last-good policy: deployment entered defaults mode (role defaults only)", { reason });
      else log.warn("keeping the last good policy", { reason });
      await changed(active.mode, reason);
    }

    let queue = Promise.resolve();
    const reload = (): Promise<void> => {
      queue = queue.then(load).catch((error) => log.error("policy reload failed", { error: String(error) }));
      return queue;
    };

    await reload();

    ctx.scopes.provide("policy", {
      check: (subject, permission, resource, action) =>
        evaluate(active.policy, env, subject, permission, resource, action),
    });
    ctx.onConfigChange(() => reload());

    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(ctx.paths.valetHome, { persistent: false }, (_event, filename) => {
      if (filename !== null && filename !== "policy.json") return;
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), DEBOUNCE_MS);
    });
    watcher.on("error", (error) => log.error("policy watch failed", { error: String(error) }));
    ctx.onDispose(() => {
      clearTimeout(timer);
      watcher.close();
    });
  },
});
