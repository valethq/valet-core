import type { Resolver } from "@valethq/sdk";

export type Token = { lit: string } | { ref: string; resolver: string; arg: string };

/** Splits stored text into literals and `${resolver:arg}` refs. `$${` is a literal `${`. Throws on an unclosed ref. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let lit = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("$${", i)) {
      lit += "${";
      i += 3;
      continue;
    }
    if (text.startsWith("${", i)) {
      const end = text.indexOf("}", i + 2);
      if (end < 0) throw new Error("unclosed ${");
      const body = text.slice(i + 2, end);
      const colon = body.indexOf(":");
      if (lit) out.push({ lit });
      lit = "";
      out.push({
        ref: text.slice(i, end + 1),
        resolver: colon < 0 ? body : body.slice(0, colon),
        arg: colon < 0 ? "" : body.slice(colon + 1),
      });
      i = end + 1;
      continue;
    }
    lit += text[i];
    i += 1;
  }
  if (lit) out.push({ lit });
  return out;
}

/** True when the text holds an unescaped `${`. */
export const hasRef = (text: string): boolean => /(^|[^$])\$\{/.test(text.replaceAll("$${", ""));

export type RefTokens = Extract<Token, { ref: string }>;

/**
 * Checks a stored value against an input's `refs`: every ref names an allowed resolver, and non-string kinds hold
 * only a whole-value ref. Returns the refs, or throws with the rule (never the value).
 */
export function refsIn(text: string, allowed: Resolver[], wholeOnly: boolean): RefTokens[] {
  if (allowed.length === 0 || !hasRef(text)) return [];
  const tokens = tokenize(text);
  const refs = tokens.filter((t): t is RefTokens => "ref" in t);
  for (const r of refs) {
    if (!allowed.includes(r.resolver as Resolver))
      throw new Error(`resolver "${r.resolver}" is not allowed here (allowed: ${allowed.join(", ")})`);
    if (r.arg === "") throw new Error(`${r.ref} needs an argument`);
  }
  if (wholeOnly && (tokens.length !== 1 || refs.length !== 1))
    throw new Error("a ref must be the whole value here");
  return refs;
}

/** Joins tokens back, with refs replaced by `fill(ref)`. Literal `${` text is not re-escaped. */
export function interpolate(tokens: Token[], fill: (t: RefTokens) => string): string {
  return tokens.map((t) => ("lit" in t ? t.lit : fill(t))).join("");
}
