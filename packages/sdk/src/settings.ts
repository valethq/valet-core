// spec-gap: the `settings` scope is defined by valet-ui and not in the architecture doc; every provider used to redeclare this type.

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

/** A panel on the `settings` scope: an editable form (`schema`, `get`, `set`), read-only `view` blocks, or both. The blocks render above the form. */
export interface SettingsPanel {
  title: string;
  description?: string;
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
