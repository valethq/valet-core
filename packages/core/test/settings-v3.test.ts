// biome-ignore-all lint/suspicious/noTemplateCurlyInString: settings refs are written ${resolver:arg}
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginManifest, SettingsDoc } from "@valethq/sdk";
import {
  buildModel,
  CmdCache,
  compileDoc,
  evalCond,
  migrateLayer,
  parseUnit,
  tokenize,
  typeChains,
  typeInfo,
  validateJsonSchema,
  validateValues,
} from "../src/index";

const doc = (items: unknown[], extra: Record<string, unknown> = {}): SettingsDoc =>
  ({
    sections: { system: { subsections: [{ id: "main", label: "Main", items }] } },
    ...extra,
  }) as SettingsDoc;

const manifest = (settings: SettingsDoc): PluginManifest =>
  ({
    schema: 1,
    id: "p",
    name: "P",
    version: "0.1.0",
    valet: "^0.1.0",
    main: "x",
    settings,
  }) as PluginManifest;

const docErrors = (d: unknown): string => {
  try {
    compileDoc(d);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("units", () => {
  test("durations, bytes and tokens", () => {
    expect(parseUnit("duration", "500ms")).toBe(500);
    expect(parseUnit("duration", "5m")).toBe(300_000);
    expect(parseUnit("duration", "1h30m")).toBe(5_400_000);
    expect(parseUnit("bytes", "64 KiB")).toBe(65_536);
    expect(parseUnit("bytes", "64 KB")).toBe(64_000);
    expect(parseUnit("tokens", "128k")).toBe(128_000);
    expect(parseUnit("tokens", "1m")).toBe(1_000_000);
    expect(parseUnit("duration", "5x")).toBeUndefined();
    expect(parseUnit("bytes", "lots")).toBeUndefined();
  });
});

describe("type catalog", () => {
  test("derived types follow their base chain to a primitive", () => {
    const d = typeInfo("duration");
    expect(d.chain).toEqual(["duration", "int", "number"]);
    expect(d.kind).toBe("number");
    expect(d.unit).toBe("duration");
    expect(d.preset).toEqual({ integer: true });
    expect(typeInfo("ref").chain).toEqual(["ref", "select", "string"]);
    expect(typeInfo("color").preset.pattern).toBe("^#[0-9a-fA-F]{6}$");
  });

  test("local recipes extend catalog types; chains are published for UIs", () => {
    const local = { "local:hostport": { base: "strict_string", pattern: "^x$" } };
    expect(typeInfo("local:hostport", local).chain).toEqual(["local:hostport", "strict_string", "string"]);
    expect(typeChains(["local:hostport", "tokens"], local)).toEqual({
      "local:hostport": { base: "strict_string", pattern: "^x$" },
      strict_string: { base: "string" },
      tokens: { base: "int" },
      int: { base: "number", integer: true },
    });
    expect(() => typeInfo("fancy")).toThrow('unknown type "fancy"');
    expect(() => typeInfo("local:a", { "local:a": { base: "local:a" } })).toThrow("cycle");
  });
});

describe("document checks", () => {
  test("a good document compiles", () => {
    const c = compileDoc(
      doc([
        { id: "a", label: "A", input: { type: "bool" } },
        { type: "note", text: "x" },
      ]),
    );
    expect([...c.settings.keys()]).toEqual(["a"]);
  });

  test("malformed documents list every problem", () => {
    const msg = docErrors(
      doc([
        { id: "enabled", label: "E", input: { type: "bool" } },
        { id: "a.b", label: "Dot", input: { type: "bool" } },
        { id: "x", label: "X", input: { type: "bool", colour: "red" } },
        { id: "x", label: "X again", input: { type: "bool" } },
        { id: "p", label: "P", input: { type: "bool" }, scopes: ["project"] },
        { id: "r", label: "R", input: { type: "ref", options: [] } },
        { id: "g", label: "G", input: { type: "group", inputs: [{ type: "bool" }] } },
        {
          id: "m",
          label: "M",
          input: { type: "map", key: { type: "string", refs: ["env"] }, value: { type: "bool" } },
        },
      ]),
    );
    for (const part of [
      '"enabled" is reserved',
      "id must match",
      'field "colour" is not understood by "bool"',
      'duplicate setting "x"',
      'scopes must include "user"',
      "a ref input needs options.from",
      "needs an id",
      "a map key takes no refs",
    ])
      expect(msg).toContain(part);
    expect(docErrors({ sections: { system: { subsections: [] } } })).toContain("at least one subsection");
    expect(
      docErrors({ sections: { misc: { subsections: [{ id: "a", label: "A", items: [] }] } } }),
    ).toContain("sections are system, inference and tools");
  });

  test("a condition on a ref-bearing input may only use set", () => {
    const items = (when: unknown) => [
      { id: "key", label: "K", input: { type: "string", refs: ["env"] } },
      { id: "x", label: "X", input: { type: "bool" }, when },
    ];
    expect(docErrors(doc(items({ eq: ["key", "a"] })))).toContain("may only use set");
    expect(docErrors(doc(items({ set: "key" })))).toBe("");
    expect(docErrors(doc(items({ set: "nope" })))).toContain('path "nope" does not name an input');
  });

  test("a recipe may only set fields its base understands", () => {
    expect(docErrors(doc([], { types: { "local:x": { base: "bool", pattern: "x" } } }))).toContain(
      'field "pattern" is not understood by "bool"',
    );
    expect(docErrors(doc([], { types: { hostport: { base: "string" } } }))).toContain('start with "local:"');
  });

  test("a default that fails its own input fails the document", () => {
    expect(() =>
      buildModel(manifest(doc([{ id: "n", label: "N", input: { type: "int", max: 3, default: 9 } }]))),
    ).toThrow("default n: must be at most 3");
  });
});

describe("compiled schema", () => {
  const model = buildModel(
    manifest(
      doc([
        { id: "pct", label: "P", input: { type: "percent", exclusiveMin: 0, max: 1, step: 0.05 } },
        { id: "range", label: "R", input: { type: "range" } },
        { id: "url", label: "U", input: { type: "url", schemes: ["https"] } },
        { id: "color", label: "C", input: { type: "color" } },
        { id: "tags", label: "T", input: { type: "multiselect", options: [{ value: "a" }], max: 1 } },
        {
          id: "aliases",
          label: "A",
          input: {
            type: "map",
            key: { type: "strict_string", pattern: "^[a-z]+$" },
            value: { type: "string" },
          },
        },
        {
          id: "v",
          label: "V",
          input: {
            type: "variant",
            tag: "kind",
            cases: [
              { value: "a", inputs: [{ id: "n", type: "int" }] },
              { value: "b", inputs: [] },
            ],
          },
        },
        { id: "port", label: "Port", input: { type: "int", refs: ["env"] } },
        { id: "key", label: "Key", input: { type: "secret" } },
        { id: "t", label: "T", input: { type: "duration" } },
      ]),
    ),
  );
  const errs = (values: Record<string, unknown>) => validateValues(model, values);

  test("every declared constraint is enforced", () => {
    expect(errs({ pct: 0 })).toEqual({ pct: "must be greater than 0" });
    expect(errs({ pct: 0.33 })).toEqual({ pct: "must be a multiple of 0.05" });
    expect(errs({ range: [3, 1] })).toEqual({ range: "lower bound must not exceed upper bound" });
    expect(errs({ url: "http://x" })).toEqual({ url: "scheme must be one of https" });
    expect(errs({ color: "red" })).toEqual({ color: "must match #rrggbb" });
    expect(errs({ tags: ["a", "a"] })).toEqual({ tags: "must have at most 1 items" });
    expect(errs({ tags: ["z"] })).toEqual({ "tags[0]": 'not in enum ["a"]' });
    expect(errs({ aliases: { BAD: "x" } })).toEqual({ 'aliases["BAD"]': "must match ^[a-z]+$" });
    expect(errs({ v: { kind: "c" } })).toEqual({ "v.kind": 'must be one of ["a","b"]' });
    expect(errs({ v: { kind: "b", n: 1 } })).toEqual({ v: 'unexpected property "n"' });
    expect(errs({ v: { kind: "a", n: 1 } })).toEqual({});
    expect(errs({ nope: 1 })).toEqual({ nope: "unknown setting" });
    expect(errs({ t: "5x" })).toEqual({ t: "not a valid duration string" });
  });

  test("refs: whole value for non-strings, resolver must be listed, secret takes only secret refs", () => {
    expect(errs({ port: "${env:PORT}" })).toEqual({});
    expect(errs({ port: "80${env:PORT}" })).toEqual({ port: "a ref must be the whole value here" });
    expect(errs({ port: "${file:/x}" })).toEqual({
      port: 'resolver "file" is not allowed here (allowed: env)',
    });
    expect(errs({ key: "${secret:my_key}" })).toEqual({});
    expect(Object.keys(errs({ key: "hunter2" }))).toEqual(["key"]);
    expect(Object.keys(errs({ key: "${env:X}" }))).toEqual(["key"]);
  });

  test("the published schema accepts stored forms", () => {
    const schema = model.schema as Record<string, unknown>;
    expect(validateJsonSchema({ t: "1h30m", port: "${env:PORT}" }, schema)).toEqual([]);
    expect(validateJsonSchema({ t: 5 }, schema)).toEqual([]);
  });
});

describe("conditions", () => {
  const root = { mode: "advanced", g: { a: 1 }, nil: null, ref: "${env:X}" };
  test("eq / ne / in / set / not / all / any on stored text", () => {
    expect(evalCond({ eq: ["mode", "advanced"] }, root)).toBe(true);
    expect(evalCond({ eq: ["g.a", 1] }, root)).toBe(true);
    expect(evalCond({ ne: ["missing", 1] }, root)).toBe(true);
    expect(evalCond({ eq: ["missing", null] }, root)).toBe(false);
    expect(evalCond({ in: ["mode", ["basic", "advanced"]] }, root)).toBe(true);
    expect(evalCond({ set: "nil" }, root)).toBe(false);
    expect(evalCond({ set: "ref" }, root)).toBe(true);
    expect(evalCond({ not: { set: "missing" } }, root)).toBe(true);
    expect(evalCond({ all: [{ set: "mode" }, { set: "nil" }] }, root)).toBe(false);
    expect(evalCond({ any: [{ set: "mode" }, { set: "nil" }] }, root)).toBe(true);
    expect(evalCond({ eq: ["@.k", 2] }, root, { k: 2 })).toBe(true);
  });

  test("required holds only where when does, at every depth", () => {
    const model = buildModel(
      manifest(
        doc([
          { id: "mode", label: "M", input: { type: "select", options: [{ value: "a" }, { value: "b" }] } },
          { id: "need", label: "N", input: { type: "string", required: true }, when: { eq: ["mode", "b"] } },
          {
            id: "list",
            label: "L",
            input: {
              type: "list",
              item: {
                type: "group",
                inputs: [
                  { id: "on", type: "bool" },
                  { id: "name", type: "string", required: true, when: { eq: ["@.on", true] } },
                ],
              },
            },
          },
          { id: "old", label: "O", input: { type: "string", required: true }, deprecated: "gone" },
        ]),
      ),
    );
    expect(validateValues(model, { mode: "a" })).toEqual({});
    expect(validateValues(model, { mode: "b" })).toEqual({ need: "required" });
    expect(validateValues(model, { list: [{ on: false }, { on: true }] })).toEqual({
      "list[1].name": "required",
    });
  });
});

describe("refs", () => {
  test("tokenize: refs end at the first }, $${ is a literal ${", () => {
    expect(tokenize("Bearer ${secret:k}!")).toEqual([
      { lit: "Bearer " },
      { ref: "${secret:k}", resolver: "secret", arg: "k" },
      { lit: "!" },
    ]);
    expect(tokenize("$${env:X}")).toEqual([{ lit: "${env:X}" }]);
    expect(() => tokenize("${env:X")).toThrow("unclosed");
  });

  test("cmd cache: TTL, failures cached, last good value kept through drops", async () => {
    const home = mkdtempSync(join(tmpdir(), "valet-cmd-"));
    const changes: string[] = [];
    const cache = new CmdCache(home, (ref) => void changes.push(ref));
    expect(cache.read("${cmd:echo hi}", "echo hi", 60_000)).toEqual({});
    await cache.settle();
    expect(cache.read("${cmd:echo hi}", "echo hi", 60_000)).toEqual({ value: "hi" });
    expect(changes).toEqual(["${cmd:echo hi}"]);
    cache.drop("${cmd:echo hi}");
    expect(cache.read("${cmd:echo hi}", "echo hi", 60_000)).toEqual({ value: "hi" });
    await cache.settle();
    expect(changes).toHaveLength(1);

    expect(cache.read("${cmd:exit 3}", "exit 3", 60_000)).toEqual({});
    await cache.settle();
    expect(cache.read("${cmd:exit 3}", "exit 3", 60_000)).toEqual({ error: "${cmd:exit 3} exited with 3" });
    await cache.settle();
    expect(cache.failures().size).toBe(1);

    const slow = new CmdCache(home, () => {}, 50);
    slow.read("${cmd:sleep 5}", "sleep 5", 0);
    await slow.settle();
    expect(slow.read("${cmd:sleep 5}", "sleep 5", 60_000).error).toContain("timed out");
  });
});

describe("migration", () => {
  const model = buildModel(
    manifest(
      doc([
        {
          id: "utility",
          label: "U",
          input: {
            type: "group",
            inputs: [
              { id: "model", type: "string" },
              { id: "effort", type: "string" },
            ],
          },
          migrate: [{ map: { match: "^(?<model>.*?)(?:-(?<effort>low|high))?$" } }],
        },
        {
          id: "apiKey",
          label: "K",
          input: { type: "secret" },
          migrate: [{ from: "secret", map: { template: "${secret:{}}" } }],
        },
        {
          id: "at",
          label: "A",
          input: { type: "percent" },
          migrate: [{ from: "pct", map: { scale: 0.01 } }],
        },
        {
          id: "mode",
          label: "M",
          input: { type: "string" },
          migrate: [{ from: "old", map: { values: { y: "yes" } } }],
        },
        { id: "wait", label: "W", input: { type: "duration" }, migrate: [{ map: { scale: 1 } }] },
        { id: "note", label: "N", input: { type: "string" }, migrate: [{ from: "kv:note" }] },
      ]),
    ),
  );

  test("in place, renamed, scaled, templated and looked up", () => {
    const r = migrateLayer(model, { utility: "gpt-5-high", secret: "k", pct: 80, old: "y" });
    expect(r.layer).toEqual({
      utility: { model: "gpt-5", effort: "high" },
      apiKey: "${secret:k}",
      at: 0.8,
      mode: "yes",
    });
    expect(r.changed).toBe(true);
    expect(migrateLayer(model, { utility: "" }).layer).toEqual({ utility: { model: "" } });
    expect(migrateLayer(model, { utility: "plain" }).layer).toEqual({ utility: { model: "plain" } });
  });

  test("triggers are unambiguous: accepted stored forms and new-shape values never migrate", () => {
    const r = migrateLayer(model, { utility: { model: "x" }, wait: "5m" });
    expect(r.changed).toBe(false);
    expect(r.layer).toEqual({ utility: { model: "x" }, wait: "5m" });
  });

  test("an existing new key wins; unlisted lookups are dropped with a warning", () => {
    const r = migrateLayer(model, { secret: "k", apiKey: "${secret:new}", old: "n" });
    expect(r.layer).toEqual({ apiKey: "${secret:new}" });
    expect(r.warnings.join("\n")).toContain('secret: dropped, "apiKey" already has a value');
    expect(r.warnings.join("\n")).toContain("old: value could not be migrated");
  });

  test("a from key is looked up only among the layer's own keys", () => {
    const m = buildModel(
      manifest(doc([{ id: "s", label: "S", input: { type: "string" }, migrate: [{ from: "toString" }] }])),
    );
    expect(migrateLayer(m, {})).toMatchObject({ layer: {}, changed: false, warnings: [] });
  });

  test("kv rows move into the layer", () => {
    const r = migrateLayer(model, {}, (k) => (k === "note" ? "hello" : undefined));
    expect(r.layer).toEqual({ note: "hello" });
    expect(r.kvMoved).toEqual(["note"]);
  });
});
