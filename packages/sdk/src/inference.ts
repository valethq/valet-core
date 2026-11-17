import type { ToolResult, ToolSpec } from "./tools";

export interface ModelInfo {
  id: string; // "claude-opus-5-5"
  name: string; // "Claude Opus 5.5"
  contextWindow: number;
  maxOutputTokens: number;
  input: ("text" | "image")[];
  reasoning: boolean;
  cost?: { input: number; output: number; cacheRead?: number }; // per 1M tokens
}

export type InferenceProvider = ModelProvider | AgentProvider;

interface ProviderBase {
  readonly id: string; // "devin-cli"; also the scope key
  readonly label: string;
  // spec-gap: 6.1 has no provider icon; a logo key like PartTypeView.icon, mapped by each UI to its own marks.
  /** Logo key for UIs, e.g. "cursor" or "claude". A UI shows nothing for a key it does not know. */
  readonly icon?: string;
  listModels(): Promise<ModelInfo[]>;
  /** The provider's Utility model: a cheap, fast model for small side jobs such as naming a session. */
  readonly utility?: UtilityModel;
}

export interface UtilityRequest {
  system: string;
  prompt: string;
  maxOutputTokens?: number;
}

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

export interface InferenceRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  maxOutputTokens?: number;
  reasoning?: "off" | "low" | "medium" | "high";
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

export interface AgentOpenOptions {
  sessionId: string;
  cwd: string;
  model: string;
  resumeId?: string;
  /** Valet's tools for this session (see 6.2). The provider decides how to expose them to its agent. */
  tools: ToolSurface;
  signal: AbortSignal;
}

/**
 * Valet's tools as one provider sees them. Bound to the session: `list` and `call` follow whichever run
 * is active. Valet filters the list for the run's role and exposure config, and runs the `tool.call` gate
 * inside `call`, so a provider never has to enforce policy itself.
 */
export interface ToolSurface {
  /** Tools this run may use, as of the run's start. Empty when no run is active. */
  list(): ToolSpec[];
  /** Runs one call through the gate, then the tool. A denied or failed call comes back as `isError`; it never throws. */
  call(name: string, input: unknown, call: { callId: string; signal: AbortSignal }): Promise<ToolResult>;
  /**
   * Runs the `tool.call` gate for a call the provider is about to run itself (a built-in or native tool) and
   * returns the verdict. Use `input` when present: a policy hook may rewrite it. Never throws.
   */
  authorize(
    name: string,
    input: unknown,
    call: { callId: string },
  ): Promise<{ input: unknown } | { denied: string }>;
}

export interface AgentSession {
  /** Persisted on the session so it can be reopened after a restart. */
  readonly resumeId: string;
  prompt(
    input: { content: ModelContent[]; preamble?: string },
    signal: AbortSignal,
  ): AsyncIterable<AgentEvent>;
  setModel?(model: string): Promise<void>;
  /**
   * Asks the harness to compact now (Claude Code `/compact`, Devin `/compact`). Yields the same
   * compaction-start/end events as an automatic compaction, then finish.
   */
  compact?(instructions: string | undefined, signal: AbortSignal): AsyncIterable<AgentEvent>;
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
  /** The harness started compacting its own context; valet opens a compaction part and never compacts it. */
  | { type: "compaction-start" }
  /** The harness finished compacting; closes the open compaction part. */
  | { type: "compaction-end"; status: "completed" | "failed" | "cancelled"; error?: string }
  | { type: "finish"; reason: "stop" | "cancelled" | "length" | "error"; error?: string };
