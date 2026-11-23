import type { ModelRef } from "./inference";
import type { Role } from "./tools";

/** Terminal statuses plus in-flight `running` for run-history rows. A job's `lastStatus` never stores `running`. */
export type ScheduleJobStatus = "running" | "ok" | "failed" | "timed_out" | "skipped" | "interrupted";

export type ScheduleTrigger =
  | { type: "cron"; expr: string }
  | { type: "interval"; everyMs: number }
  | { type: "at"; at: number }
  | { type: "manual" };

export interface ScheduleRetention {
  keepLast?: number;
  keepDays?: number;
}

export interface ScheduleJob {
  id: string;
  title: string;
  enabled: boolean;
  projectId: string;
  model: ModelRef;
  prompt: string;
  creatorPrincipalId: string;
  role: Role;
  trigger: ScheduleTrigger;
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

export interface ScheduleJobCreate {
  title: string;
  projectId: string;
  model: ModelRef;
  prompt: string;
  trigger: ScheduleTrigger;
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
  model?: ModelRef;
  prompt?: string;
  trigger?: ScheduleTrigger;
  timezone?: string;
  retention?: ScheduleRetention;
  notes?: string | null;
  role?: Role;
}

export interface ScheduleFireResult {
  job: ScheduleJob;
  skipped?: boolean;
  sessionId?: string;
}

/**
 * schedule@1: job entities and fire(). Provided by valet-scheduler (cardinality one).
 * HTTP, the agent tool, the Jobs UI and later consumers (e.g. memory dreaming) use this scope
 * rather than scheduler internals.
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
  /** Run history for a job, newest first. */
  runs(jobId: string, opts?: { limit?: number }): ScheduleRun[];
}
