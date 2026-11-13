import type { Denial } from "./events";
import type { ChannelBinding } from "./platform";
import type { Role, ToolResult } from "./tools";

export interface Project {
  id: string;
  name: string;
  workspaceDir: string;
  settings: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
export interface Session {
  id: string;
  projectId: string;
  title: string | null;
  color: string | null;
  parentSessionId: string | null;
  status: "idle" | "running" | "archived";
  settings: SessionSettings;
  providerState: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number | null;
}
export interface SessionSettings {
  model?: { provider: string; model: string; fallbacks?: { provider: string; model: string }[] };
  persona?: string; // persona override; default comes from the project
  [pluginNamespace: string]: unknown; // e.g. "agent": { queueMode: "interrupt" }
}
export interface Run {
  id: string;
  sessionId: string;
  triggerMessageId: string | null;
  status: "queued" | "running" | "complete" | "cancelled" | "error" | "interrupted";
  role: Role;
  provider: string | null;
  model: string | null;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  usage: Record<string, number>;
}
export interface Message {
  id: string;
  sessionId: string;
  seq: number;
  role: "user" | "assistant" | "system" | "tool";
  authorPrincipalId: string | null;
  runId: string | null;
  status: "streaming" | "complete" | "error" | "interrupted";
  origin: (ChannelBinding & { externalId?: string }) | null;
  meta: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
export interface Part {
  id: string;
  messageId: string;
  idx: number;
  status: "streaming" | "complete" | "error" | "interrupted";
  type: PartData["type"];
  data: PartData;
  createdAt: number;
  updatedAt: number;
}
export interface Principal {
  id: string;
  displayName: string;
  role: Role;
}

export type PartData =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool-call";
      callId: string;
      name: string;
      title?: string;
      input: unknown;
      output?: string;
      result?: ToolResult;
      status: "pending" | "running" | "done" | "error" | "cancelled" | "denied";
    }
  | { type: "file"; blobId: string; name: string; mime: string }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string } // "turn interrupted by restart", "exec job 12 finished"
  // by: "valet" (summary set; valet's history starts from it) or a harness label (marker only; the harness kept its own summary)
  | { type: "compaction"; by: string; coversThroughSeq: number; summary?: string };

export type CancelledResult = { cancelled: true; cancelReason?: string; denied?: Denial };
export interface ActorRef {
  principalId: string;
}

export interface Store {
  /** A view whose writes carry this actor on `caller.actor`. The claim is vouched for by your plugin id, and hooks see both. A message write defaults the actor to its author. */
  as(actor: ActorRef): Store;
  projects: {
    get(id: string): Project | undefined;
    list(): Project[];
    create(
      p: Pick<Project, "name" | "workspaceDir"> & { settings?: Project["settings"] },
    ): Promise<Project | CancelledResult>;
    update(
      id: string,
      patch: Partial<Pick<Project, "name" | "settings">>,
    ): Promise<Project | CancelledResult>;
  };
  sessions: {
    get(id: string): Session | undefined;
    list(q: { projectId?: string; status?: Session["status"]; limit?: number; before?: number }): Session[];
    create(s: {
      projectId: string;
      title?: string;
      settings?: SessionSettings;
      parentSessionId?: string;
    }): Promise<Session | CancelledResult>;
    update(
      id: string,
      patch: Partial<Pick<Session, "title" | "color" | "status" | "settings">>,
    ): Promise<Session | CancelledResult>;
    delete(id: string): Promise<Session | CancelledResult>;
    setProviderState(id: string, provider: string, state: unknown): void; // no event: private bookkeeping for one provider
    bind(id: string, binding: ChannelBinding): Promise<void>;
    findByBinding(platform: string, conversationId: string): Session | undefined;
  };
  messages: {
    list(
      sessionId: string,
      q?: { beforeSeq?: number; limit?: number },
    ): { message: Message; parts: Part[] }[];
    create(m: {
      sessionId: string;
      role: Message["role"];
      authorPrincipalId?: string;
      runId?: string;
      origin?: Message["origin"];
      status?: Message["status"];
      meta?: Record<string, unknown>;
      parts: PartData[];
    }): Promise<{ message: Message; parts: Part[] } | CancelledResult>;
    /** Opens a streaming part; deltas go out as `message.delta` signals and are checkpointed to the row every 500ms. */
    openPart(messageId: string, data: PartData): PartWriter;
    complete(messageId: string, status: "complete" | "error" | "interrupted"): Promise<void>;
  };
  runs: {
    get(id: string): Run | undefined;
    create(r: { sessionId: string; triggerMessageId?: string; role: Role }): Run;
    update(
      id: string,
      patch: Partial<Pick<Run, "status" | "provider" | "model" | "error">> & {
        usage?: Record<string, number>;
      },
    ): void;
    cancel(id: string, by: string): Promise<void>; // emits run.cancel
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
  kv: {
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    list(prefix?: string): string[];
  };
  /** Plugin-owned tables, named p_<namespace>_*. Migrations run before activate(). */
  sql: { migrate(migrations: { id: string; up: string }[]): void; db: import("bun:sqlite").Database };
}
