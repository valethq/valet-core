/** Path patterns with ":param" segments (10.1 HttpHost.route). */

export function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

export function matchSegments(pattern: string[], path: string[]): Record<string, string> | undefined {
  if (pattern.length !== path.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i] as string;
    const segment = path[i] as string;
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(segment);
    } else if (p !== segment) {
      return undefined;
    }
  }
  return params;
}
