/**
 * Plugin-defined part types (9.4). A `custom` part's `kind` names a definition in core's part type
 * registry; core validates `data` against its schema. `title` and `text` are written with the part, so
 * any client, and the model, can show it without knowing the type.
 */
export interface PartTypeDefinition {
  /** "<plugin id>/<name>@<major>", e.g. "valet-exec/job-end@1". A published version's schema never changes. */
  id: string;
  /** What the part means, for people and other plugins. */
  description?: string;
  /** JSON schema (core's validator subset) that `data` must match. */
  schema: Record<string, unknown>;
  /** Rendering hints for clients that have no renderer for this id. */
  view?: PartTypeView;
  /** A `system` message holding this part starts a run, like a user message does. */
  wakes?: boolean;
}

export interface PartTypeView {
  /** Shown collapsed to `title` until expanded, like reasoning and tool calls. Default true. */
  collapsed?: boolean;
  level?: "info" | "warn" | "error";
  /** A short icon name; clients map what they know and ignore the rest. */
  icon?: string;
  /** Top-level `data` keys worth showing as a key/value list. */
  fields?: string[];
}

/** A registry entry. Entries outlive their plugin: reinstalling it picks the same entry back up. */
export interface PartType extends PartTypeDefinition {
  plugin: { id: string; version: string; repository?: string };
  definedAt: number;
  updatedAt: number;
}

export interface PartTypes {
  /**
   * Adds or updates one of this plugin's types; call it on every activate. The id must start with
   * "<plugin id>/". Re-defining an id with a different schema throws: bump the major instead.
   */
  define(def: PartTypeDefinition): PartType;
  get(id: string): PartType | undefined;
  list(): PartType[];
}

/** Splits "valet-exec/job-end@1" into its parts, or undefined if it isn't one. */
export function parsePartTypeId(id: string): { plugin: string; name: string; major: number } | undefined {
  const m = /^([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)@(\d+)$/.exec(id);
  if (!m) return undefined;
  return { plugin: m[1] as string, name: m[2] as string, major: Number(m[3]) };
}
