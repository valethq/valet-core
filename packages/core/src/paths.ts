import { homedir } from "node:os";
import { join } from "node:path";

/** "~" and "~/x" relative to the user's home; anything else unchanged. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}
