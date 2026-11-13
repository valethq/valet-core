import type { ToolSpec } from "./tools";

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
  listModels(): Promise<ModelInfo[]>;
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
  /** MCP servers the remote agent should connect to (valet's tools; see 6.2). */
  mcpServers: { name: string; url: string; headers?: Record<string, string> }[];
  signal: AbortSignal;
}

export interface AgentSession {
  /** Persisted on the session so it can be reopened after a restart. */
  readonly resumeId: string;
  prompt(input: { content: ModelContent[]; preamble?: string }, signal: AbortSignal): AsyncIterable<AgentEvent>;
  setModel?(model: string): Promise<void>;
  close(): Promise<void>;
}

export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-start"; callId: string; name: string; title?: string; input?: unknown }
  | { type: "tool-update"; callId: string; outputDelta?: string; status?: "running" | "done" | "error" }
  | { type: "tool-end"; callId: string; status: "done" | "error" | "cancelled"; output?: string }
  | { type: "permission"; request: { callId: string; title: string }; respond(allow: boolean): void }
  | { type: "usage"; contextTokens?: number; inputTokens?: number; outputTokens?: number }
  | { type: "finish"; reason: "stop" | "cancelled" | "length" | "error"; error?: string };
