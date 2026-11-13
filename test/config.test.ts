import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultValetHome, loadConfig } from "@valethq/core";

const tempHome = () => mkdtempSync(join(tmpdir(), "valet-config-"));

describe("config", () => {
  test("missing config.json yields defaults", () => {
    const home = tempHome();
    const { configPath, config } = loadConfig(home);
    expect(configPath).toBe(join(home, "config.json"));
    expect(config.server).toEqual({ host: "127.0.0.1", port: 7417, allowedOrigins: [] });
    expect(config.pluginPaths).toEqual([join(home, "plugins"), expect.stringContaining("plugins")]);
    expect(config.plugins).toEqual({});
  });

  test("VALET_HOME overrides the home dir", () => {
    process.env.VALET_HOME = "/tmp/valet-env-home";
    try {
      expect(defaultValetHome()).toBe("/tmp/valet-env-home");
    } finally {
      delete process.env.VALET_HOME;
    }
    expect(defaultValetHome()).toBe(join(homedir(), ".valet"));
  });

  test("file values merge over defaults and ~ expands", () => {
    const home = tempHome();
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        server: { port: 8443 },
        pluginPaths: ["~/custom-plugins"],
        plugins: { "valet-x": { enabled: false, config: { a: 1 } } },
      }),
    );
    const { config } = loadConfig(home);
    expect(config.server).toEqual({ host: "127.0.0.1", port: 8443, allowedOrigins: [] });
    expect(config.pluginPaths).toEqual([join(homedir(), "custom-plugins")]);
    expect(config.plugins["valet-x"]).toEqual({ enabled: false, config: { a: 1 } });
  });

  test("invalid shape is a boot error", () => {
    const home = tempHome();
    writeFileSync(join(home, "config.json"), JSON.stringify({ server: { port: "nope" } }));
    expect(() => loadConfig(home)).toThrow(/port/);
    writeFileSync(join(home, "config.json"), "not json{");
    expect(() => loadConfig(home)).toThrow();
  });
});
