/**
 * Settings (12.1). A plugin's settings are its config: the manifest's `configSchema` describes them, core stores
 * what a UI saves, and `ctx.config` always holds the effective values. The `settings` scope below is for what
 * config can't express: live view blocks, actions, and forms whose values are not config (a password change).
 */

/**
 * UI hints a settings schema may carry next to standard JSON Schema (title, description, default, enum,
 * minimum, maximum, readOnly, format "password"). Core ignores them; a UI uses the ones it knows.
 */
export interface SettingsSchemaHints {
  /** Labels for `enum` values, in the same order. */
  enumNames?: string[];
  /**
   * A control richer than the type implies. Known to valet-ui: "textarea", "secret" (the value names a secret
   * the UI can set), "model" (a ModelRef), "models" (valet-agent's model catalog), "segmented".
   */
  "x-widget"?: string;
  /** Kept in the page's collapsed Advanced section. */
  "x-advanced"?: boolean;
  /** A heading the field is grouped under on its page. */
  "x-section"?: string;
  /** Top-level properties only: show the field on another of the plugin's pages (an `x-pages` id). */
  "x-page"?: string;
}

/** Group a settings page is listed under. */
export type SettingsGroup = "models" | "providers" | "tools" | "system";

export interface SettingsPageInfo {
  title: string;
  description?: string;
  group?: SettingsGroup;
  /** An icon name; UIs map the ones they know. */
  icon?: string;
  /** Sort key within its group; lower first. */
  order?: number;
}

/**
 * Hints on the root of a configSchema. Without `x-group` a UI derives one from the manifest's `provides`:
 * inference providers under "providers", tool-only plugins under "tools", the rest under "system".
 */
export interface SettingsRootHints {
  "x-group"?: SettingsGroup;
  "x-icon"?: string;
  "x-order"?: number;
  /** Extra pages the plugin's settings split into, by id. */
  "x-pages"?: Record<string, SettingsPageInfo>;
}

export type SettingsTone = "normal" | "good" | "warning" | "critical";

/** Declarative view data. The UI owns all rendering; a block carries values, never markup. */
export type SettingsBlock =
  | { type: "text"; text: string; tone?: SettingsTone }
  | { type: "badge"; text: string; tone?: SettingsTone }
  | { type: "stat"; label: string; value: string; caption?: string }
  | {
      type: "meter";
      label: string;
      /** Filled share of the bar, 0-100. */
      value: number;
      /** Headline text, e.g. "44% left". */
      display?: string;
      /** Small line under the headline, e.g. "+56% in 2h 0m". */
      caption?: string;
      /** Short status at the top right, e.g. "On pace". */
      status?: string;
      /** Marker position on the bar, 0-100 (e.g. where a steady pace would be now). */
      marker?: number;
      tone?: SettingsTone;
    }
  | { type: "table"; columns: string[]; rows: string[][] }
  | {
      type: "button";
      label: string;
      /** Key in `SettingsPanel.actions`. */
      action: string;
      args?: Record<string, unknown>;
      /** Ask for confirmation with this text before running. */
      confirm?: string;
      tone?: SettingsTone;
    }
  | { type: "group"; title?: string; layout?: "stack" | "row"; blocks: SettingsBlock[] };

export type SettingsAction = (args: Record<string, unknown>) => void | Promise<void>;

/**
 * A panel on the `settings` scope: read-only `view` blocks, actions, an editable form (`schema`, `get`, `set`)
 * for values that are not config, or a mix. It shows on its plugin's settings page, above the config form.
 */
export interface SettingsPanel {
  title: string;
  description?: string;
  /** One of the plugin's `x-pages` ids to show on instead of its main page. */
  page?: string;
  /** JSON Schema describing the editable values; the UI renders its form from it. */
  schema?: Record<string, unknown>;
  get?(): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Applies and persists the values. Throw to reject; the message is shown in the UI. */
  set?(values: Record<string, unknown>): void | Promise<void>;
  /** Called on every fetch, so the blocks can reflect current state. */
  view?(): SettingsBlock[] | Promise<SettingsBlock[]>;
  /** Re-fetch the panel this often (ms) while it is visible. The UI clamps this to at least 1000. */
  refreshMs?: number;
  /** Handlers for `button` blocks. Throw to report an error in the UI. */
  actions?: Record<string, SettingsAction>;
}
