import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type PartData, type PartType, type PartTypeDefinition, parsePartTypeId } from "@valethq/sdk";
import { validateJsonSchema } from "../jsonschema";

export interface PluginOrigin {
  id: string;
  version: string;
  repository?: string;
}

/**
 * Core's part type registry (9.4): one JSON array in <valetHome>/part-types.json. Plugins merge their
 * definitions in by id; entries are never removed, so old parts stay readable after a plugin is gone.
 */
export class PartTypeRegistry {
  readonly #path: string | null;
  readonly #types = new Map<string, PartType>();

  /** `path` null keeps the registry in memory (tests with an in-memory database). */
  constructor(path: string | null) {
    this.#path = path;
    if (!path || !existsSync(path)) return;
    const list = JSON.parse(readFileSync(path, "utf8")) as PartType[];
    for (const t of list) this.#types.set(t.id, t);
  }

  get(id: string): PartType | undefined {
    return this.#types.get(id);
  }

  list(): PartType[] {
    return [...this.#types.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  define(origin: PluginOrigin, def: PartTypeDefinition): PartType {
    const parsed = parsePartTypeId(def.id);
    if (!parsed) throw new Error(`part type id "${def.id}" is not "<plugin id>/<name>@<major>"`);
    if (parsed.plugin !== origin.id) {
      throw new Error(`plugin "${origin.id}" can't define "${def.id}": ids start with "${origin.id}/"`);
    }
    if (typeof def.schema !== "object" || def.schema === null) throw new Error(`"${def.id}" needs a schema`);
    const old = this.#types.get(def.id);
    if (old && !Bun.deepEquals(old.schema, def.schema)) {
      throw new Error(
        `"${def.id}" is already defined with another schema; define @${parsed.major + 1} instead`,
      );
    }
    const now = Date.now();
    const plugin: PartType["plugin"] = { id: origin.id, version: origin.version };
    if (origin.repository) plugin.repository = origin.repository;
    const next: PartType = {
      id: def.id,
      ...(def.description === undefined ? {} : { description: def.description }),
      schema: def.schema,
      ...(def.view === undefined ? {} : { view: def.view }),
      ...(def.wakes === undefined ? {} : { wakes: def.wakes }),
      plugin,
      definedAt: old?.definedAt ?? now,
      updatedAt: now,
    };
    if (old && Bun.deepEquals({ ...old, updatedAt: 0 }, { ...next, updatedAt: 0 })) return old;
    this.#types.set(def.id, next);
    this.#save();
    return next;
  }

  /** Throws unless a custom part names a known type owned by `writer` and its data fits the schema. */
  check(data: PartData, writer: string | undefined): void {
    if (data.type !== "custom") return;
    const t = this.#types.get(data.kind);
    if (!t) throw new Error(`unknown part type "${data.kind}"`);
    if (writer !== t.plugin.id) throw new Error(`only ${t.plugin.id} writes "${data.kind}" parts`);
    if (typeof data.title !== "string" || typeof data.text !== "string") {
      throw new Error(`"${data.kind}" part needs a string title and text`);
    }
    const errors = validateJsonSchema(data.data, t.schema).map((e) => e.replace(/^config/, "data"));
    if (errors.length > 0) throw new Error(`invalid "${data.kind}" part: ${errors.join("; ")}`);
  }

  #save(): void {
    if (!this.#path) return;
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.list(), null, 2)}\n`);
    renameSync(tmp, this.#path);
  }
}
