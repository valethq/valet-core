import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecrets } from "@valethq/core";
import type { Logger } from "@valethq/sdk";

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "valet-secrets-"));
  mkdirSync(join(dir, "secrets"), { recursive: true });
  return dir;
}

function capture(): { log: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    log: { debug() {}, info() {}, warn: (m) => void warnings.push(m), error() {} },
  };
}

describe("secrets", () => {
  test("file beats env var (resolution order)", async () => {
    const dir = home();
    writeFileSync(join(dir, "secrets", "api-token"), "file-secret\n", { mode: 0o600 });
    process.env.API_TOKEN = "env-secret";
    try {
      const secrets = createSecrets(dir, capture().log);
      expect(await secrets.get("api-token")).toBe("file-secret");
    } finally {
      delete process.env.API_TOKEN;
    }
  });

  test("falls back to the upper-cased env var", async () => {
    const dir = home();
    process.env.ENV_ONLY = "env-secret";
    try {
      const secrets = createSecrets(dir, capture().log);
      expect(await secrets.get("env-only")).toBe("env-secret");
    } finally {
      delete process.env.ENV_ONLY;
    }
  });

  test("missing secret is undefined and require() throws", async () => {
    const dir = home();
    const secrets = createSecrets(dir, capture().log);
    expect(await secrets.get("definitely-absent")).toBeUndefined();
    await expect(secrets.require("definitely-absent")).rejects.toThrow('missing secret "definitely-absent"');
  });

  test("warns when the file mode is not 0600 but still reads it", async () => {
    const dir = home();
    writeFileSync(join(dir, "secrets", "loose"), "loose-secret", { mode: 0o644 });
    const { log, warnings } = capture();
    const secrets = createSecrets(dir, log);
    expect(await secrets.get("loose")).toBe("loose-secret");
    expect(warnings.join("\n")).toContain("mode");
  });
});
