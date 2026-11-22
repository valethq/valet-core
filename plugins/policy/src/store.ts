import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePolicy } from "./parse";
import type { PolicyFile } from "./types";

const file = (dir: string) => join(dir, "last-good.json");

export async function saveLastGood(dir: string, policy: PolicyFile): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = `${file(dir)}.tmp`;
  await writeFile(tmp, JSON.stringify(policy, null, 2));
  await rename(tmp, file(dir));
}

export async function loadLastGood(dir: string): Promise<PolicyFile | undefined> {
  try {
    return parsePolicy(await readFile(file(dir), "utf8"));
  } catch {
    return undefined;
  }
}
