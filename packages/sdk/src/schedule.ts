import type { ModelRef } from "./inference";
import type { Role } from "./tools";

/** Terminal statuses plus in-flight `running` for run-history rows. A job's `lastStatus` never stores `running`. */
export type ScheduleJobStatus =
  | "running"
  | "ok"
  | "failed"
  | "timed_out"
  | "skipped"
  | "interrupted";

export type ScheduleTrigger =
  | { type: "cron"; expr: string }
  | { type: "interval"; everyMs: number }
  | { type: "at"; at: number }
  | { type: "manual" };

/** Where each fire() delivers the prompt. Default is a fresh work session. */
export type ScheduleTarget =
  | { kind: "fresh" }
  | { kind: "session"; sessionId: string };

export interface ScheduleRetention {
  keepLast?: number;
  keepDays?: number;
}

export interface ScheduleJob {
  id: string;
  title: string;
  enabled: boolean;
  projectId: string;
  /** When set, fresh sessions and pinned fires use this model; when null, pinned fires keep the session model. */
  model: ModelRef | null;
  prompt: string;
  creatorPrincipalId: string;
  role: Role;
  trigger: ScheduleTrigger;
  target: ScheduleTarget;
  /** Pinned only: compact the session via context@1 before posting. Ignored/rejected on fresh. */
  compactOnRun: boolean;
  timezone: string;
  retention: ScheduleRetention;
  notes: string | null;
  lastRunAt: number | null;
  lastStatus: Exclude<ScheduleJobStatus, "running"> | null;
  lastSessionId: string | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Plain-language schedule for UIs; filled by the provider. */
  schedule?: string;
}

export interface ScheduleRun {
  id: string;
  jobId: string;
  sessionId: string | null;
  status: ScheduleJobStatus;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
}

/** Which trigger caused this fire (manual always reports `"manual"` even if the job's schedule is cron). */
export type ScheduleFireTriggerKind = ScheduleTrigger["type"];

/** `running` is written at fire time and updated to success/error at run end. */
export type ScheduleFireOutcome = "running" | "success" | "error" | "skipped";

/** Internal fire log for graphing success vs failure over time (plugin-owned, capped retention). */
export interface ScheduleFireRecord {
  id: string;
  jobId: string;
  firedAt: number;
  trigger: ScheduleFireTriggerKind;
  target: ScheduleTarget;
  outcome: ScheduleFireOutcome;
  error: string | null;
  sessionId: string | null;
  /** Scheduler run row id when one was opened; null for early failures before a run row. */
  runId: string | null;
  durationMs: number | null;
}

export interface ScheduleJobCreate {
  title: string;
  projectId: string;
  /** Optional. Fresh sessions omit settings.model when null; pinned fires then keep the session model. */
  model?: ModelRef | null;
  prompt: string;
  trigger: ScheduleTrigger;
  /** Default `{ kind: "fresh" }`. */
  target?: ScheduleTarget;
  /** Default false. Only valid for `{ kind: "session" }` targets. */
  compactOnRun?: boolean;
  timezone?: string;
  retention?: ScheduleRetention;
  notes?: string | null;
  role?: Role;
  enabled?: boolean;
  /** Who creates the job; the job's role is capped at this principal's role. */
  creatorPrincipalId: string;
}

export interface ScheduleJobUpdate {
  title?: string;
  enabled?: boolean;
  projectId?: string;
  model?: ModelRef | null;
  prompt?: string;
  trigger?: ScheduleTrigger;
  target?: ScheduleTarget;
  compactOnRun?: boolean;
  timezone?: string;
  retention?: ScheduleRetention;
  notes?: string | null;
  role?: Role;
}

export interface ScheduleFireResult {
  job: ScheduleJob;
  /** Timed/disabled skip, or overlap skip. Manual fire is never skipped for disabled. */
  skipped?: boolean;
  sessionId?: string;
  /** Set when the fire recorded a failed run without throwing (e.g. pinned session gone). */
  error?: string;
}

/**
 * schedule@1: job entities and fire(). Provided by valet-scheduler (cardinality one).
 * Triggers (cron, interval, at, manual) all share fire(); manual / Run now always runs even when
 * the job or master switch is disabled.
 */
export interface Schedule {
  list(): ScheduleJob[];
  get(id: string): ScheduleJob | undefined;
  create(input: ScheduleJobCreate): ScheduleJob | Promise<ScheduleJob>;
  update(id: string, patch: ScheduleJobUpdate): ScheduleJob | Promise<ScheduleJob>;
  enable(id: string): ScheduleJob | Promise<ScheduleJob>;
  disable(id: string): ScheduleJob | Promise<ScheduleJob>;
  delete(id: string): void | Promise<void>;
  fire(jobId: string, opts?: { manual?: boolean }): Promise<ScheduleFireResult>;
  /** Work-session run rows for a job, newest first. */
  runs(jobId: string, opts?: { limit?: number }): ScheduleRun[];
  /** Fire log (success/error/skipped) for graphing, newest first. */
  history(jobId: string, opts?: { limit?: number; since?: number }): ScheduleFireRecord[];
}
