# valet-core architecture

Status: draft 2, with Owner's review folded in (2026-11-12). Repo: `valethq/valet-core`. Plugins: `valethq/valet-<name>`. Runtime: Bun (host runs 1.4.4).

Valet is a plugin-first agent harness. It replaces OpenClaw as the place where Owner's agent (Helper) lives. The core is small. It stores state, routes events, loads plugins and hosts HTTP and WebSocket routes. Everything an agent harness actually does, including the agent loop, is done by plugins through the same public API that any third-party plugin gets.

This document is the contract for that API. Section 14 records Owner's decisions.

**Changes in draft 2:** (1) Every event, hook and scope call carries the caller's plugin identity, and any plugin can deny service. Authentication and authorization are therefore federated to plugins, still through public APIs only (sections 7.2 and 10.2). (2) The core HTTP/WS port is a control plane for valet itself. The web UI runs its own server on its own port (sections 10 and 11.5).

---

## 1. Goals and non-goals

**v1 goals** (in the order of the OpenClaw usage audit, 2026-11-11):

1. Multi-session web chat, with one session per task.
2. Long-running shell exec that streams output, can be interrupted cleanly, and survives a valet restart.
3. Helper's persona and memory files carried over intact: `AGENTS.md`, `USER.md`, `MEMORY.md`, `SOUL.md`, `IDENTITY.md` and `memory/YYYY-MM-DD.md`.
4. Devin CLI as the inference provider, with a per-session model picker and fallbacks.
5. Compaction and resume, including resume after a restart in the middle of a turn.
6. A Discord bot with owner and friend tiers.

**Non-goals for v1:** sandboxing plugins from each other, multi-host or cross-process event delivery, a plugin marketplace, iMessage, voice, the TUI and the iOS app, a full automation platform, and native integrations for the CLIs Helper already drives through the shell (`gog`, `ntn`, Cloudflare, Proxmox).

**Design rules**

- **Core has no agent logic.** It never calls a model, builds a prompt or runs a tool.
- **No private hooks.** Base plugins (`valet-agent`, `valet-ui`, `valet-contextmanager`) get exactly the `PluginContext` any plugin gets. There is no `ctx.internal`. If a base plugin needs something, it becomes public API or it doesn't happen.
- **Core stamps identity; plugins decide whom to serve.** Every event, hook and scope call carries the id of the plugin behind it. Core fills that in and nothing can forge it. Whether to serve a caller is up to the plugin being asked, and it can deny. Authentication is a plugin too (`valet-auth`). Core has no role checks of its own.
- **The core port is a control plane.** HTTP and WS on it exist to control valet. No UI is served there. `valet-ui` runs its own server.
- **Plugins import `@valethq/sdk` only.** The SDK holds types plus a few zero-dependency helpers. Plugins never import `@valethq/core`. A lint rule and a CI test enforce this (section 11).
- **Headless is just "no UI plugin".** The control plane (core REST and WS) still serves. Discord and scheduled jobs still work.
- **Personas, models and prompts are data.** They live on projects and sessions, not in code or plugin config.

## 2. Glossary

| Term | Meaning |
|---|---|
| **Core** | The `valet` process: plugin loader, event bus, store, HTTP/WS host, principals. |
| **Plugin** | A directory with `manifest.json` and an entry module exporting `definePlugin(...)`. It runs in-process. |
| **Scope** | A named, versioned capability contract (a TypeScript interface) that plugins provide and consume, e.g. `inference@1` or `tools@1`. |
| **Project** | A workspace: a directory on disk plus defaults (persona, model, settings). Helper is one project. |
| **Session** | One conversation inside a project. It has its own model, color, title and channel bindings. |
| **Message / Part** | A message has a role and an author. Its content is an ordered list of typed parts (text, tool call, tool result, and so on). |
| **Run** | One agent turn in a session: from the trigger to the final assistant message. Runs are persisted so that interruptions can be detected. |
| **Principal** | An actor with a role: `owner`, `trusted` (friend) or `guest`. Platform identities such as a Discord user ID map to principals. |
| **Caller** | Who caused an event, a store write or a scope call: the plugin id (stamped by core), plus the principal it acts for when there is one. |
| **Control plane** | The core HTTP/WS port: the API for controlling valet. It serves no UI. |

## 3. Core vs plugins

```mermaid
graph TD
  subgraph core["valet-core (one Bun process)"]
    loader[Plugin loader] --> bus[Event bus]
    store[(Store: bun:sqlite)]
    http[Control plane: Bun.serve]
    principals[Principals and caller identity]
  end
  agent[valet-agent] --> ctxm[valet-contextmanager]
  agent --> devin[valet-devin: inference@1]
  agent --> exec[valet-exec: tools@1]
  agent --> fs[valet-fs: tools@1]
  ui["valet-ui (own port)"] -. REST/WS client .-> http
  auth[valet-auth: identity@1] --> http
  discord[valet-discord: platform@1] --> agent
  sched[valet-scheduler] --> agent
  skills[valet-skills] --> ctxm
```

| Core owns | Plugins own |
|---|---|
| Loading, ordering, activating and deactivating plugins | The agent loop, run queueing and interrupt policy (`valet-agent`) |
| The event bus and the core event catalog | Prompt building, history windowing, compaction, persona and memory files (`valet-contextmanager`) |
| Persistence of projects, sessions, messages, parts, runs, principals, blobs and plugin KV | Model calls (`valet-devin`, later `valet-openai`) |
| Detecting interrupted runs at boot | Deciding whether to resume them (`valet-agent`) |
| The control-plane HTTP/WS server and route mounting. Stamping caller identity on every event, hook and scope call | Authentication and every allow/deny decision (`valet-auth`, and each plugin for its own service). All UI, on its own port (`valet-ui`) |
| The core REST API and WS topics for core entities | Tools (`valet-exec`, `valet-fs`, `valet-web`) |
| Config and secrets loading | Platforms (`valet-discord`), schedules (`valet-scheduler`), skills (`valet-skills`) |
| Scope registry (provide/consume and cardinality) | Defining new scopes beyond the core set |

Core defines the core scopes' **interfaces** in the SDK (`inference@1`, `tools@1`, `platform@1`, `identity@1`, `context@1`) because several unrelated plugins must agree on them. It never **implements** them. `context@1` is implemented and registered (`defineScope`) by `valet-contextmanager`; core only ships its types. Any plugin can define a scope of its own the same way.

## 4. Repo layout and packages

```
valet-core/
  ARCHITECTURE.md
  packages/
    sdk/          @valethq/sdk   types, definePlugin, defineScope, zero runtime deps
    core/         @valethq/core  kernel and the `valet` CLI (valet start | valet doctor | valet import-openclaw)
  plugins/        base plugins until they split into valethq/valet-<name> (decision 4)
    agent/ auth/ contextmanager/ ui/ devin/ exec/ fs/ discord/ skills/ scheduler/
  test/           kernel tests, including "boots with zero plugins"
```

The npm scope is `@valethq` (not `@valet`) so it matches the org. Bun runs TypeScript directly, so a plugin's `main` can point at a `.ts` file with no build step.

## 5. Plugins

### 5.1 Manifest (`manifest.json`)

```ts
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
  /** Settings v3 document (12.1): config and settings UI in one. Core compiles it into the config schema. */
  settings?: SettingsDoc;
  /** JSON Schema for this plugin's config block when it has no `settings` document; ignored when `settings` is present. */
  configSchema?: Record<string, unknown>;
  /** Reserved for post-v1 permissions. Ignored in v1 (plugins are fully trusted). */
  permissions?: string[];
}
```

Example:

```json
{
  "schema": 1,
  "id": "valet-discord",
  "name": "Discord",
  "version": "0.1.0",
  "valet": "^0.1.0",
  "main": "./src/index.ts",
  "dependencies": { "valet-agent": "^0.1.0" },
  "provides": ["platform@1"],
  "events": { "namespace": "discord" },
  "configSchema": {
    "type": "object",
    "required": ["tokenSecret", "guildId"],
    "properties": {
      "tokenSecret": { "type": "string" },
      "guildId": { "type": "string" },
      "openChannels": { "type": "array", "items": { "type": "string" } }
    }
  }
}
```

### 5.2 Discovery, resolution and load order

