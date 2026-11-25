// spec-gap: agent@1 is not yet in docs/ARCHITECTURE.md.
import type { Caller } from "./events";
import type { InferenceProvider, ModelInfo, ModelRef } from "./inference";
import type { Session } from "./store";

export type MessageDelivery = "queue" | "interrupt";

/** The authenticated request subject a trusted plugin delegates to the provider; the provider combines it with the factory-stamped calling plugin id. */
export type AgentSubject = Omit<Caller, "plugin">;

export type AgentOperationErrorCode = "not_found" | "busy" | "unsupported" | "bad_request";

/** An operational failure of an agent runtime method. Access-control failures use ServiceDeniedError. */
export class AgentOperationError extends Error {
  readonly code: AgentOperationErrorCode;
  constructor(code: AgentOperationErrorCode, message: string) {
    super(message);
    this.name = "AgentOperationError";
    this.code = code;
  }
}

export interface CatalogModel extends ModelInfo {
  /** Whether the model appears in pickers. */
  show: boolean;
  /** Added by hand in config rather than listed by the provider. */
  custom: boolean;
  /** Provider's unlisted base metadata before overrides; absent for custom models. */
  base?: ModelInfo;
}

export interface CatalogProvider {
  provider: string;
  kind: InferenceProvider["kind"];
  label: string;
  icon?: string;
  error?: string;
  models: CatalogModel[];
}

export interface SessionRunState {
  activeRunId?: string;
  queued: number;
  model: ModelRef;
  usage?: Record<string, number>;
}

export interface AgentRuntime {
  /** Merged model catalog across all active inference@1 providers. */
  models(): Promise<CatalogProvider[]>;
  /** Current run queue, resolved model, and last usage for a session. Undefined if the session does not exist. */
  state(sessionId: string): SessionRunState | undefined;
  /** Copy a session's history (up to messageId, or latest) into a new session. */
  fork(sessionId: string, opts?: { messageId?: string; subject?: AgentSubject }): Promise<Session>;
  /** Move a session to another project. Refuses while a run is active or queued. */
  move(sessionId: string, projectId: string, opts?: { subject?: AgentSubject }): Promise<Session>;
  /** Compact a session's context using the runtime's configured provider and model resolution. */
  compact(sessionId: string, opts?: { instructions?: string; subject?: AgentSubject }): Promise<void>;
}
