import type { Caller } from "./events";

export type Role = "owner" | "trusted" | "guest";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

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