1. **Discover.** Core reads every `*/manifest.json` under each `pluginPaths` entry in config (default `~/.valet/plugins` and the repo's `plugins/`). A plugin listed in `plugins` config as disabled is dropped. Two manifests with the same id is a boot error.
2. **Validate.** Core checks the manifest against the schema and `valet` against the core API version. It compiles the plugin's `settings` document (12.1), or takes its `configSchema`. It migrates each stored layer, merges them, resolves `secret:`, `file:` and `env:` refs (12.2), parses unit strings, and only then validates the block and checks `required`. A malformed document, a validation failure, or a failed `secret:`/`file:`/`env:` ref on a required setting marks only that plugin `failed`. `cmd:` refs are not resolved at load.
3. **Build the graph.** Edges come from `dependencies`, from `optionalDependencies` when present, and from `requires`/`optionalRequires`: for each scope required, an edge runs from every plugin that `provides` it. A missing hard dependency or required scope marks the plugin `failed`, and that cascades to its dependents.
4. **Order.** Core runs a topological sort (Kahn's algorithm), breaking ties by id so boot order is deterministic. Plugins in a cycle are all marked `failed` with the cycle printed. Core does not guess.
5. **Activate** sequentially in that order: `await plugin.activate(ctx)`, with a 15s timeout. A throw or timeout marks the plugin `failed`, disposes anything it registered, and fails its hard dependents. Optional dependents still activate.
6. **Ready.** Once every plugin has settled, core emits `core.ready`. Only then does it emit `run.interrupted` for runs found mid-flight at boot (section 7.4) and start accepting HTTP.
7. **Shutdown** (SIGTERM or `valet stop`): core emits `core.shutdown` and stops accepting requests. It deactivates plugins in reverse order (5s each) and aborts each `ctx.signal`. Then it checkpoints SQLite and exits.

`GET /api/core/plugins` reports each plugin's state (`active | failed | disabled`), error and load order. In v1 a crashed plugin stays down until restart. There is no hot reload.

### 5.3 Plugin entry and context

```ts
export interface ValetPlugin<Config = unknown> {
  activate(ctx: PluginContext<Config>): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
export declare function definePlugin<Config = unknown>(plugin: ValetPlugin<Config>): ValetPlugin<Config>;

export interface PluginContext<Config = unknown> {
  readonly plugin: { readonly id: string; readonly version: string; readonly dir: string; readonly manifest: PluginManifest };
  /** The applied user block (12.1 layers 1-3), refs resolved; `cmd:` values come from the cache. */
  readonly config: Config;
  /** A project's view: its project layer over the applied user block. `ctx.config` for an unknown project or one without overrides. */
  configFor(projectId: string): Config;
  /**
   * Pre-save veto: runs before a save (user or project) is written, with the validated next and current blocks.
   * Throw to reject the save (422 for a user save, 400 for a project save); nothing is written.
   */
  onConfigCheck(fn: (next: Config, prev: Config) => void | Promise<void>): void;
  /**
   * Runs after a user save, reload or ref re-resolve changed this plugin's desired block. `ctx.config` switches to
   * `next` only once every listener has returned. A throw keeps the previous applied block and reports the error as
   * restart-required; it never rejects the save. A plugin without a listener is reported as restart-required.
   */
  onConfigChange(fn: (next: Config, prev: Config) => void | Promise<void>): void;
  readonly log: Logger;
  readonly events: PluginEventBus;
  readonly scopes: ScopeRegistry;
  readonly store: Store;
  readonly storage: PluginStorage;
  readonly http: HttpHost;
  readonly ws: WsHost;
  readonly secrets: Secrets;
  readonly paths: { readonly data: string; readonly cache: string; readonly valetHome: string };
  /** Aborted when this plugin deactivates or core shuts down. */
  readonly signal: AbortSignal;
  /** Runs on deactivate, in reverse registration order. Hooks, scopes, routes and WS handlers are disposed automatically. */
  onDispose(fn: () => void | Promise<void>): void;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface Secrets {
  /** Resolves ~/.valet/secrets/<name> (file, mode 0600) and then the environment variable <NAME>. */
  get(name: string): Promise<string | undefined>;
  require(name: string): Promise<string>;
}

export interface Disposable { dispose(): void }
```

Everything a plugin registers through `ctx` is tagged with its id and removed on deactivate. That covers hooks, scope implementations, routes and WS handlers. A plugin can't leak a hook into the bus after it's gone. The same id is what core stamps as `caller.plugin` on everything the plugin emits, writes or calls (section 7.2). Each plugin gets its own `ctx`, and there is no way to act under another plugin's id.

## 6. Scopes

A scope is a contract between plugins. It has an id, a major version and a cardinality:

- **`one`**: a single provider is active (e.g. `context@1`). A second provider is a load error, unless config names the winner.
- **`many`**: any number of keyed providers (e.g. `inference@1` keyed by provider id, `tools@1`, `platform@1`).

Scope types are registered with declaration merging, so `ctx.scopes.get("inference")` is fully typed in any plugin that imports the scope's types:

```ts
export interface ValetScopes {
  inference: InferenceProvider;
  tools: ToolProvider;
  platform: MessagePlatform;
  identity: IdentityProvider;
  context: ContextManager;   // provided by valet-contextmanager
}
export type ScopeName = Extract<keyof ValetScopes, string>;

export interface ScopeDefinition { name: string; version: number; cardinality: "one" | "many" }
export declare function defineScope(def: ScopeDefinition): ScopeDefinition;

export interface ScopeProvider<K extends ScopeName> {
  readonly key: string;     // provider key, e.g. "devin-cli"; defaults to the plugin id
  readonly plugin: string;
  readonly impl: ValetScopes[K];
}

export type ScopeImpl<K extends ScopeName> = ValetScopes[K] | ((caller: Caller) => ValetScopes[K]);

export interface ScopeRegistry {
  define(def: ScopeDefinition): void;
  /** A factory is called once per consuming plugin with that plugin's identity, so the provider knows who is calling. */
  provide<K extends ScopeName>(scope: K, impl: ScopeImpl<K>, opts?: { key?: string }): Disposable;
  /** The single provider (cardinality "one") or the provider with this key. Throws ScopeMissingError. */
  get<K extends ScopeName>(scope: K, key?: string): ValetScopes[K];
  maybe<K extends ScopeName>(scope: K, key?: string): ValetScopes[K] | undefined;
  all<K extends ScopeName>(scope: K): ScopeProvider<K>[];
  /** Fires on provide and dispose, so consumers can track providers that arrive later or go away. */
  watch<K extends ScopeName>(scope: K, fn: (providers: ScopeProvider<K>[]) => void): Disposable;
}
```

A plugin that implements a scope must list it in `provides`, and core rejects an unlisted `provide()`. This keeps the manifest honest, so the loader can order plugins before any code runs.

**Who is calling.** `get`, `maybe` and `all` return the implementation bound to the consuming plugin. A provider that passed a factory sees that plugin's `Caller` and can refuse it, for every call or per call, by throwing `ServiceDeniedError`. Core wraps bound implementations and sets `by` to the provider's id, so a denial is always attributed correctly.

```ts
export declare class ServiceDeniedError extends Error {
  readonly by: string;
  readonly reason: string;
  constructor(reason: string);
}
```

### 6.1 `inference@1`: model providers

The audit found a fact that shapes this interface. OpenClaw's `devin-cli` provider does not use Devin as a stateless model. `~/.openclaw/plugins/devin-cli/sessions.json` maps each of 118 OpenClaw sessions to a persistent Devin CLI session (`devinSessionId`, `cwd` = the workspace, `contextTokens` up to ~600k). Devin runs its own loop, its own tools and its own history. So providers come in two kinds:

- **`model`**: a stateless completion API (an OpenAI-compatible endpoint such as CLIProxyAPI). `valet-agent` runs the tool loop and `valet-contextmanager` owns the history.
- **`agent`**: a delegated agent (Devin CLI over ACP). The provider owns the inner loop, tools and remote history. Valet mirrors the stream into messages and parts, and offers valet's own tools to the agent over MCP.

```ts
export interface ModelInfo {
  id: string;            // "claude-opus-5-5"
  name: string;          // "Claude Opus 5.5"
  contextWindow: number;
  maxOutputTokens: number;
  input: ("text" | "image")[];
  reasoning: boolean;
  cost?: { input: number; output: number; cacheRead?: number }; // per 1M tokens
  /** Reasoning effort levels the model takes, lowest first, e.g. ["low", "medium", "high"]. Absent: none to pick. */
  efforts?: string[];
  /** The effort a selection without one runs at. */
  defaultEffort?: string;
  /** The model has a fast mode: a faster serving tier, usually billed higher. */
  fast?: boolean;
  /** Fast mode is on unless the selection turns it off. */
  fastByDefault?: boolean;
  /** Listed, but left out of pickers until the user shows it (previews, niche variants). */
  hidden?: boolean;
}

/** How a model runs. Picked alongside the model and never encoded in its id. */
export interface ModelOptions {
  /** One of the model's `efforts`; unset runs its `defaultEffort`. */
  effort?: string;
  /** Fast mode on or off; unset follows `fastByDefault`. */
  fast?: boolean;
}

/** A model choice as sessions, projects and config store it. */
export interface ModelRef extends ModelOptions {
  provider: string;
  model: string;
}

export type InferenceProvider = ModelProvider | AgentProvider;

interface ProviderBase {
  readonly id: string;     // "devin-cli"; also the scope key
  readonly label: string;
  listModels(): Promise<ModelInfo[]>;
  /** The provider's Utility model: a cheap, fast model for small side jobs such as naming a session. */
  readonly utility?: UtilityModel;
}

export interface UtilityRequest { system: string; prompt: string; maxOutputTokens?: number }

export interface UtilityModel {
  /** Id of the model side jobs run on, or undefined when the provider has none to offer. */
  model(): string | undefined;
  /** One short, tool-free completion on `model()`. Rejects when the call fails. */
  complete(req: UtilityRequest, signal: AbortSignal): Promise<string>;
}

// ---- kind: "model" ----
export interface ModelProvider extends ProviderBase {
  readonly kind: "model";
  stream(req: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceChunk>;
}

export interface InferenceRequest extends ModelOptions {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  maxOutputTokens?: number;
  meta: { sessionId: string; runId: string };
}

export type ModelMessage =
  | { role: "user"; content: ModelContent[] }
  | { role: "assistant"; content: ModelContent[] }
  | { role: "tool"; callId: string; content: ModelContent[]; isError?: boolean };

export type ModelContent =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; blobId: string }
  | { type: "tool-call"; callId: string; name: string; input: unknown };

export type InferenceChunk =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; callId: string; name: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  | { type: "finish"; reason: "stop" | "tool-calls" | "length" | "cancelled" | "error"; error?: string };

// ---- kind: "agent" ----
export interface AgentProvider extends ProviderBase {
  readonly kind: "agent";
  /** Opens a new remote session, or reopens one when `resumeId` (from Session.providerState) is given. */
  open(opts: AgentOpenOptions): Promise<AgentSession>;
}

export interface AgentOpenOptions extends ModelOptions {
  sessionId: string;
  cwd: string;
  model: string;
  resumeId?: string;
  /** Valet's tools for this session (see 6.2). The provider decides how to expose them to its agent. */
  tools: ToolSurface;
  signal: AbortSignal;
}

/** Valet's tools as one provider sees them. Bound to the session: `list` and `call` follow the active run. */
export interface ToolSurface {
  /** Tools this run may use, as of the run's start. Empty when no run is active. */
  list(): ToolSpec[];
  /** Runs one call through the `tool.call` gate, then the tool. A denied or failed call returns `isError`; it never throws. */
  call(name: string, input: unknown, call: { callId: string; signal: AbortSignal }): Promise<ToolResult>;
  /** Runs the `tool.call` gate for a call the provider runs itself (a built-in or native tool). Returns the input to use, or a denial. */
  authorize(name: string, input: unknown, call: { callId: string }): Promise<{ input: unknown } | { denied: string }>;
}

export interface AgentSession {
  /** Persisted on the session so it can be reopened after a restart. */
  readonly resumeId: string;
  prompt(input: { content: ModelContent[]; preamble?: string }, signal: AbortSignal): AsyncIterable<AgentEvent>;
  /** Switches the open session to another model or other options; `options` replaces the previous ones whole. */
  setModel?(model: string, options: ModelOptions): Promise<void>;
  close(): Promise<void>;
}

export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-start"; callId: string; name: string; title?: string; input?: unknown }
  | { type: "tool-update"; callId: string; outputDelta?: string; status?: "running" | "done" | "error" }
  | {
      type: "tool-end";
      callId: string;
      status: "done" | "error" | "cancelled";
      output?: string;
      exitCode?: number;
    }
  | { type: "permission"; request: { callId: string; title: string }; respond(allow: boolean): void }
  | { type: "usage"; contextTokens?: number; inputTokens?: number; outputTokens?: number }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string }
  | { type: "finish"; reason: "stop" | "cancelled" | "length" | "error"; error?: string };
```

Providers set `exitCode` on `tool-end` when the tool reports one; `valet-agent` stores it as the tool part's `result.meta.exitCode`. A `notice` event is out-of-band provider information (e.g. a context-compaction warning), rendered as a `notice` part rather than hidden inside reasoning text.

**Effort and fast mode are options, not models.** A provider lists each model once, with the efforts it takes and whether it has a fast mode, and receives the choice as `ModelOptions` on `stream()`, `open()` and `setModel()`. How a harness spells the choice (a variant id, a flag, a service tier) stays inside its provider. Ids from before this rule (`claude-opus-5-5-high`, `swe-2-medium-lightning`) are rewritten by `valet-agent` (11.1).

**Fallbacks** are data, not provider logic. `session.settings.model` is a `ModelRef` plus `fallbacks: ModelRef[]`. On `finish: error`, or a refusal, before any output has streamed, `valet-agent` retries with the next fallback. For Devin, `valet-devin` also passes `--refusal-fallback`.

### 6.2 `tools@1`: tools

```ts
export type Role = "owner" | "trusted" | "guest";

export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }

export interface ToolDefinition<Input = unknown> extends ToolSpec {
  /** Lowest role this tool serves (the run's effective role, section 8.3). The providing plugin enforces it: the SDK's `defineTool` applies it in `list` and again in `invoke`. Core and valet-agent do not. Default "owner". */
  minRole?: Role;
  timeoutMs?: number;
  invoke(input: Input, call: ToolCall): Promise<ToolResult>;
}

export interface ToolCall {
  sessionId: string;
  runId: string;
  callId: string;
  role: Role;
  /** Stamped by core: the plugin making the call and the principal behind the run. */
  caller: Caller;
  cwd: string;
  signal: AbortSignal;
  /** Streams partial output to the tool-call part and to WS subscribers. */
  progress(update: { outputDelta?: string; status?: string }): void;
}

export interface ToolResult {
  content: ({ type: "text"; text: string } | { type: "image"; mime: string; blobId: string })[];
  isError?: boolean;
  meta?: Record<string, unknown>;
}

export interface ToolProvider {
  /** Re-read on each run, so tools can depend on session or project. */
  list(scope: { sessionId: string; projectId: string; role: Role }): ToolDefinition[] | Promise<ToolDefinition[]>;
}
```

`valet-agent` collects `scopes.all("tools")` for each run and filters the result by the run's role and by its exposure config. It hands each provider a `ToolSurface` (6.1). The surface runs the `tool.call` event (section 7.3) before every call, so policy plugins can deny or rewrite it. A denial comes back to the provider as an `isError` result. How a provider exposes the surface is the provider's choice. `valet-claudecode` and `valet-devin` mount it as an MCP server on their own route, with a per-session bearer token, through the SDK's `toolEndpoint` helper, and pass that server to their agent. A `model`-kind provider takes the tool specs in its request instead. Either way the calls show up as ordinary tool parts.

### 6.3 `platform@1`: message platforms

```ts
export interface ChannelBinding {
  platform: string;          // "discord"
  conversationId: string;    // channel, DM or thread ID
  meta?: Record<string, unknown>;
}

export interface OutboundMessage {
  text: string;
  files?: { blobId: string; name: string }[];
  replyToExternalId?: string;
}

export interface MessagePlatform {
  readonly id: string;
  readonly label: string;
  send(binding: ChannelBinding, msg: OutboundMessage): Promise<{ externalId: string }>;
  edit?(binding: ChannelBinding, externalId: string, msg: OutboundMessage): Promise<void>;
  typing?(binding: ChannelBinding): Promise<void>;
}
```

Inbound messages need no scope method. A platform plugin resolves the sender with `store.principals.resolveIdentity(...)`. It finds or creates the session bound to `(platform, conversationId)` and calls `store.messages.create(...)` with an `origin`. Outbound delivery is a hook: the platform plugin listens for `after:message.complete` on sessions bound to its platform. The `platform@1` scope exists so other plugins (a future scheduler delivery target, the agent's `send_message` tool) can deliver to a binding without knowing which plugin owns it.

### 6.4 `context@1` (provided by `valet-contextmanager`)

The types live in the SDK (`context.ts`), so `valet-agent` and the provider share one declaration. The scope is registered and implemented by `valet-contextmanager`.

```ts
export interface PersonaFile { path: string; role: "agents" | "user" | "memory" | "soul" | "identity" | "daily" | "other"; content: string }

export interface BuiltContext {
  system: string;
  messages: ModelMessage[];
  estimatedTokens: number;
  files: PersonaFile[];
}

export interface ContextManager {
  /** model-kind: full prompt within budget (persona files, compaction summary, recent history). */
  build(req: { sessionId: string; runId: string; model: ModelInfo; role: Role }): Promise<BuiltContext>;
  /** agent-kind: persona/memory preamble for a new or reseeded remote session. */
  preamble(req: { sessionId: string; role: Role }): Promise<string>;
  shouldCompact(req: { sessionId: string; model: ModelInfo; lastUsage: { inputTokens?: number; contextTokens?: number } }): Promise<boolean>;
  /** Writes a compaction part: a valet summary (`by: "valet"`), or a marker for a harness that compacted itself. Older messages stay stored but leave the prompt window. */
  compact(req: { sessionId: string; reason: "auto" | "manual" | "resume" }): Promise<{ summaryPartId: string }>;
}
```

## 7. Event bus

### 7.1 Semantics (kept from the `valet-event-bus` prototype)

The prototype at `host:~/.openclaw/workspace/projects/valet-event-bus` becomes `packages/core/src/bus` with its tests. These rules stay as they are:

- Hooks run **sequentially**, by **descending priority**, then by registration order. Every hook is awaited.
- **`before` hooks** may replace the payload (`event.payload = {...}`) or `cancel(reason)`. Cancelling skips the remaining `before` hooks.
- **`after` hooks** always run. They observe the final payload and the cancellation state, and cannot change either.
- `once` hooks, and `Subscription` handles with `disconnect()`.
- Hook failures are wrapped in `EventHookError { eventName, phase, plugin, cause }`.

### 7.2 Changes from the prototype

| # | Change | Why |
|---|---|---|
| 1 | `caller.plugin` is stamped from `ctx` on every emit, store write and scope call, and every subscription is disconnected on deactivate. | Attribution and cleanup can't be forgotten. |
| 2 | **After-hook failures are isolated.** They are logged and reported as `core.hook.error`. The remaining after hooks still run and `emit` still resolves. Before-hook failures still reject `emit`, and the action does not happen. | In the prototype the first failing observer rejects `emit` and skips later observers. Since core persists *between* phases, one buggy UI hook would fail a message write that already happened. |
| 3 | Hooks are snapshotted **once per emit**, covering both phases. | In the prototype, a hook added during the before phase runs in the after phase of the same emit. |
| 4 | Typed sugar `before(name, fn, opts)` and `after(name, fn, opts)` narrow the context. `on()` without a phase is removed. | The prototype defaults to `before`, which is easy to get wrong. |
| 5 | Hook budget: a hook slower than 250ms logs a warning. A before hook slower than 10s fails with `EventHookError` (cause `timeout`). The limit can be set per event. | A stuck policy hook must not hang a session. |
| 6 | Re-entrant emits are allowed, with a depth limit of 8. | Catches hook loops (A emits B, B emits A). |
| 7 | New **`signal(name, payload)`**: after-only and fire-and-forget. Hooks run synchronously and are not awaited, and errors are logged. | Token deltas and exec output arrive at hundreds of events per second, and they don't need veto. |
| 8 | Payloads are treated as immutable. In dev mode they are frozen; to change one, replace it. | Changing a payload in place would hide the change from later hooks. |
| 9 | Events carry a `Caller` (plugin id, an optional actor principal and role, and the cause) instead of the prototype's free-form `plugin` string. | A plugin needs to know who is asking before it serves the request. Core fills the caller in so it can't be forged. |
| 10 | `deny(reason)` on before events. It cancels like `cancel()` and also records `denied: { by, reason }`, with `by` set to the hooking plugin. Callers see it in `EmitResult` and `CancelledResult`. The control plane maps it to 403. | Any plugin can refuse service. This is how auth is federated (section 10.2). |
| 11 | `restrict(fn)`: a plugin chooses which plugins may hook or observe events and signals in its namespace. It is checked when a hook subscribes. | A plugin can deny event service to other plugins as well as to principals. |

```ts
export type HookPhase = "before" | "after";
export interface HookOptions { priority?: number; once?: boolean }
export interface Subscription { readonly active: boolean; disconnect(): void }

/** Who caused an event, a store write or a scope call. Core fills it in; plugins cannot set `plugin`. */
export interface Caller {
  /** The emitting, writing or calling plugin's id, or "core" (boot recovery, control-plane requests). */
  readonly plugin: string;
  /**
   * The principal this is on behalf of, if any. Inside a run, `role` is the run's effective role (section 8.3).
   * A plugin claims it (via `store.as()` or a message author), or an identity provider proves it. Hooks decide whether to believe it.
   */
  readonly actor?: { readonly principalId: string; readonly role: Role };
  /** Control-plane requests only: the identity@1 provider that authenticated the request. */
  readonly authenticatedBy?: string;
  /** Set on re-entrant emits: the event whose hook caused this one. */
  readonly cause?: { readonly event: string; readonly plugin: string };
}
export interface Denial { readonly by: string; readonly reason: string }

export interface BeforeEvent<N extends string, P> {
  readonly name: N; readonly phase: "before"; readonly caller: Caller;
  payload: P; readonly cancelled: boolean; readonly cancelReason: string | undefined;
  readonly denied: Denial | undefined;
  cancel(reason?: string): void;
  /** Refuse service to this caller. Like cancel(), it skips the remaining before hooks. Core sets `by` to this hook's plugin. */
  deny(reason: string): void;
}
export interface AfterEvent<N extends string, P> {
  readonly name: N; readonly phase: "after"; readonly caller: Caller;
  readonly payload: P; readonly cancelled: boolean; readonly cancelReason: string | undefined;
  readonly denied: Denial | undefined;
}
export interface EmitResult<P> { readonly payload: P; readonly cancelled: boolean; readonly cancelReason?: string; readonly denied?: Denial }

/** Extended by declaration merging; plugin events are named "<namespace>.<rest>". */
export interface ValetEvents {}
/** High-frequency, after-only signals. */
export interface ValetSignals {}

type EvName = Extract<keyof ValetEvents, string>;
type SigName = Extract<keyof ValetSignals, string>;

export interface PluginEventBus {
  before<N extends EvName>(name: N, fn: (e: BeforeEvent<N, ValetEvents[N]>) => void | Promise<void>, opts?: HookOptions): Subscription;
  after<N extends EvName>(name: N, fn: (e: AfterEvent<N, ValetEvents[N]>) => void | Promise<void>, opts?: HookOptions): Subscription;
  /** Only for events in this plugin's namespace; core events are emitted by core actions. */
  emit<N extends EvName>(name: N, payload: ValetEvents[N]): Promise<EmitResult<ValetEvents[N]>>;
  onSignal<N extends SigName>(name: N, fn: (payload: ValetSignals[N], caller: Caller) => void): Subscription;
  signal<N extends SigName>(name: N, payload: ValetSignals[N]): void;
  /** Decide which plugins may hook or observe this plugin's namespace. Checked when a hook subscribes. */
  restrict(fn: (subscriber: string, name: string) => boolean): Disposable;
}
```

**Namespaces.** Core owns `core.*`, `project.*`, `session.*`, `message.*`, `run.*`, `principal.*`, `plugin.*` and `control.*`. A plugin may emit only `<namespace>.*` (from the manifest; for example, `valet-exec` emits `exec.*`). It may hook any event. Core rejects emits outside the plugin's namespace (the one exception is `tool.call`, section 7.3).

The bus is in memory and ephemeral. Durable facts go through the store, and the store's actions emit events. Nothing replays bus history after a restart. Recovery works from persisted state instead (section 7.4).

### 7.3 Core event catalog

**Action events** wrap a store mutation: `before` (mutate, cancel or deny), then the **write** in a transaction, then `after`. A cancelled action writes nothing and returns `{ cancelled, cancelReason, denied? }` to the caller.

| Event | Payload (abridged) | Typical hooks |
|---|---|---|
| `project.create` / `project.update` / `project.delete` | `{ project }` | |
| `session.create` / `session.update` / `session.delete` | `{ session }`, `{ session, patch }` | UI list refresh |
| `message.create` | `{ message, parts }` | before: slash commands (`/model`, `/compact`, `/new`), role policy. after: `valet-agent` queues a run for user messages. |
| `message.complete` | `{ message }` (status changes to `complete`, `error` or `interrupted`) | after: platform delivery |
| `run.start` / `run.update` / `run.end` | `{ run }` | `run.update` is emitted after every `runs.update` write, including usage-only patches, so live counters (e.g. context tokens) reach subscribers before the run ends |
| `run.cancel` | `{ runId, by }` | `valet-agent` aborts the run's controller |
| `run.interrupted` | `{ run }`, emitted after `core.ready` for runs found `running` at boot | `valet-agent` resume policy |
| `tool.call` | `{ runId, callId, name, input, role }` | before: deny or rewrite (friend-tier policy, "never `qm destroy`"). after: audit |
| `principal.link` | `{ principal, identity }` | |
| `control.request` | `{ kind: "http" \| "ws.sub" \| "ws.call", method, path }` (for `ws.sub`, `path` is the topic) | before: `valet-auth` policy, and any plugin guarding its own routes or topics. A deny returns 403. |
| `core.ready` / `core.shutdown` | `{}` | |

`tool.call` and `control.request` are the action events that aren't store mutations. Core emits `control.request` itself. `tool.call` is declared in the core namespace so that any policy plugin can rely on its name and payload, and it is the only core event a plugin may emit. In practice that plugin is whichever one runs tools (`valet-agent`, or `valet-devin` for MCP calls).

**Signals:**

| Signal | Payload |
|---|---|
| `message.delta` | `{ sessionId, messageId, partId, kind: "text" \| "reasoning" \| "tool-output", delta, offset }` |
| `run.status` | `{ sessionId, runId, status: string }` (e.g. "thinking", "running exec") |
| `core.hook.error` | `{ eventName, phase, plugin, error }` |

`offset` is the part's text/output length before the delta was appended, so a client can dedupe overlapping deltas and refetch the part when an `offset` exceeds its local length. While a part's writer is open, `messages.list` (and therefore REST) returns the writer's in-memory `data` rather than the last 500 ms checkpoint, so a snapshot taken mid-stream is exact.

Plugins add their own, e.g. `exec.output` and `exec.job.end`.

### 7.4 Restart recovery

At boot, before plugins activate, core finds the leftovers of an unclean stop. Every run with `status = 'running'` becomes `interrupted`. Every message or part with `status = 'streaming'` becomes `interrupted`, and its last checkpointed text is kept. After `core.ready`, core emits `run.interrupted` for each such run. Core does nothing else. Resume is `valet-agent`'s decision.

## 8. Storage

### 8.1 Engine

One SQLite file, `~/.valet/valet.db`, through `bun:sqlite`, with `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON` and `busy_timeout=5000`. Core writes synchronously inside `db.transaction()`. WAL lets reads run while a write is in progress. Core migrations are numbered SQL files in `packages/core/migrations`, applied at boot, and recorded in `schema_migrations`.

IDs are prefixed UUIDv7 values (`prj_`, `ses_`, `msg_`, `prt_`, `run_`, `pri_`, `blb_`) from `Bun.randomUUIDv7()`. They sort by time and are readable in logs.

### 8.2 Core schema (sketch)

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,              -- e.g. ~/.valet/projects/helper
  settings TEXT NOT NULL DEFAULT '{}',      -- JSON: persona, default model, plugin-namespaced settings
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT, color TEXT,                   -- per-session indicator color
  parent_session_id TEXT REFERENCES sessions(id),  -- subagents
  status TEXT NOT NULL DEFAULT 'idle',      -- idle | running | archived
  settings TEXT NOT NULL DEFAULT '{}',      -- JSON: model {provider, model, effort, fast, fallbacks}, persona override
  provider_state TEXT NOT NULL DEFAULT '{}',-- JSON keyed by provider id, e.g. {"devin-cli":{"resumeId":"..."}}
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_message_at INTEGER
);
CREATE TABLE session_bindings (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, conversation_id TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (platform, conversation_id)
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  trigger_message_id TEXT, status TEXT NOT NULL,   -- queued | running | complete | cancelled | error | interrupted
  role TEXT NOT NULL,                              -- effective role (8.3)
  provider TEXT, model TEXT, usage TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER, ended_at INTEGER, error TEXT
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,                     -- per-session order
  role TEXT NOT NULL,                       -- user | assistant | system | tool
  author_principal_id TEXT REFERENCES principals(id),
  run_id TEXT REFERENCES runs(id),
  status TEXT NOT NULL,                     -- streaming | complete | error | interrupted
  origin TEXT,                              -- JSON {platform, conversationId, externalId} | null for web
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE TABLE parts (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, type TEXT NOT NULL, -- see 9.2
  status TEXT NOT NULL,                     -- streaming | complete | error | interrupted
  data TEXT NOT NULL,                       -- JSON, shape by type
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (message_id, idx)
);
CREATE TABLE principals (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE identities (
  platform TEXT NOT NULL, external_id TEXT NOT NULL,  -- ("web","owner"), ("discord","<user id>")
  principal_id TEXT NOT NULL REFERENCES principals(id), PRIMARY KEY (platform, external_id)
);
CREATE TABLE blobs (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, mime TEXT, size INTEGER NOT NULL, name TEXT, created_at INTEGER NOT NULL);
CREATE TABLE plugin_kv (plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (plugin, key));
CREATE INDEX messages_session ON messages(session_id, seq);
CREATE INDEX runs_session ON runs(session_id, started_at);
```

`projects.settings` keeps the keys listed above. Per-project plugin settings (12.1's project layer) are not in the database: they live in `<valetHome>/project-data/<project-id>/settings.json`, which core owns and watches. The generic project routes and `Store.projects` never read or write that file; core deletes it with the project.

Blob bytes live at `~/.valet/blobs/<sha256[0:2]>/<sha256>`, and rows point at them. Full-text search over part text (for "read our last session and continue") uses an FTS5 table if Bun's bundled SQLite has FTS5 enabled. That gets checked in M0. The fallback is `LIKE` over `parts`.

### 8.3 Roles

Every run has an **effective role**: the lowest role among the principals who can see its output. A DM with Owner is `owner`. Owner alone in the web UI is `owner`. A Discord channel where Friend can read is `trusted`, even when Owner sent the message. `valet-agent` computes it when it creates the run, with the SDK helper `effectiveRole(author, binding)`, from the trigger message's author and the audience the platform supplies in `binding.meta.audienceRole`. Core stores it and puts it on `caller.actor` for everything in the run. Core never checks it. Tools (`minRole`), ContextManager (which persona files to load) and route handlers each check it themselves and deny.

### 8.4 The `Store` API

The `Store` API is what plugins see. Every mutation goes through the action events above.

```ts
export interface Project { id: string; name: string; workspaceDir: string; settings: Record<string, unknown>; createdAt: number; updatedAt: number }
export interface Session {
  id: string; projectId: string; title: string | null; color: string | null; parentSessionId: string | null;
  status: "idle" | "running" | "archived"; settings: SessionSettings; providerState: Record<string, unknown>;
  createdAt: number; updatedAt: number; lastMessageAt: number | null;
}
export interface SessionSettings {
  model?: ModelRef & { fallbacks?: ModelRef[] };
  persona?: string;                   // persona override; default comes from the project
  titlePlaceholder?: string;          // title valet-agent derived from the first message; an auto title may replace it only while session.title still equals it
  [pluginNamespace: string]: unknown; // e.g. "agent": { queueMode: "interrupt" }
}
export interface Run { id: string; sessionId: string; triggerMessageId: string | null; status: "queued" | "running" | "complete" | "cancelled" | "error" | "interrupted"; role: Role; provider: string | null; model: string | null; startedAt: number | null; endedAt: number | null; error: string | null }
export interface Message { id: string; sessionId: string; seq: number; role: "user" | "assistant" | "system" | "tool"; authorPrincipalId: string | null; runId: string | null; status: "streaming" | "complete" | "error" | "interrupted"; origin: (ChannelBinding & { externalId?: string }) | null; meta: Record<string, unknown>; createdAt: number; updatedAt: number }
export interface Part { id: string; messageId: string; idx: number; status: "streaming" | "complete" | "error" | "interrupted"; type: PartData["type"]; data: PartData; createdAt: number; updatedAt: number }
export interface Principal { id: string; displayName: string; role: Role }

export type CancelledResult = { cancelled: true; cancelReason?: string; denied?: Denial };
export interface ActorRef { principalId: string }

export interface Store {
  /** A view whose writes carry this actor on `caller.actor`. The claim is vouched for by your plugin id, and hooks see both. A message write defaults the actor to its author. */
  as(actor: ActorRef): Store;
  projects: {
    get(id: string): Project | undefined;
    list(): Project[];
    create(p: Pick<Project, "name" | "workspaceDir"> & { settings?: Project["settings"] }): Promise<Project | CancelledResult>;
    update(id: string, patch: Partial<Pick<Project, "name" | "workspaceDir" | "settings">>): Promise<Project | CancelledResult>;
    /** Unregisters the project; refuses while it still has sessions. Never touches the directory. */
    delete(id: string): Promise<Project | CancelledResult>;
  };
  sessions: {
    get(id: string): Session | undefined;
    list(q: { projectId?: string; status?: Session["status"]; limit?: number; before?: number }): Session[];
    create(s: { projectId: string; title?: string; settings?: SessionSettings; parentSessionId?: string }): Promise<Session | CancelledResult>;
    update(id: string, patch: Partial<Pick<Session, "title" | "color" | "status" | "settings">>): Promise<Session | CancelledResult>;
    setProviderState(id: string, provider: string, state: unknown): void; // no event: private bookkeeping for one provider
    bind(id: string, binding: ChannelBinding): Promise<void>;
    findByBinding(platform: string, conversationId: string): Session | undefined;
  };
  messages: {
    list(sessionId: string, q?: { beforeSeq?: number; limit?: number }): { message: Message; parts: Part[] }[];
    create(m: { sessionId: string; role: Message["role"]; authorPrincipalId?: string; runId?: string; origin?: Message["origin"]; status?: Message["status"]; parts: PartData[] }): Promise<{ message: Message; parts: Part[] } | CancelledResult>;
    /** Opens a streaming part; deltas go out as `message.delta` signals and are checkpointed to the row every 500ms. */
    openPart(messageId: string, data: PartData): PartWriter;
    complete(messageId: string, status: "complete" | "error" | "interrupted"): Promise<void>;
  };
  runs: {
    get(id: string): Run | undefined;
    create(r: { sessionId: string; triggerMessageId?: string; role: Role }): Run;
    update(id: string, patch: Partial<Pick<Run, "status" | "provider" | "model" | "error">> & { usage?: Record<string, number> }): void;
    cancel(id: string, by: string): Promise<void>;  // emits run.cancel
  };
  principals: {
    get(id: string): Principal | undefined;
    resolveIdentity(platform: string, externalId: string, fallback?: { displayName: string }): Principal; // unknown -> new guest
    link(principalId: string, platform: string, externalId: string): Promise<void>;
    setRole(principalId: string, role: Role): Promise<void>;
  };
  blobs: {
    put(bytes: Uint8Array | Blob, meta: { mime?: string; name?: string }): Promise<{ id: string }>;
    path(id: string): string;
  };
}

export interface PartWriter {
  readonly partId: string;
  append(delta: string): void;
  replace(data: PartData): void;
  close(status: "complete" | "error" | "interrupted", final?: PartData): void;
}

export interface PluginStorage {
  kv: { get<T>(key: string): T | undefined; set(key: string, value: unknown): void; delete(key: string): void; list(prefix?: string): string[] };
  /** Plugin-owned tables, named p_<namespace>_*. Migrations run before activate(). */
  sql: { migrate(migrations: { id: string; up: string }[]): void; db: import("bun:sqlite").Database };
}
```

Plugin tables are a convention (`p_<namespace>_` prefix, the plugin's own migrations), not a sandbox. In-process plugins could touch any table, and v1 accepts that (decision 3). A plugin's files go in `ctx.paths.data` (`~/.valet/data/<plugin-id>/`).

## 9. Projects, sessions and messages

### 9.1 Model

```
Project (workspace dir, persona, default model)
 └─ Session (title, color, model + fallbacks, bindings, provider_state)
     ├─ Run (one agent turn; queued → running → complete|cancelled|error|interrupted)
     └─ Message (seq, role, author, status, origin)
         └─ Part[] (text | reasoning | tool-call | file | notice | compaction | custom)
```

- **Personas are files in the project's workspace dir** (`AGENTS.md`, `SOUL.md`, and so on). Project settings choose which files load and in what order. There is no persona table, so the agent can edit its own persona with its fs tools, as Helper does today.
- **Models are session settings** with project defaults. The picker (`/model` or the UI dropdown) is a `session.update`. Changing models mid-session on an `agent` provider calls `AgentSession.setModel` when the provider supports it. Otherwise it reseeds a new remote session through `ContextManager.preamble` plus a compaction summary.
- **Prompts are data too.** ContextManager reads `project.settings.context.system` (a template) and the persona file list. Nothing in code embeds the persona.
- **Subagents** are child sessions (`parent_session_id`) started by a `valet-agent` tool. They come after v1 but the model supports them now.

### 9.2 Parts

```ts
export type PartData =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; callId: string; name: string; title?: string; input: unknown;
      output?: string; result?: ToolResult; status: "pending" | "running" | "done" | "error" | "cancelled" | "denied" }
  | { type: "file"; blobId: string; name: string; mime: string }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }   // "turn interrupted by restart", "exec job 12 finished"
  | { type: "compaction"; by: string; status: "in_progress" | "completed" | "failed" | "cancelled"; coversThroughSeq: number; summary?: string; error?: string }  // by "valet" or a harness label; only a completed valet compaction with a summary changes valet's history
  | { type: "custom"; kind: string; title: string; text: string; data: unknown };  // kind: a registered part type id (9.4)
```

A tool call and its result are one part that updates in place. That's what the "tool stepping" UI renders, and it also keeps the call and its result together when the context is rebuilt. `ModelMessage`s are derived from parts by ContextManager and are never stored.

### 9.3 Lifecycle of a turn (web, `model` provider)

1. The UI calls `POST /api/core/sessions/:id/messages`, and core runs the `message.create` action. A before hook may treat `/model opus` as a command and cancel the message. Otherwise the message is persisted.
2. `valet-agent`'s after hook queues a run. One run is active per session. A new user message during a run follows `valet-agent`'s global `queueMode` setting: `queue` (the default) or `interrupt`. There is no per-session override and no `steer`.
3. The run starts. `valet-agent` creates the assistant message (`streaming`) and calls `context.build()`, then `inference.stream()`. Deltas go to `PartWriter.append`, which sends `message.delta` signals to WS.
4. For each tool call: `tool.call` (before hooks may deny), then `tool.invoke` (with `progress()` streaming), then the part update. The loop continues until `finish: stop`.
5. `message.complete` and `run.end`. If `context.shouldCompact()` returns true, compaction runs before the next run.

For an `agent` provider (Devin), step 3 opens or reopens an `AgentSession` from `provider_state`. On first open it sends `context.preamble()`, then maps `AgentEvent`s onto the same parts. Step 4 happens inside Devin. Calls to valet's MCP tools still pass through `tool.call`, and Devin's built-in tools appear as tool-call parts mirrored from ACP.

### 9.4 Plugin-defined part types

The built-in part types are fixed. Anything else is a `custom` part whose `kind` names an entry in core's part type registry, so a plugin can add a part (a job-end notification, say) without a core change.

```ts
export interface PartTypeDefinition {
  id: string;                        // "<plugin id>/<name>@<major>", e.g. "valet-exec/job-end@1"
  description?: string;
  schema: Record<string, unknown>;   // JSON schema (core's validator subset) for `data`
  view?: PartTypeView;               // rendering hints for clients without a renderer for this id
  wakes?: boolean;                   // a `system` message holding this part starts a run, like a user message
}
export interface PartTypeView { collapsed?: boolean; level?: "info" | "warn" | "error"; icon?: string; fields?: string[] }
export interface PartType extends PartTypeDefinition {
  plugin: { id: string; version: string; repository?: string };   // from the defining plugin's manifest
  definedAt: number;
  updatedAt: number;
}
export interface PartTypes {
  define(def: PartTypeDefinition): PartType;
  get(id: string): PartType | undefined;
  list(): PartType[];
}
```

- **Registry.** Core keeps every definition in `<valetHome>/part-types.json`, one JSON array, and serves it at `GET /api/core/part-types`. A plugin calls `store.partTypes.define()` on every activate, and core merges by id. Entries are never removed: when a plugin is uninstalled its parts stay readable, and reinstalling it picks the same entry back up.
- **Ownership.** An id must start with the defining plugin's id, and only that plugin may write parts of that kind. Core rejects a part whose `kind` is unknown or whose `data` fails the schema, on `messages.create`, `openPart`, `replace` and `close`.
- **Versions.** A published `id@major` never changes its schema: defining it again with another schema throws. Other fields (description, view, wakes, origin) may change. A breaking change is a new major; old majors stay in the registry and old parts keep their kind.
- **Two sides.** `title` is the collapsed header people see; `text` is what the model sees. Both are written with the part and never recomputed, so a plugin update can't rewrite history (or a prompt cache), and a client or ContextManager that doesn't know the kind can still show it.
- **Rendering.** A client renders kinds it knows its own way, keyed by id and major. For anything else it shows a collapsed block with `title`, expanding to `text`, the kind and its origin (plugin, version, repository, and whether it is loaded), with raw `data` behind a second expander. `view` hints refine that block. Custom parts take `replace()`, not deltas.
- **Messages.** A message of a custom type is a message holding one custom part. A `system` message holding a part whose type `wakes` is a notification: valet-agent runs on it under its author's role. Only plugins can post one, since a control-plane caller owns no part types.

### 9.5 Registering, relocating and deleting projects

A project points at a directory; it does not own it. Registering, relocating and deleting a project change the `projects` row and nothing on disk. The REST routes below validate paths before calling the `Store`.

- **Paths.** A `workspaceDir` arriving over REST is trimmed, and a leading `~` or `~/` expands to the home directory of the user valet runs as. It must then be absolute, or the request fails with 400 `bad_request`. Core resolves `.`, `..` and trailing slashes, then follows symlinks to the real path, and that real path is what it stores. A path that doesn't exist is 404 `not_found`, and one that isn't a directory is 400 `bad_request`. Core never creates the directory here: a client that wants a new folder calls `POST /api/core/fs/mkdir` first (10.4).
- **One project per directory.** No two projects share a `workspaceDir`. Registering or relocating onto a directory another project already has fails with 409 `conflict`, and the error carries that project's `projectId`. The comparison is exact on the stored real path, so a directory inside another project's directory is allowed.
- **Register.** `POST /api/core/projects` takes `{ workspaceDir, name?, settings? }`. `name` defaults to the directory's last segment when it is missing or blank. Success is 201 with the project, through the `project.create` action.
- **Relocate.** `PATCH /api/core/projects/:id` accepts `workspaceDir` beside `name` and `settings`, and relocating is a `project.update` whose payload carries the new `workspaceDir`. Nothing is moved or copied: the files stay where they are, and the project now points at the new directory. Sessions, their `provider_state` and running jobs are left as they are.
- **Delete.** `DELETE /api/core/projects/:id` runs the `project.delete` action with `{ project }`. A project that still has sessions, of any status including `archived`, is refused with 409 `in_use`, and the error carries `sessions`, the count. Delete them first (`DELETE /api/core/sessions/:id`). The check runs inside the write's transaction, after the `before` hooks, so a `before` hook may see a delete that then fails, and `after` fires only when the row is gone. On success the response is 200 with the deleted project. The workspace directory and its files are never touched, and plugin-owned rows or files that mention the project id are not cleaned up.
- **Errors.** Each failure is `{ error: { code, message, ...extra } }`, as on every core route. An unknown project id is 404 `not_found`.

## 10. HTTP and WebSocket host (control plane)

There is one `Bun.serve` instance, default `127.0.0.1:7417`. It is the **control plane**: the API for controlling valet itself. That means core REST, the WS protocol and plugin control routes (such as `valet-devin`'s MCP endpoint and webhooks). It serves no HTML, no static files and no SPA. A UI is a client of this API, like the CLI and scripts, and it runs its own server on its own port (`valet-ui`, section 11.5).

### 10.1 Routing

| Path | Owner |
|---|---|
| `/api/core/*` | Core REST: projects, sessions, messages, runs (cancel), principals, plugins, blobs, folder browsing (10.4) |
| `/ws` | Core WebSocket, multiplexed (10.3) |
| `/plugins/<plugin-id>/*` | Plugin control routes mounted via `ctx.http`: JSON, MCP, webhooks |
| `/` | A JSON status document `{ name, version, plugins }`, and nothing else |

```ts
export type RouteHandler = (req: Request, ctx: RequestContext) => Response | Promise<Response>;
export interface RequestContext { caller: Caller; principal: Principal | undefined; params: Record<string, string>; url: URL }

export interface HttpHost {
  /** Path is relative to /plugins/<id>; ":param" segments are supported. Non-public routes need an identified principal; beyond that, serving is the handler's call. */
  route(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, handler: RouteHandler, opts?: { public?: boolean }): Disposable;
  /** Absolute URL of a mounted path, for MCP endpoints and webhooks. */
  url(path: string): string;
}
```

Core enforces the control-plane rule:

- There is no `static()` and no way to claim `/`. A plugin route that responds with `text/html` gets a 500 and a log line. Every response carries `Content-Security-Policy: default-src 'none'`.
- Browsers may call the API only from origins in `server.allowedOrigins` (CORS with credentials). The UI's origin goes there.
- Every request first becomes a `control.request` action event (10.2), so any plugin can deny any request, including requests to core's own routes.

`public: true` is for webhooks that do their own signature checks.

### 10.2 Identity and auth, federated to plugins

Core proves nothing about people. Plugins do, and each plugin decides whom it serves:

1. **Identify.** For each request, core asks the `identity@1` providers in load order. The first one that returns a result names the principal. A provider may instead throw `ServiceDeniedError` to reject the request outright. If none matches, the request is anonymous, and anonymous requests reach only `public` routes. That rule is core's only auth rule, and it exists so that a missing or broken auth plugin fails closed.
2. **Admit.** Core emits `control.request` with `caller = { plugin: "core", actor, authenticatedBy }`. Any plugin's before hook may `deny`, which returns 403 (or a `denied` WS result).
3. **Serve.** The handler runs. The core actions it triggers carry the same caller, so action hooks can still deny.

```ts
export interface AuthResult { principalId: string; /** Revocable credential, e.g. a device or token id. */ credentialId?: string }
export interface IdentityProvider {
  authenticate(req: Request): AuthResult | undefined | Promise<AuthResult | undefined>;
}
```

`valet-auth` is the base identity plugin (11.7). It can be replaced, for example by a Tailscale-identity plugin, with no change to core. Platform principals such as Discord users never authenticate over HTTP. `valet-discord` vouches for them through `store.as()`, and hooks see that the claim comes from `valet-discord`.

The same pattern applies below the control plane. Every event, hook and scope call carries a `Caller` stamped by core (section 7.2), so any plugin can refuse a plugin or a principal it doesn't want to serve. For example, `valet-exec` denies `tool.call` for its tools below `owner`, and `valet-contextmanager` won't load `MEMORY.md` for a `trusted` run. No plugin, base or not, has a way around this. Core has no bypass and no private API.

### 10.3 WebSocket protocol

All frames are JSON over `/ws`. The connection is identified the same way as HTTP (10.2), and `sub` and `call` frames go through `control.request` (kinds `ws.sub` and `ws.call`). So topic access is a deny hook too: `valet-auth` guards core topics, and `valet-exec` guards `exec:<jobId>`.

Sockets are re-identified with their upgrade headers whenever any plugin emits `identity.changed` (payload `{ principalId? }`, debounced to 250 ms) and every 60 s. A socket that no longer identifies as the same principal is closed with code `4401` (`unauthenticated`). `POST /sessions/:id/messages` accepts an optional `clientMessageId` (string, at most 100 chars) stored in `message.meta.clientMessageId`. A repeat within the session's last 50 messages returns the existing message with 200 and creates nothing, so no second run starts.

```ts
type ClientFrame =
  | { type: "sub"; topics: string[]; since?: Record<string, number> } // resume from per-topic seq
  | { type: "unsub"; topics: string[] }
  | { type: "call"; id: string; method: string; params?: unknown }    // routed to a plugin handler by "<namespace>." prefix
  | { type: "ping" };

type ServerFrame =
  | { type: "event"; topic: string; seq: number; name: string; data: unknown }
  | { type: "result"; id: string; ok: true; data?: unknown }
  | { type: "result"; id: string; ok: false; error: { code: string; message: string } } // code "denied" carries the Denial
  | { type: "gap"; topic: string }   // asked-for seq fell off the buffer: refetch state over REST
  | { type: "pong" };

export interface WsHost {
  handle(method: string, fn: (params: unknown, ctx: RequestContext) => unknown | Promise<unknown>): Disposable;
  publish(topic: string, name: string, data: unknown): void;
}
```

Core topics:

- `sessions:<projectId>`: list changes.
- `session:<id>`: message, part, delta, run and status events.
- `plugins`: plugin state changes.

Plugins publish under their own prefixes, e.g. `exec:<jobId>`. Core keeps a ring buffer of the last 2,000 frames for each topic. A reconnecting tab sends `since` and catches up without a refetch. A tab that has fallen further behind gets `gap` and refetches over REST. That's how a phone that slept through a long exec shows the right state.

### 10.4 Folder browsing

A client registering or relocating a project needs to pick a directory on the valet host. Two core routes let it browse folders and make one. They read and create directories only. They never list files, read file contents or delete anything.

```ts
export interface DirListing {
  path: string;                            // the listed directory, absolute and symlink-resolved
  parent: string | null;                   // null at the filesystem root
  home: string;                            // home directory of the user valet runs as
  dirs: { name: string; path: string }[];  // subdirectories only
}
```

- **`GET /api/core/fs/list?path=<dir>&hidden=1`** returns a `DirListing`. `path` is optional and defaults to `home`. It goes through the same rules as a `workspaceDir` (9.5): `~` expands, it must be absolute, symlinks resolve, and a missing path is 404 while a file is 400. A directory valet can't read is 400 `bad_request`. `dirs` holds the subdirectories, including symlinks that point at directories (listed under the link's own path, not its target), sorted by name without regard to case. Names starting with `.` are left out unless `hidden=1`.
- **`POST /api/core/fs/mkdir`** takes `{ parent, name }` and creates one new folder. `parent` must be an existing directory (same rules). `name` is trimmed and must be a single path segment: empty, `.`, `..` and anything containing `/` are 400 `bad_request`. An existing entry with that name is 409 `conflict` and is never overwritten. Success is 201 with `{ path }`.
- **Access.** Neither route is an action event and neither has its own role check, in keeping with 10.2. Like every core route, each request is a `control.request` first, so the identity plugin's policy decides who may browse; under decision 5 that means owner only. With an admitted caller the routes reach any directory the valet user can read, `/` included. That is intended: browsing is not limited to the home directory or a configured set of roots (Owner, 2026-11-17).

## 11. How v1 lands as plugins

| v1 must-have (audit rank) | Plugin(s) | Core features used |
|---|---|---|
| 1. Multi-session web chat | `valet-ui` (own server), `valet-auth`, `valet-agent` | REST + `session:<id>` topics, session colors, `message.delta` |
| 2. Long-running exec that survives restarts | `valet-exec` | `tools@1`, plugin storage, signals, `run.interrupted` |
| 3. Persona and memory files intact | `valet-contextmanager`, `valet-fs` (read/write/edit tools) | project workspace dir, `context@1` |
| 4. Devin CLI with model picker and fallbacks | `valet-devin` | `inference@1` (agent kind), session `provider_state`, MCP route |
| 5. Compaction and resume | `valet-contextmanager` (compaction), `valet-agent` (resume policy) | `compaction` parts, `run.interrupted`, FTS |
| 6. Discord with owner/friend tiers | `valet-discord` | `platform@1`, principals and identities, effective role, `tool.call` policy |
| Skills (rank 8) | `valet-skills` | Lists `skills/*/SKILL.md` in the preamble, `skill_read` tool |
| Scheduled jobs and nightly memory "dreaming" (rank 9) | `valet-scheduler` (v1); dreaming as a later consumer | Job entities; each fire() spawns a fresh work session |

### 11.1 `valet-agent`

- **Requires:** `inference@1` and `context@1`, not a particular plugin. Optionally requires `tools@1`.
- **Owns:** the run queue for each session, queue/interrupt modes, the tool loop for `model` providers, `AgentSession` bridging for `agent` providers, fallbacks, `tool.call` emission, slash commands (`/model`, `/compact`, `/new`, `/stop`), and the model catalog.
- **Model catalog.** Every provider's `listModels()`, merged with the `models` list in valet-agent's config. A row `{ provider, id, ... }` overrides what the provider lists (name, context window, efforts, fast mode) or adds a model the provider does not list (`custom: true`, passed to the provider as is). `show` puts a model in pickers or takes it out; a row with `id: "*"` sets the default for that provider's unlisted models, which makes the list an allowlist. Without a row, a model shows unless its provider marks it `hidden`. Runs and the context window bar use the catalog's values. `GET /plugins/valet-agent/models` serves the catalog with each provider's own values beside the overrides.
- **Legacy model ids.** A ref whose id is not in the catalog but ends in a speed word (`-fast`, `-priority`, `-lightning`) or an effort word (`-low` ... `-max`) over a listed model is read as that model with those options. At boot `valet-agent` rewrites such refs in sessions and projects once.
- **Resume policy:**
  - On `run.interrupted`, it appends a `notice` part ("previous turn was interrupted by a restart") to the interrupted message.
  - If the run started less than 6 hours ago and was not cancelled by a user, it auto-resumes once with a new run whose trigger is that notice. An `agent` session reopens with its `resumeId`.
  - Otherwise the interruption stays visible and the user decides.
- **Public-API rule test:** CI boots core with `valet-agent` loaded from a temp directory outside the repo, importing only the published `@valethq/sdk`. Lint forbids `@valethq/core` imports under `plugins/`.

### 11.2 `valet-contextmanager`

- **Defines and provides `context@1`.**
- **Persona file set, from project settings.** The default matches OpenClaw: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md` and today's plus yesterday's `memory/YYYY-MM-DD.md`. Files load in that order, under headed sections. A per-file byte cap warns rather than truncates silently.
- **Role-aware loading.** Files can set `minRole`. The default is that `MEMORY.md` and the daily memory files load only for `owner` runs (decision 5).
- **History** (`model` providers): the latest `compaction` part that carries a `summary`, plus every message after `coversThroughSeq`, trimmed from the oldest if over budget. Budget = model context window − reserve for output.
- **Compaction:** auto at 80% of the window (configurable), or manual with `/compact`. It uses the session's own model unless `settings.context.compactionModel` names another. For `agent` providers that compact themselves, valet never compacts: the harness's `compaction-start` and `compaction-end` events open and close a `compaction` part in the same chat ("Compacting (by Claude Code)…", then "Compacted (by Claude Code)"), with no new session. `/compact` asks the harness to compact through `AgentSession.compact` and follows the same events. Valet only reseeds when it changes models or the remote session is lost.
- **"Read our last session":** a `session_search` tool over FTS, plus `session_read(sessionId, range)`.

### 11.3 `valet-devin`

- **Provides `inference@1`** (kind `agent`) under key `devin-cli`.
- **Process model:** one long-lived `devin acp` child process speaks ACP (JSON-RPC over stdio) and multiplexes all sessions. The plugin restarts it with backoff if it dies. The flow is `initialize`, then `session/new` with `cwd` = the project workspace and `mcpServers` = the per-run valet MCP endpoint, then `session/prompt`. `session/update` notifications map to `AgentEvent`s, and `session/cancel` handles stop.
- **Config:** `command` (default `devin`), `permissionMode` (`accept-edits`, as in OpenClaw), `refusalFallback`.
- **Model list:** `listModels()` comes from `devin models` and is cached, with a fallback to a config list (OpenClaw's list: Opus 5.5, Sonnet 5.5, GPT-6.1 Sol, SWE 2, GLM-5.3 Flash, ...).
- **Resume:** the remote session id goes into `sessions.provider_state["devin-cli"].resumeId`. On reopen, the plugin uses ACP `session/load` when the agent advertises `loadSession`. Otherwise it falls back to a new remote session seeded with `preamble()` plus the latest compaction summary. **M1 spike result** (devin 3000.12.57): `initialize` advertises `loadSession: true`, and `session/load` works; before it responds, the agent replays the whole history as `session/update` notifications, which the plugin swallows. There is no `session/set_model` (-32601): the model is a `configOptions` entry (`id: "model"`) set with `session/set_config_option`, and `session/set_mode` picks the permission mode. In `accept-edits`, built-in exec runs without a `session/request_permission`, so per-call denial only applies where Devin asks; `ask` mode removes the shell tool entirely, and Devin's `Deny(...)` permission rules are the route for M2 to steer Devin-backed sessions to `valet-exec` over MCP (decision 1).
- **OpenAI-compatible endpoints** (for example CLIProxyAPI) are a separate `valet-openai` plugin of kind `model`. It is a v1.1 item but proves the `model` path.

### 11.4 `valet-exec`

These are the two tools Helper already uses most (17.4k `exec` events and 2.9k `process` events in the audit), with the same names and similar arguments so that existing habits and notes still apply:

- `exec { command, cwd?, env?, yieldMs = 10000, timeoutSec? }` runs the command. If it finishes within `yieldMs`, the call returns its output. Otherwise the call returns `{ jobId, status: "running", outputSoFar }` and the job continues in the background.
- `process { action: "list" | "poll" | "log" | "write" | "kill", jobId?, offset?, data? }`.

**Survival design:**

- **Detached jobs.** Each job runs outside the valet process tree. When user systemd is available (host has systemd 259), the job runs as `systemd-run --user --unit=valet-exec-<id> --collect --property=KillMode=control-group -- sh -c '<cmd>; echo $? > exit'`, which places it in its own cgroup. Without systemd it runs as `setsid sh -c ...` with the parent unref'd. Either way, a valet restart doesn't kill the job, and the job's RAM doesn't count against valet. OpenClaw's 2.75 GiB gateway cap was shared with every child it spawned.
- **Job directory.** Each job writes into `~/.valet/data/valet-exec/jobs/<id>/`: `cmd`, `out.log` (stdout and stderr together), `exit` and `pid`. The `p_exec_jobs` table indexes them, linked to `sessionId`, `runId` and `callId`.
- **Streaming.** The plugin tails `out.log` from a stored offset. Output goes out as an `exec.output` signal, as WS topic `exec:<id>` and as `ToolCall.progress()` while the originating call is still waiting.
- **Re-attach at boot.** On activate, the plugin scans for running jobs (checking `systemctl --user is-active` or the pid), resumes tailing them, and finalizes jobs that ended while valet was down.
- **Completion notifications.** When a background job ends, the plugin emits `exec.job.end` and posts a `system` message holding a `valet-exec/job-end@1` part (9.4), whose type `wakes`: people see "Process finished", the model sees the status and the tail of the log, and an idle session starts a run. This replaces OpenClaw's exec-completion polling.
- **Interrupt.** `kill` (or a run cancel that covers a foreground job) sends SIGTERM to the process group or `systemctl --user stop`, then SIGKILL after 5s.
- **Output caps.** A tool result returns the first 2 KB and last 30 KB plus the log path, so `process log` can page the rest. Logs are kept for 14 days.
- **Role.** `minRole: "owner"`. Friends never get a shell (decision 5).
- **Not in v1:** a PTY (interactive TUIs). stdin is a FIFO that `process write` can feed.

### 11.5 `valet-ui`

- **Runs its own `Bun.serve` on its own port** (default `127.0.0.1:7418`) and serves a static SPA built by its own `bun build`. It mounts nothing on the control plane.
- **Talks to core only through the control plane** (REST and WS), cross-origin, with the signed-in user's credentials. That is the same surface the CLI uses. It needs nothing from `ctx` beyond its config, so it could also run as a separate process without changes.
- **Its origin goes in `server.allowedOrigins`.**
- **Visuals are Owner's to iterate.** This doc fixes only the data the UI gets: session colors, tool-call parts for tool stepping, and `run.usage.contextTokens` plus the model's `contextWindow` for the context window bar.

### 11.6 `valet-discord`

- **Owner and friend tiers.** Config maps Discord user IDs to principals: Owner → `owner`, Friend → `trusted`. Anyone else becomes `guest`.
- **Channel rules:** open channels need no mention, every other channel needs one, and DMs are allowed. This matches today's guild setup.
- **Sessions:** one session per channel or DM, via `session_bindings`.
- **Effective role:** `binding.meta.audienceRole` is the lowest role among the channel's readers. Tests treat guild channels as `trusted` and an owner DM as `owner`.
- **Delivery and queueing:** `after:message.complete` sends the reply, chunked to Discord's 2,000-character limit, and `typing()` runs while a run is active. Queue mode defaults to `interrupt`.
- **Commands:** owner-only commands go through the same `message.create` before hook, which checks the author's role.

### 11.7 `valet-auth`

- **Provides `identity@1`.** On first boot it logs a one-time setup URL that sets the owner password (argon2id via `Bun.password`). Logins issue HTTP-only, `SameSite=Strict` cookies per device. UI and API share a hostname on different ports, so they are same-site. Bearer tokens serve API clients (CLI, scripts). Devices and tokens live in its own `p_auth_*` tables and are listed and revoked at `/plugins/valet-auth/devices`.
- **Default control-plane policy**, as before hooks on `control.request`: `owner` gets everything. `trusted` and `guest` principals get nothing on the control plane in v1, since friends use Discord (decision 5).
- **Public-API only,** like every base plugin. Anything it can do, a replacement auth plugin can do.

### 11.8 `valet-scheduler`

Jobs are entities, not sessions. A job has an id, title, model, prompt, project, creator, role (never above the creator's), trigger, timezone, retention and optional notes. Each `fire()` opens a **fresh** work session in `projectId` with `settings.model` and `settings.agent.jobId` (do not set `parentSessionId`; that is for subagents), optionally prepends the final assistant replies from the last N runs for continuity, and posts the prompt through `store.as({ principalId: creator }).messages.create` with `authorPrincipalId` stamped. `valet-agent`'s existing `after("message.create")` starts the run; the scheduler does not change agent.

- **Triggers (v1):** 5-field cron (in the job timezone), interval, one-off (`at`, disable after success), and manual Run now. All go through the same `fire()` path.
- **Overlap (default):** if the job fires while its previous work session is still running, post a notice into that session saying the job just fired again, leave the run going, and do not start a second run (status `skipped`).
- **Missed runs:** if Valet was down through due times, catch up **once** on boot, then schedule the next future time. No backlog.
- **Process:** in-process timer (sleep until `nextRunAt` / short tick); recompute on activate; clear in `onDispose`. No systemd timers.
- **ACL:** `scheduler:job.read` and `scheduler:job.write`. Anyone with `job.write` may create jobs; the job's role is capped at the creator's role.
- **Settings v3:** master enable, default timezone (`America/New_York`), default retention (keep last N runs and/or N days).
- **HTTP:** CRUD + fire under `/plugins/valet-scheduler/...`.
- **Agent tool:** thin create/list/update/enable/disable/fire, respecting ACL and the role cap.
- **UI:** a tucked-away Jobs section (hidden by default). Work sessions with `settings.agent.jobId` stay out of the main session list. Delivery through `platform@1` is reserved for later.
- **Deferred:** platform delivery, utility-model summaries of prior runs, event triggers. Nightly memory "dreaming" is a later plugin that calls `fire()`.

## 12. Boot, config and settings

- **Config:** `~/.valet/config.json`, with `VALET_HOME` overriding the location.

  ```json
  {
    "server": { "host": "127.0.0.1", "port": 7417, "allowedOrigins": ["https://host.<tailnet>.ts.net"] },
    "pluginPaths": ["~/.valet/plugins"],
    "plugins": {
      "valet-devin": { "enabled": true, "config": { "permissionMode": "accept-edits" } },
      "valet-ui": { "enabled": true, "config": { "port": 7418 } },
      "valet-discord": { "enabled": false }
    }
  }
  ```

- **Settings (12.1)** sit on top of the config file: a user layer in `<valetHome>/settings.json` and per-project layers in `<valetHome>/project-data/<project-id>/settings.json`. **Secrets (12.2)** are files beside it, and settings may reference them as `${secret:name}`.
- **Service:** `valet start` runs in the foreground, and the deployment is a user systemd unit `valet.service` with `Restart=on-failure`. Jobs started by `valet-exec` run in their own units, so restarting `valet.service` leaves them running.
- **Migration from OpenClaw:** `valet import-openclaw` copies `~/.openclaw/workspace` into `~/.valet/projects/helper` (decision 2). It creates the Helper project with the persona file list and the model list, and leaves OpenClaw untouched. Importing transcripts is optional and comes later. The audit showed where they live (`openclaw-agent.sqlite`, `transcript_events`).
- **Logs:** JSON lines to stdout (journald) plus `~/.valet/logs/valet.log`, tagged with plugin id, session id and run id.

### 12.1 Settings

A plugin's settings are its config block. Its manifest's `settings` document (settings v3) describes both the config and its settings UI: a file reader (JSON/TOML, CLI) uses ids, storage kinds and defaults and passes stored strings (refs, unit strings) through unparsed; a UI uses everything. There is no second store. Inputs compose like a component library: a UI that doesn't know a type renders its base type. Core rejects a document that names a type core doesn't ship, so "renders its base" applies to UIs older than the document, never to core.

#### Hierarchy

```
Section          system | inference | tools          (navigation bucket, fixed list, in that order)
  Plugin         "Claude Code"                        (one page per plugin; a plugin may appear in more than one section)
    Subsection   { id: "tools", label: "Tooling" }    (tab or heading on the plugin page)
      Setting    { id: "permissionMode", ... }        (one config key, one value-bearing input)
      Display    { type: "note", ... }                (stores nothing)
```

- The section and subsection are presentation only. **They never appear in the config path.** Moving a setting to
  another subsection, or a plugin to another section, does not change any stored config.
- A setting's `id` is a top-level key of its plugin's config block, which lives where section 12 puts it:
  `{ "plugins": { "<pluginId>": { "enabled"?: boolean, "config"?: { "<settingId>": value } } } }`.
- Every subsection is listed explicitly; there is no implicit one. A plugin page with one subsection, counting
  runtime ones, shows no tabs.
- A plugin may appear in several sections at once (valet-agent's main page under `system`, its models page under
  `inference`): `sections` maps each named bucket to that plugin's own `order`, `icon` and subsection list.

#### Value rule

A setting stores the value of its one `input`. A setting that holds several values uses a `group` input, which
stores an object keyed by its inputs' ids. Display types store nothing and may sit beside settings in a subsection
or inside a `group`.

```toml
[plugins.valet-claudecode.config]
permissionMode = "acceptEdits"
utilityModel   = { model = "claude-haiku-5-5", effort = "low" }
```

Changing a setting's storage kind (a string becoming a `group`) is a breaking change and needs a `migrate` entry.

#### Document shape

Lives in `manifest.json` under `settings` (5.1). Core compiles it into the plugin's `configSchema` (see Compile).

```ts
interface SettingsDoc {
  sections: Partial<Record<"system" | "inference" | "tools", SectionDoc>>;
  types?: Record<string, InputDef>;    // plugin-local recipes; names start with "local:" (see Fallback)
}

interface SectionDoc {
  icon?: string;
  order?: number;                      // within the section; lower first
  subsections: Subsection[];           // at least one; shown in `order`, then listed order
}

interface Subsection {
  id: string;
  label: string;
  summary?: string;
  order?: number;
  items: (Setting | Display)[];
}

interface Setting {
  id: string;                          // config key
  label: string;
  summary?: string;                    // one line, under the label
  details?: string;                    // long help (markdown); falls back to summary
  input: Input;                        // value-bearing; label defaults to the setting's
  when?: Cond;                         // hide unless true
  scopes?: Scope[];                    // default ["user"]
  apply?: "live" | "restart";          // UI hint before saving; default "live"
  advanced?: boolean;                  // collapsed "Advanced" block on its subsection
  deprecated?: string;                 // shown on the setting; the setting is hidden unless a layer stores a value
  keywords?: string[];                 // for settings search
  migrate?: Migration[];               // see Migration
}

type Scope = "user" | "project";

interface InputBase {
  type: string;
  id?: string;                         // required inside a group (its key); unused on a setting's own input
  label?: string;
  summary?: string;
  default?: unknown;                   // a group without one takes its inputs' defaults
  required?: boolean;
  readonly?: boolean;
  when?: Cond;
  refs?: Resolver[];                   // which ${...} resolvers this input accepts (see References)
  ttl?: number;                        // cmd: cache lifetime, ms; default 60000 (see References)
}

type Resolver = "secret" | "file" | "env" | "cmd";
```

Setting, subsection and input ids match `/^[a-zA-Z][a-zA-Z0-9_-]*$/` (no `.`, so they can't collide with Path dot
syntax). Reserved words rejected at doc load: `enabled`, `constructor`, `__proto__`, `prototype`, `hasOwnProperty`.

#### Inputs

Each type has a **storage kind** (`boolean | number | string | array | object`) and either is a **primitive** or
names a **base** type.

##### Fallback

Every v3 UI implements the primitives and the v3 derived types. A UI that doesn't know a type renders its base,
recursively, down to a type it knows. Core only ever needs the storage kind, constraints and unit parser. A type
added after v3 must have a base whose rendering edits its stored value correctly, and may not accept stored forms
(like unit strings) its base doesn't.

Catalog types are recipes too: core ships each derived type as `{ base, ...fields }`, the same shape as a local
recipe. `PluginSettings.types` carries the chain for every non-primitive type the doc uses, so a UI older than core
can fall back without upgrading. Core fails a plugin whose doc uses a type core doesn't know.

Plugins define recipes in `types`. Names start with `local:` so they never collide with catalog types added later.
A recipe may only set fields its base understands. No plugin-shipped renderers.

```jsonc
"types": {
  "local:hostport": { "base": "strict_string", "pattern": "^[^:]+:\\d{1,5}$", "patternHint": "host:port" }
}
```

##### Primitives

| Type | Stores | Fields |
|---|---|---|
| `bool` | boolean | `style: switch \| checkbox` |
| `number` | number | `min`, `max`, `exclusiveMin`, `exclusiveMax`, `step`, `unit`, `integer`, `precision`, `style: field \| slider`, `scale: linear \| log \| steps`, `marks: {value,label}[]` |
| `range` | [number, number] | as `number` |
| `string` | string | `placeholder`, `minLength`, `maxLength`, `masked` (rendered but never echoed into the response body for runtime fields) |
| `tags` | string[] | free entry |
| `group` | object | `inputs: (Input \| Display)[]`, `layout: stack \| row` |
| `list` | array | `item: Input`, `style: rows \| table`, `min`, `max`, `addLabel` |
| `map` | object | `key: Input` (string-stored), `value: Input` |
| `variant` | object | `tag: string`, `cases: { value, label, inputs }[]` |

##### Derived

| Type | Base | Stores | Fields |
|---|---|---|---|
| `int` | `number` | number | `integer: true` |
| `percent` | `number` | number | stored 0–1, shown 0–100%; `min`/`max`/`exclusiveMin`/`exclusiveMax` are in stored units |
| `duration` | `int` | number (ms) | also accepts `"500ms"`, `"5m"`, `"1h30m"` |
| `bytes` | `int` | number | also accepts `"64 KiB"` (1024), `"64 KB"` (1000) |
| `tokens` | `int` | number | also accepts `"128k"`, `"1m"` |
| `strict_string` | `string` | string | `pattern`, `patternHint` |
| `text` | `string` | string | `lines`, `mono` |
| `code` | `text` | string | `language: json \| toml \| markdown \| shell \| regex` |
| `secret` | `string` | string | stores only `${secret:<name>}`; see References |
| `path` | `string` | string | `kind: file \| dir`, `mustExist` |
| `url` | `strict_string` | string | `schemes` |
| `color` | `strict_string` | string | pattern `#rrggbb` |
| `keybind` | `string` | string | captured shortcut |
| `select` | `string` | string | `options`, `style: dropdown \| segmented \| cards` |
| `multiselect` | `tags` | string[] | `options`, `style: checklist \| chips`, `min`, `max` |
| `ref` | `select` | string | `options.from` required; an entity id (model, tool, MCP server, plugin) |

Unit strings (`duration`, `bytes`, `tokens`) may be stored in any layer. Core parses them on load; a save stores
what was sent.

**Unset vs empty.** Unset means "take the default / inherit from the layer below". An explicitly stored `[]` (or
`""` where the type allows it) is a real value: claudecode's `tools` treats unset as "defaults" and `[]` as
"disable all", and cursor's `autoReview`/`sandbox` treat unset as "the SDK default". The UI always shows the
effective value with its source and offers a reset-to-inherited control that clears the layer's stored value.
Clearing a `multiselect` sends `[]`, not `null`.

##### Display

Store nothing. `id` is optional; `when` applies as for inputs.

| Type | Fields |
|---|---|
| `heading` | `text` |
| `note` | `text`, `tone` |
| `divider` | — |
| `link` | `text`, `href` |
| `badge` | `text`, `tone` |
| `stat` | `label`, `value`, `caption` |
| `meter` | `label`, `value` (0–100), `display`, `caption`, `status`, `marker` (0–100), `tone` |
| `table` | `columns`, `rows` |

`tone` is `normal | good | warning | critical`. `badge`, `stat`, `meter` and `table` may instead name `from` (a view
source, with `args` as for options): the view returns the type's fields and the UI merges them over the static ones.
| `action` | `text`, `action`, `args`, `confirm`, `tone` |

`list` with `style: table` covers plain tables. valet-ui's models table stays hand-written: it shows each provider's
own values beside the overrides and rows for models without an override, which a list of stored rows can't.

##### Options

```ts
interface Option { value: string; label?: string; summary?: string; icon?: string; group?: string }
type Options = Option[] | { from: SourceRef; args?: Record<string, unknown | { $: Path }> };
type SourceRef = string;   // "name" (own plugin) or "<pluginId>/name", e.g. "valet-agent/models"
```

Core validates static options as an enum. Options `from` a source are not validated against the source.

#### Dynamic behaviour

All declarative. No expressions beyond `Cond`.

**Paths.** A `Path` points into values in their stored shape: `"settingId"` or `"settingId.key.key"` through
groups, within the plugin. Inside a `list` item or `map` value, `"@"` is the current item and `"@.key"` a key in it.
In a runtime subsection, paths point into its own `get` values. Paths see values as `PluginSettings.values` holds
them: unit strings parsed, refs as raw text.

```ts
type Path = string;
type Cond =
  | { eq: [Path, unknown] } | { ne: [Path, unknown] } | { in: [Path, unknown[]] }
  | { set: Path } | { not: Cond } | { all: Cond[] } | { any: Cond[] };
```

**Sources.** Options and display values `from` a source call the owning plugin's `settings@2` contribution (see
Runtime) through the UI plugin. Arg values `{ "$": Path }` are filled from current form values, so efforts can
depend on the chosen model. If the owning plugin isn't active, the UI renders the input as its storage primitive
with a notice, so the stored value stays visible and editable.

**Conditions.** A hidden setting keeps its stored value. Core and UIs evaluate `when` and `required` on the same
thing: the raw stored text — `eq`/`ne`/`in` compare the stored value literally (a ref string never equals a resolved
value), `set` is true when the key is present and not `null`. `required` is enforced only where `when` holds, at
every depth. A condition on a ref-bearing input may only use `set`; a doc that uses `eq`/`ne`/`in` on a
ref-bearing input fails at load.

**Apply.** `apply` tells the UI before saving whether to expect a live change or a restart. Core still decides:
`PluginSettings.liveConfig` is false when the plugin has no `onConfigChange` listener, and the UI then treats every
setting as `restart`. What actually happened comes back in `restartRequired`.

**Editing a layer.** A form edits one layer and starts from that layer's stored values (`PluginSettings.layers`), not
the merged ones, so an unset key stays unset and a unit string stays a string. Inherited values show as
placeholders with their source; the reset-to-inherited control clears the stored value. When editing user scope in a
project's context, settings the project overrides are marked (`sources[id] === "project"`) but the field holds the
user value. A save sends only the keys the user touched — for a `group`, the whole group object, since layers
merge at the top level.

**Templating.** Not in v3. The `${...}` syntax (below) leaves room for `${= expr}` later.

#### Scopes (layers)

Layers merge in this order, each replacing the top-level keys of the one below:

1. schema defaults
2. config file (`<valetHome>/config.toml` or `config.json`, hand-edited)
3. `user`: `<valetHome>/settings.json`, written by core on save
4. `project`: `<valetHome>/project-data/<project-id>/settings.json`, written by core on save (and watched for
   hand edits), only for settings whose `scopes` include `"project"`

Config exists in three forms, and this section keeps them apart:

- **Stored**: each layer as written (unit strings and refs as text). The control plane edits these.
- **Desired**: stored layers migrated, merged, parsed and validated, with `secret:`, `file:` and `env:` resolved.
  `cmd:` is still text; it is resolved on read. What a restart would give the plugin.
- **Applied**: the desired block the plugin last accepted. It differs from desired while a change waits for a
  restart, or after a listener throws. `ctx.config` is the applied user block (layers 1–3).

A schema or required failure is 400 and writes nothing, so stored, desired and applied stay put. A save that passes
is stored and desired is recomputed. Before the write, core runs the plugin's `onConfigCheck(next, prev)` hook: a
throw there rejects the save (422, nothing written) — this is the plugin's veto for values that pass the schema but
are semantically wrong. After the write, every plugin's `onConfigChange` listeners run on the new desired block;
`ctx.config` only switches to it once **all** listeners have returned — until then plugins keep reading the last
applied block. If a listener throws, applied stays the last block the plugin accepted, `ctx.config` does not
change, and `restartRequired` carries the error. The save response is that `PluginSettings`, not a refusal. A
plugin with no listener is stored the same way and reported as needing a restart. A reload or a `file:` / secrets
re-resolve follows the same rule: desired becomes the new block, and no listener, or a throw, leaves applied where
it was and sets `restartRequired`. This replaces 12.1's rule that a throwing listener rejects the save and nothing
is written.

A plugin reads a project's view with `ctx.configFor(projectId)`: the project layer over the **applied** user block,
so a project without overrides always sees exactly `ctx.config`. Core rebuilds these snapshots whenever the applied
block or a project layer changes and publishes them whole; `secret:`, `file:` and `env:` are resolved before
publish. `configFor` looks one up synchronously; `cmd:` values come from the cache (see References).

An unknown project id, or a project without overrides for this plugin, returns `ctx.config`. A setting may list
`"project"` only if the plugin reads it through `configFor` at use time. Project saves are always live and don't
fire `onConfigChange` (they do run `onConfigCheck`, and a throw there is 400).

A project view can still turn invalid without a project save: after a plugin upgrade, a hand edit to the config
file or the project file, or a re-resolved ref. Core then drops that project's layer for the plugin (`configFor`
returns `ctx.config`), logs a warning and reports it in `issues` for `GET ?project=`. The stored override is kept
so the user can fix it; a project already listed in `issues` never blocks a user save.

Rules for the project layer:

- **Opt-in per setting.** The default scope is `["user"]`. Never offer project scope for settings that run
  commands, pick executables, widen permissions or carry endpoints or credentials.
- **No refs.** A project-layer value containing an unescaped `${` is rejected on save (400). `$${` stays literal
  `${` in this layer (it is never resolved, so the unescape rule does not apply to it).
- **Core-owned file.** Only the settings route writes `project-data/<project-id>/settings.json`; it is deleted when
  the project or the plugin's overrides for it are gone. Hand edits to the file are picked up by the watcher,
  re-validated, and dropped into `issues` when they fail. The file is JSON, same shape as `settings.json`.
- **No workspace file in v3.** A file in the project's workspace would be repo content, which needs a trust model
  first.

Per-session values are not a layer. Sessions belong to valet-agent, which keeps them in `session.settings` (the
model choice with effort and fast mode already does). No v3 setting declares a session scope.

#### Migration

```ts
interface Migration {
  from?: string;          // another setting id, or "kv:<key>" (a plugin_kv row); omitted: this setting, in place
  map?:                   // value transform; omitted: copy as is
    | { template: string }                    // old string spliced in at "{}", e.g. "${secret:{}}"
    | { scale: number }                       // old number times scale
    | { match: string }                       // regex; named groups that matched become an object; no match: dropped with a warning
    | { values: Record<string, unknown> };    // lookup; unlisted old values are dropped with a warning
}
```

- A migration needs an unambiguous trigger: the old value sits under `from`, or (in place) its storage kind differs
  from the input's **and the stored value is not a form the input already accepts** — ref strings and valid unit
  strings never trigger an in-place migration. A transform that keeps the storage kind (0–100 to 0–1, a secret name
  to a ref) must rename the key.
- Entries run in order on each layer before merging; the first that applies wins. If the new key already has a
  value in that layer, the old one is dropped. The destination-exists check compares stored forms, so an in-place
  migration transforms the old value rather than matching itself as "the new key already has a value".
- Write-back: `settings.json` and project files are rewritten once (old key removed). Before the first rewrite,
  core copies `settings.json` to `settings.json.bak`; restoring the backup is the downgrade path — a plugin rolled
  back past a migration gets its old keys back by restoring `settings.json.bak` (core does this automatically when
  a plugin fails schema validation on migrated-away keys whose doc no longer lists the migration). The config file
  is never rewritten; core migrates it in memory on every load and logs a warning naming the old key. A `kv:` entry
  applies to the user layer: the value moves to `settings.json` and its `plugin_kv` row is deleted.

Moving from the earlier `configSchema` hints (`x-widget`, `x-section`, `x-page(s)`, `x-advanced`, `x-group`, `x-icon`, `x-order`, `enumNames`) and `settings@1` was all at once: every plugin with a `settings` doc moved in the same release, so `settings@1` and
`settings@2` never coexist and the scope registry keeps one `settings` definition. `x-*` hints and `enumNames` map
onto the doc mechanically. Existing per-project overrides outside `settings.plugins`
(`project.settings.persona.maxBytesPerFile`, `project.settings.skills.enabled`, `project.settings.model`) stay
where they are; the contextmanager pilots (`personaMaxBytesPerFile`, `skillsEnabled`) read the v3 project layer
instead, and the older keys take precedence until they are removed. The `kv:` migration entries name the actual
`plugin_kv` keys to move (claudecode/codex `preamble:<id>` caches are runtime state, not config, and stay).

#### Compile

Core compiles each `SettingsDoc` into the JSON Schema it validates against; the validator covers every constraint
the doc can express, not a fixed subset:

1. Each setting → a property; each input → its storage kind plus constraints: `min`/`max`/`exclusiveMin`/
   `exclusiveMax`, `step`, `minLength`/`maxLength`, `pattern`, `minItems`/`maxItems` (list, multiselect), `map` key
   rules (`propertyNames`), `enum` for static options, `variant` case shapes (discriminated on `tag`), `schemes`,
   `mustExist`. `required` and `when` are checked by core after validation, not compiled.
2. Inputs with `refs` accept a ref string or the storage type; unit types accept their unit strings.
3. Pipeline per layer: load → migrate. Then merge → resolve `secret:`, `file:` and `env:` → parse units →
   validate → required checks → the desired block, which becomes the applied block once accepted. `cmd:` is not
   resolved here. A project snapshot is the project layer (parsed; it has no refs) merged over the applied user
   block, then validate → required checks.

Core reads only: `id`, `type` (storage kind, constraints, unit parser), `default`, `required`, `when`, `refs`,
`ttl`, `scopes`, `migrate`. Everything else is for UIs. `when`/`required`/`Cond` are evaluated on stored text —
before ref resolution — so core and UIs never disagree.

A plugin may still ship a raw `configSchema` without `settings`; the UI shows a plain generated form, filed by
`provides` (inference providers under inference, tool-only plugins under tools, the rest under system).
`readonly` inputs reject writes (400). A manifest carrying both `settings` and `configSchema` uses `settings` and
ignores `configSchema`.

#### Control plane

- `GET /api/core/settings/:plugin?project=<id>` and `GET /api/core/settings?project=<id>` add the project layer to
  `values` and `sources`.
- `PATCH /api/core/settings/:plugin` takes `{ scope?: "user" | "project", project?: string, config?, enabled? }`.
  `scope` defaults to `user`; as today, `null` drops the layer's value. Project scope requires `project`, accepts
  only settings that allow it, and rejects `enabled` and refs (400).
- Validation is per changed key: a PATCH validates only the keys it touches (each through the same pipeline),
  plus the `required` checks of settings whose conditions read a touched key, never the whole block — so a stale or broken stored key can't block an unrelated save, and
  `{ enabled: false }` skips config validation entirely so a broken plugin can always be disabled.
- User saves, project saves, reloads and watcher events (`file:` watches, `core.secrets.changed`, and edits to
  `settings.json`, the config file, or `project-data/<project-id>/settings.json`) run one at a time on a single
  queue. A save or a watch of one of those files drops the `cmd:` cache entries for refs stored in it. `cmd:` does
  not run on the queue. Core's own saves (which rename a temp file over the target) trigger its own watcher the same
  way an external edit does, so the queue stays single-source; watches are on directories and debounced, since
  rename-over writes break file-level `fs.watch`.
- A watcher event re-reads the file inside the queue slot before merging — never the cached overlay — so an external
  edit raced with a queued save can't be silently overwritten.
- A save runs the pipeline on the result, except `cmd:` (resolved on read, from the TTL cache; see References). A
  schema or required failure is 400 and writes nothing. A `secret:`, `file:` or `env:` ref that fails to resolve
  blocks the save for a required setting; a touched setting whose stored `secret:` ref cannot resolve is also
  rejected, even when optional. Otherwise the save goes through and the error is reported. A
  throwing `onConfigChange` does not reject the save (see Scopes); a throwing `onConfigCheck` does.
- A user save is checked against every project that overrides this plugin **for the keys it touched**: each project
  layer over the new desired user block must validate those keys, or the save is 400 with the failures keyed
  `<projectId>:<path>`. Projects already in `issues` are skipped. Turning global `mode` to `basic` while a project
  overrides `mode = "advanced"` and relies on the user's `budget` fails until the user fixes or clears the
  override.
- A project save is checked over the desired user block and, while they differ, the applied one too, so it stays
  valid after a pending restart.
- Error bodies key failures by `<path>` (or `<projectId>:<path>`) with a message per path; the raw ref text may
  appear, resolved values never do.

```ts
interface PluginSettings {
  plugin: string; name?: string; description?: string; version?: string;
  provides: string[];
  state: "active" | "failed" | "disabled" | "pending";
  enabled: boolean;
  settings?: SettingsDoc;               // the manifest's doc
  types?: Record<string, { base: string } & Record<string, unknown>>;   // recipe chain for each non-primitive type used
  schema?: Record<string, unknown>;     // the compiled (or raw) configSchema
  values: Record<string, unknown>;      // stored values, migrated and unit-parsed; refs stay raw — this is the "desired" form for conditions
  sources: Record<string, "default" | "file" | "settings" | "project">;
  layers: { file?: Record<string, unknown>; user?: Record<string, unknown>; project?: Record<string, unknown> };   // stored, after migration
  liveConfig: boolean;                  // the plugin has an onConfigChange listener
  issues?: Record<Path, string>;        // ref failures and permission warnings
  restartRequired?: string;             // scrubbed: resolved ref values replaced by their ${...} text
}
```

#### Document rules

A document that breaks any of these fails its plugin at load, with the path and rule in the error:

- Ids match the pattern above and are unique: subsection ids within a section, setting ids across the whole document, input ids within a `group` or `variant` case. A runtime subsection whose id equals a declared one in the same section is dropped by the UI with a warning.
- Every section has at least one subsection; every setting has a `label` and an `input`; `variant` tags and `select`/`multiselect` static option values are unique.
- `scopes` always includes `"user"` (a project-only setting is not allowed).
- `deprecated` settings are still compiled and validated, and are exempt from `required`.
- `readonly` is enforced: a PATCH that touches a readonly setting, or a readonly input inside a group, is 400.
- A `map`'s `key` input takes no `refs`.
- A `range` is `[lo, hi]` with `lo <= hi`.
- Unit strings that don't parse (`"5x"` on a `duration`) are a validation error (400), not a soft failure.
- The compiled schema sets `additionalProperties: false` on the block, so an unknown key in a save is 400; unknown keys in the config file are logged and ignored.
- `when` in a project view is evaluated on the project layer merged over the user layers; an absent key and `null` are both "not set", and `eq`/`in` never match an absent key.
- An `onConfigChange` listener must not save settings or write a file core watches for this plugin; core's own writes are deduplicated from its watcher events.

#### Runtime

`settings@2` (many, one provider per plugin, keyed by plugin id) holds what static config can't. Core never calls
it; the UI plugin defines the scope, collects providers and serves them.

```ts
interface SettingsContribution {
  options?: Record<string, (args: Record<string, unknown>) => Option[] | Promise<Option[]>>;
  views?: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>;   // display type's fields
  actions?: Record<string, (args: Record<string, unknown>) => void | Promise<void>>;
  subsections?: () => RuntimeSubsection[] | Promise<RuntimeSubsection[]>;
}

/** Not config: values live in the plugin (a password change). Core neither stores nor validates them. */
interface RuntimeSubsection {
  id: string;
  label: string;
  summary?: string;
  order?: number;
  section?: "system" | "inference" | "tools";   // which of the plugin's sections; default the first in its doc
  items: (PanelField | Display)[];
  refreshMs?: number;
  get?(): Record<string, unknown> | Promise<Record<string, unknown>>;
  set?(values: Record<string, unknown>): void | Promise<void>;
}

/** A setting without config semantics: no scopes, migrate, refs or apply. `masked` strings never echo the stored value back. */
interface PanelField extends Omit<Setting, "input" | "scopes" | "migrate" | "apply"> {
  input: Omit<InputBase, "refs" | "ttl"> & Record<string, unknown>;
}
```

Live status (usage meters, connection state) is a runtime subsection of display types fed by views. Config that
varies per entity (one block per MCP server) is a static `map` or `list` setting, not a runtime subsection.

`settings@2` is the only `settings` scope version; `settings@1` (`SettingsPanel` / `SettingsBlock`) is gone. Like any scope, a provider sees its caller and may refuse one with `ServiceDeniedError`. The UI clamps `refreshMs` to at least 1000.

### 12.2 Secrets

`ctx.secrets` stays read-only for plugins. The control plane can write the file layer:

| Route | Does |
|---|---|
| `GET /api/core/secrets` | `[{ name, source: "file" }]` for the files in `<valetHome>/secrets/`; environment variables are never listed |
| `GET /api/core/secrets/:name` | `{ name, source: "file" \| "env" \| null }`, never the value |
| `PUT /api/core/secrets/:name` | body `{ value }`; writes the file with mode 0600 |
| `DELETE /api/core/secrets/:name` | removes the file |

Names match `[A-Za-z0-9][A-Za-z0-9._-]*`. A write or delete sends the `core.secrets.changed` signal with the name, so a plugin can drop a cached client.

#### References in settings

Values may point at data core resolves: `${resolver:arg}`.

```toml
[plugins.valet-cursor.config]
apiKey     = "${secret:cursor_api_key}"
apiKey     = "${file:~/.config/cursor/key}"
apiKey     = "${env:CURSOR_API_KEY}"
apiKey     = "${cmd:op read op://dev/cursor/key}"
authHeader = "Bearer ${secret:cursor_api_key}"
baseUrl    = "https://${env:PROXY_HOST:-localhost}/v1"
```

| Resolver | Reads | Notes |
|---|---|---|
| `secret:name` | `<valetHome>/secrets/name`, then env `NAME` | today's `ctx.secrets` lookup |
| `file:path` | file contents, trailing newline trimmed | absolute or `~` |
| `env:NAME` | core's environment (under systemd, the unit's, not your shell's) | `${env:NAME:-fallback}` |
| `cmd:line` | stdout, trimmed | `/bin/sh -c`, cwd `<valetHome>`, core's environment, no stdin, 10 s timeout; cached per ref text (see Rules) |

Rules:

- **Trust.** Settings are trusted input, the same as installing a plugin, so a `file:` ref reads and a `cmd:` ref
  runs with core's authority.
- **Syntax.** `${` starts a ref and the first `}` ends it; refs don't nest and the arg can't contain `}`. `$${` is a
  literal `${`. A command that needs `}` goes in a script.
- **Opt-in per input.** `${...}` is resolved only in inputs whose `refs` list the resolver. `secret` inputs accept
  **only** `secret:` refs — a literal password or any other resolver on a `secret` input is 400. Every other input
  allows no resolvers unless it lists them. Elsewhere `${` is literal text.
- **Whole value or interpolation.** String-stored inputs may interpolate refs into a larger string. Other inputs
  accept a ref only as the whole value; the resolved string goes through the input's parser (`"${env:PORT}"` → int).
- **User layers only.** Refs are allowed in the config file and `settings.json`, never in the project layer.
- **Schema defaults may hold refs.** `default: "${secret:cursor_api_key}"` is legal on an input whose `refs` allow
  it; it is resolved like any stored ref. This is how cursor's `apiKey` keeps today's `secret` default.
- **When refs resolve.** `secret:`, `file:` and `env:` resolve on load, all plugins in parallel, and the value is
  reused until the ref text or the source changes. Core watches `file:` paths and listens to `core.secrets.changed`;
  on change it re-resolves and fires `onConfigChange`. `env:` is fixed for the process.
- **`cmd:` resolves asynchronously on read.** It never runs on load, save, reload, watch or the settings queue, and
  it never blocks a read: `ctx.config` and `configFor` return the cached value (or the last good one; unset if
  none) while a miss kicks off the command in the background. Concurrent reads of a cache miss share one in-flight
  run. When a run completes and the value changed, core fires `onConfigChange` with the new desired block. A failed
  run is not cached, so the next read tries again — but failures are cached for the TTL as "failed" so a broken
  command doesn't respawn on every read. The cache is keyed by ref text (not by setting), so a `cmd:` inside a
  `list`/`map`/`group` value, or two refs in one string, each cache independently. The TTL is 60s unless the input
  that accepts the ref sets `ttl` (milliseconds). Saving or watching a file that stores the ref
  (`<valetHome>/settings.json`, the config file) drops that ref's cache entry immediately; the command does not run
  on that drop — the next read does. The timeout is the one in the table. A command that needs a terminal or an
  interactive sign-in fails under systemd. The block handed to `onConfigChange` has `cmd:` as text.
- **Plugins see resolved values** in `ctx.config` (`cmd:` from the cache). `ctx.secrets` stays for existing plugins.
- **Raw out.** Core's own output (control plane, logs, validation errors, exports) carries the raw `${...}` and
  never a resolved value; errors on ref-bearing inputs name the path and rule, not the value. Errors that carry a
  plugin's own exception — `restartRequired`, `onConfigCheck`/`onConfigChange` failures, issues — are scrubbed
  before they reach the UI or logs: any resolved `secret:`/`file:`/`env:`/`cmd:` value appearing in the message is
  replaced by `${resolver:arg}`. A save writes the ref back. Core can't redact what a plugin logs itself, so plugins
  must not log ref-bearing values.
- **Permissions.** If a `secret:` or `file:` target is readable by group or others (mode other than `0600`), core
  logs a warning and the UI shows it on the setting.
- **Failure.** At load, a required setting whose `secret:`, `file:` or `env:` ref fails stops the plugin with
  `<plugin>.<setting>: ${file:...} not found`. A stored `secret:` ref (from the file or settings layer) that fails
  also stops the plugin, even for an optional setting, and never falls back to the default. An optional ref from
  the schema default, or an optional `file:` or `env:` ref, is treated as unset and the UI shows the error. A
  later re-resolve that fails keeps the last good applied value and the UI shows the error. A `cmd:` failure never
  rejects a save or stops the plugin: the read keeps the last good value, or is unset if there is none, and the
  error is reported in `issues`. A listener that throws on a re-resolve follows the listener rule in Scopes.

UI for a `secret` input: a source picker — Stored secret / Paste. Paste asks for a secret name (default
`<pluginId>.<settingId>`, suffixed by group/list/map position when the input sits inside one, confirming before it
replaces an existing one), writes the file (0600) through `PUT /api/core/secrets/:name`, and saves
`${secret:<name>}`. Plaintext never reaches settings.json, and the picker is the only way a `secret` input gets a
value.


## 13. Milestones

| Milestone | Scope | Done when |
|---|---|---|
| **M0 kernel** | sdk, loader, bus (ported prototype and its tests), store and migrations, control-plane HTTP/WS host, caller stamping and deny, `identity@1` | Boots headless with zero plugins. Plugin-order and failure-cascade tests pass. With no identity plugin, every non-public request is refused. |
| **M1 chat** | `valet-agent`, `valet-contextmanager` (persona load), `valet-devin`, `valet-auth`, a minimal `valet-ui` on its own port | Owner can chat with Helper in several sessions on Devin with a model picker. ACP spike resolved. |
| **M2 exec** | `valet-exec`, `valet-fs` | A 30-minute command survives `systemctl --user restart valet` and the session shows completion. |
| **M3 continuity** | compaction, interrupted-run resume, session search | Killing valet mid-turn resumes once after restart. |
| **M4 discord** | `valet-discord`, tiers | Friend can chat in a guild channel without exec or memory. Owner's DMs have full access. |
| **v1.1** | `valet-scheduler` (job runner; dreaming later), `valet-skills`, `valet-openai` | |

## 14. Decisions

Owner reviewed draft 1 on 2026-11-12. He added two rules (plugin identity with deny, and a control-plane-only core port), both folded in above, and accepted the defaults below.

1. **How Devin CLI plugs in: delegated, via `devin acp`.** Devin runs the loop and its own tools, and valet mirrors the stream and lends its tools over MCP. `valet-agent`'s own loop serves `model` providers such as CLIProxyAPI. Caveat: Devin's built-in exec dies with its process. Until the M1 spike shows it can be steered to `valet-exec`, long jobs on Devin sessions won't survive restarts.
2. **Helper's workspace: copied once on import** into `~/.valet/projects/helper`. OpenClaw stays a clean fallback, and nothing writes to both.
3. **Plugin trust and storage:** in-process, trusted plugins and one SQLite file through `bun:sqlite` for v1. Plugin tables are a convention. Caller identity and deny (10.2) are for deciding whom to serve, not a sandbox. Revisit isolation when third-party plugins appear.
4. **Repo layout:** each base plugin is its own folder and git repo from M1 (`valethq/valet-<name>`, Owner's one-repo-per-project rule), developed beside `valet-core` and linked to `@valethq/sdk` with `bun link`. `pluginPaths` points at the folder that holds them.
5. **Friend tier:** trusted gets chat, web search and fetch, with no exec, no fs and no control plane. Guests get chat only, in mentioned channels. `MEMORY.md` and the daily memory files load only in owner-only contexts. `USER.md` loads everywhere so its privacy rules apply. Each plugin enforces its part by denying.
6. **Host and exposure:** valet runs on host as a user systemd service, reached only through **Tailscale Serve**: `https://host.<tailnet>.ts.net/` maps to the UI (7418) and port 8443 on the same host maps to the control plane (7417). Login goes through `valet-auth`. Use Funnel only if a device can't join the tailnet.
7. **Plugin names and scheduler jobs:** `valet-agent`, `valet-auth`, `valet-contextmanager`, `valet-ui`, `valet-devin`, `valet-exec`, `valet-fs`, `valet-discord`, `valet-skills`, `valet-scheduler`. Scheduler jobs are entities, not sessions: each has an id, title, model, trigger and role (capped at the creator's). Every `fire()` opens a fresh work session in the job's project with `settings.agent.jobId` (not `parentSessionId`) and posts the prompt as the creator. Overlap interrupts the running work session with a notice and skips a second run; missed due times catch up once on boot. Delivery targets and utility-model continuity summaries are deferred. Memory "dreaming" is a later consumer of `fire()`, not a fixed-session message pump.

Calls made in draft 2 that Owner can overrule:

- With no identity plugin loaded, core refuses every non-public request (fail closed) rather than serving them.
- A deny is a cancel with attribution: existing `cancelled` checks still hold, and `denied` says who refused and why.
- `restrict()` is checked when a hook subscribes, not on every emit.
- The UI's default port is 7418.

Calls made with project delete, relocate and folder browsing (2026-11-17) that Owner can overrule:

- Deleting a project with sessions is refused rather than cascading to them (9.5).
- Deleting or relocating a project never touches files on disk (9.5).
- Workspace paths are validated, normalized and kept unique at the REST layer; `Store.projects` takes them as given (9.5).
