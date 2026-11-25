/**
 * Settings v3 (12.1). A plugin's manifest `settings` document describes its config and its settings UI. Core
 * compiles it into the schema it validates against, stores what a UI saves in layers, and `ctx.config` holds the
 * applied values. The `settings@2` scope is for what config can't hold: option and view sources, actions, and
 * runtime subsections whose values live in the plugin.
 */

export type SettingsSection = "system" | "inference" | "tools";

export interface SettingsDoc {
  sections: Partial<Record<SettingsSection, SectionDoc>>;
  /** Plugin-local recipes; names start with "local:". */
  types?: Record<string, InputDef>;
}

export interface SectionDoc {
  icon?: string;
  /** Within the section; lower first. */
  order?: number;
  /** At least one; shown in `order`, then listed order. */
  subsections: Subsection[];
}

export interface Subsection {
  id: string;
  label: string;
  summary?: string;
  order?: number;
  items: (Setting | Display)[];
}

export interface Setting {
  /** Config key. */
  id: string;
  label: string;
  /** One line, under the label. */
  summary?: string;
  /** Long help (markdown); falls back to summary. */
  details?: string;
  /** Value-bearing; label defaults to the setting's. */
  input: Input;
  /** Hide unless true. */
  when?: Cond;
  /** Default ["user"]. */
  scopes?: Scope[];
  /** UI hint before saving; default "live". */
  apply?: "live" | "restart";
  /** Collapsed "Advanced" block on its subsection. */
  advanced?: boolean;
  /** Shown on the setting; the setting is hidden unless a layer stores a value. */
  deprecated?: string;
  /** For settings search. */
  keywords?: string[];
  migrate?: Migration[];
}

export type Scope = "user" | "project";

export interface InputBase {
  type: string;
  /** Required inside a group (its key); unused on a setting's own input. */
  id?: string;
  label?: string;
  summary?: string;
  /** A group without one takes its inputs' defaults. */
  default?: unknown;
  required?: boolean;
  readonly?: boolean;
  when?: Cond;
  /** Which ${...} resolvers this input accepts. */
  refs?: Resolver[];
  /** cmd: cache lifetime, ms; default 60000. */
  ttl?: number;
}

export type Resolver = "secret" | "file" | "env" | "cmd";

// spec-gap: 12.1 lists only "rows" and "table" as list styles.
/** Rendering styles for a list input. */
export type ListInputStyle = "rows" | "table" | "model-catalog";

/** An input: a catalog type or a "local:" recipe, with the fields its type understands. */
export type Input = InputBase & Record<string, unknown>;

/** A recipe: a base type plus fields the base understands. Catalog derived types have the same shape. */
export type InputDef = { base: string } & Record<string, unknown>;

export type SettingsTone = "normal" | "good" | "warning" | "critical";

/** A view source for display types: the view returns the type's fields, merged over the static ones. */
export interface FromSource {
  from?: SourceRef;
  args?: Record<string, unknown | { $: Path }>;
}

interface DisplayBase {
  id?: string;
  when?: Cond;
}

/** Display types store nothing. */
export type Display =
  | (DisplayBase & { type: "heading"; text: string })
  | (DisplayBase & { type: "note"; text: string; tone?: SettingsTone })
  | (DisplayBase & { type: "divider" })
  | (DisplayBase & { type: "link"; text: string; href: string })
  | (DisplayBase & FromSource & { type: "badge"; text?: string; tone?: SettingsTone })
  | (DisplayBase & FromSource & { type: "stat"; label?: string; value?: string; caption?: string })
  | (DisplayBase &
      FromSource & {
        type: "meter";
        label?: string;
        /** Filled share of the bar, 0-100. */
        value?: number;
        display?: string;
        caption?: string;
        status?: string;
        /** Marker position on the bar, 0-100. */
        marker?: number;
        tone?: SettingsTone;
      })
  | (DisplayBase & FromSource & { type: "table"; columns?: string[]; rows?: string[][] })
  | (DisplayBase & {
      type: "action";
      text: string;
      /** Key in the plugin's `settings@2` `actions`. */
      action: string;
      args?: Record<string, unknown | { $: Path }>;
      /** Ask for confirmation with this text before running. */
      confirm?: string;
      tone?: SettingsTone;
    });

export type DisplayType = Display["type"];

export interface Option {
  value: string;
  label?: string;
  summary?: string;
  icon?: string;
  group?: string;
}
export type Options = Option[] | { from: SourceRef; args?: Record<string, unknown | { $: Path }> };
/** "name" (own plugin) or "<pluginId>/name", e.g. "valet-agent/models". */
export type SourceRef = string;

/** Into stored values: "settingId" or "settingId.key.key"; "@" / "@.key" inside a list item or map value. */
export type Path = string;
export type Cond =
  | { eq: [Path, unknown] }
  | { ne: [Path, unknown] }
  | { in: [Path, unknown[]] }
  | { set: Path }
  | { not: Cond }
  | { all: Cond[] }
  | { any: Cond[] };

export interface Migration {
  /** Another setting id, or "kv:<key>" (a plugin_kv row); omitted: this setting, in place. */
  from?: string;
  /** Value transform; omitted: copy as is. */
  map?: { template: string } | { scale: number } | { match: string } | { values: Record<string, unknown> };
}

export type SettingSource = "default" | "file" | "settings" | "project";

/** One plugin's settings as the control plane serves them (12.1). */
export interface PluginSettings {
  plugin: string;
  name?: string;
  description?: string;
  version?: string;
  provides: string[];
  state: "active" | "failed" | "disabled" | "pending";
  enabled: boolean;
  /** The manifest's doc. */
  settings?: SettingsDoc;
  /** Recipe chain for each non-primitive type used. */
  types?: Record<string, InputDef>;
  /** The compiled (or raw) configSchema. */
  schema?: Record<string, unknown>;
  /** Stored values, migrated and unit-parsed; refs stay raw. */
  values: Record<string, unknown>;
  sources: Record<string, SettingSource>;
  /** Stored, after migration. */
  layers: {
    file?: Record<string, unknown>;
    user?: Record<string, unknown>;
    project?: Record<string, unknown>;
  };
  /** The plugin has an onConfigChange listener. */
  liveConfig: boolean;
  /** Ref failures and permission warnings. */
  issues?: Record<Path, string>;
  /** Scrubbed: resolved ref values replaced by their ${...} text. */
  restartRequired?: string;
}

/** The `settings@2` scope (many, one provider per plugin, keyed by plugin id). Core never calls it. */
export interface SettingsContribution {
  options?: Record<string, (args: Record<string, unknown>) => Option[] | Promise<Option[]>>;
  /** Display type's fields. */
  views?: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>;
  actions?: Record<string, (args: Record<string, unknown>) => void | Promise<void>>;
  subsections?: () => RuntimeSubsection[] | Promise<RuntimeSubsection[]>;
}

/** Not config: values live in the plugin (a password change). Core neither stores nor validates them. */
export interface RuntimeSubsection {
  id: string;
  label: string;
  summary?: string;
  order?: number;
  /** Which of the plugin's sections it shows on; default the first in its doc. */
  section?: SettingsSection;
  items: (PanelField | Display)[];
  refreshMs?: number;
  get?(): Record<string, unknown> | Promise<Record<string, unknown>>;
  set?(values: Record<string, unknown>): void | Promise<void>;
}

/** A setting without config semantics: no scopes, migrate, refs or apply. `masked` strings never echo the stored value back. */
export interface PanelField extends Omit<Setting, "input" | "scopes" | "migrate" | "apply"> {
  input: Omit<InputBase, "refs" | "ttl"> & Record<string, unknown>;
}
