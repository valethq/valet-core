export interface PluginManifest {
  /** Manifest format version. */
  schema: 1;
  /** Globally unique; matches the repo name, e.g. "valet-discord". */
  id: string;
  name: string;
  version: string; // semver
  description?: string;
  /** Semver range of the core plugin API this targets, e.g. "^0.1.0". */
  valet: string;
  /** Entry module, relative to the manifest. Bun loads .ts directly. */
  main: string;
  /** Hard plugin dependencies: id -> semver range. Loaded first; if one is missing or fails, this plugin does not load. */
  dependencies?: Record<string, string>;
  /** Soft plugin dependencies: loaded first when present; absence is fine. */
  optionalDependencies?: Record<string, string>;
  /** Scopes this plugin implements, as "name@major", e.g. ["inference@1"]. */
  provides?: string[];
  /** Scopes this plugin needs at activation, as "name@major". Every provider of a required scope loads first. */
  requires?: string[];
  /** Like `requires`, but the plugin works without them. */
  optionalRequires?: string[];
  /** Event namespace this plugin may emit under. Defaults to the id without the "valet-" prefix. */
  events?: { namespace?: string };
  /** JSON Schema for this plugin's config block; core validates it before activate(). */
  configSchema?: Record<string, unknown>;
  /** Reserved for post-v1 permissions. Ignored in v1 (plugins are fully trusted). */
  permissions?: string[];
}
