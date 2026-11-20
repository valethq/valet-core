import type { UnitKind } from "./catalog";

const DURATION: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const BYTES: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};
const TOKENS: Record<string, number> = { "": 1, k: 1e3, m: 1e6 };

const NUM = String.raw`\d+(?:\.\d+)?`;

/** Patterns for the compiled schema: the unit strings each type accepts. */
export const UNIT_PATTERNS: Record<UnitKind, string> = {
  duration: `^\\s*(?:${NUM}\\s*(?:ms|s|m|h|d)\\s*)+$`,
  bytes: `^\\s*${NUM}\\s*(?:[kKmMgGtT]i?)?[bB]\\s*$`,
  tokens: `^\\s*${NUM}\\s*[kKmM]?\\s*$`,
};

/** Parses a unit string to its number (ms, bytes, tokens), or undefined when it isn't one. */
export function parseUnit(kind: UnitKind, text: string): number | undefined {
  const s = text.trim();
  if (!new RegExp(UNIT_PATTERNS[kind]).test(s)) return undefined;
  if (kind === "duration") {
    let total = 0;
    for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g))
      total += Number(m[1]) * (DURATION[m[2] as string] as number);
    return Math.round(total);
  }
  const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(s);
  if (m === null) return undefined;
  const table = kind === "bytes" ? BYTES : TOKENS;
  const factor = table[(m[2] as string).toLowerCase()];
  return factor === undefined ? undefined : Math.round(Number(m[1]) * factor);
}
