import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import {
  type Caller,
  type CancelledResult,
  type ChannelBinding,
  type Denial,
  type Logger,
  type Message,
  type Part,
  type PartData,
  type PartTypes,
  type PartWriter,
  type Principal,
  type Project,
  type Role,
  type Run,
  ServiceDeniedError,
  type Session,
  type SessionSettings,
  type Store,
  type ValetEvents,
} from "@valethq/sdk";
import type { CoreBus } from "../bus/types";
import { newId } from "./ids";
import type { PartTypeRegistry, PluginOrigin } from "./parttypes";
import { rowToMessage, rowToPart, rowToPrincipal, rowToProject, rowToRun, rowToSession } from "./rows";

type EvName = Extract<keyof ValetEvents, string>;

const TERMINAL_RUN: ReadonlySet<string> = new Set(["complete", "cancelled", "error", "interrupted"]);
const PART_CHECKPOINT_MS = 500;

export interface StoreDeps {
  db: Database;
  bus: CoreBus;
  blobsDir: string;
  logger: Logger;
  /** In-memory data of parts with an open writer; reads overlay it on the checkpointed row. */
  liveParts: Map<string, PartData>;
  partTypes: PartTypeRegistry;
  /** Manifest facts of loaded plugins, recorded with the part types they define. */
  origins: Map<string, PluginOrigin>;
}

function denialError(denial: Denial): ServiceDeniedError {
  const error = new ServiceDeniedError(denial.reason);
  (error as { by: string }).by = denial.by;
  return error;
}

function cancelledResult(cancelReason: string | undefined, denied: Denial | undefined): CancelledResult {
  return {
    cancelled: true,
    ...(cancelReason === undefined ? {} : { cancelReason }),
    ...(denied === undefined ? {} : { denied }),
  };
}

/** The Store view one caller sees; mutating actions emit the matching 7.3 core event. */
export class StoreView implements Store {
  readonly #deps: StoreDeps;
  readonly #caller: Caller;

  constructor(deps: StoreDeps, caller: Caller) {
    this.#deps = deps;
    this.#caller = caller;
  }

  /** A message write defaults the actor to its author (8.4). */
  #callerWithAuthor(authorPrincipalId: string | null): Caller {
    if (this.#caller.actor || !authorPrincipalId) return this.#caller;
    const role = this.#roleOf(authorPrincipalId);
    return role === undefined
      ? this.#caller
      : { ...this.#caller, actor: { principalId: authorPrincipalId, role } };
  }

  #roleOf(principalId: string): Role | undefined {
    const row = this.#deps.db
      .query<{ role: string }, string>("SELECT role FROM principals WHERE id = ?")
      .get(principalId);
    return row?.role as Role | undefined;
  }

  /** 8.4: the claim is vouched for by the plugin id; hooks see plugin and actor. */
  as(actor: { principalId: string }): Store {
    const role = this.#roleOf(actor.principalId);
    // spec-gap: claiming a principal that does not exist is a bug; fail loudly.
    if (role === undefined) throw new Error(`store.as: unknown principal "${actor.principalId}"`);
    return new StoreView(this.#deps, { ...this.#caller, actor: { principalId: actor.principalId, role } });
  }

  async #action<N extends EvName, T>(
    caller: Caller,
    name: N,
    payload: ValetEvents[N],
    write: (payload: ValetEvents[N]) => T,
  ): Promise<T | CancelledResult> {
    const res = await this.#deps.bus.emitActionAs(caller, name, payload, write);
    if (!res.cancelled) return res.value as T;
    if (res.denied) throw denialError(res.denied);
    return cancelledResult(res.cancelReason, res.denied);
  }

  async #actionVoid<N extends EvName>(
    caller: Caller,
    name: N,
    payload: ValetEvents[N],
    write: (payload: ValetEvents[N]) => void,
  ): Promise<void> {
    const res = await this.#deps.bus.emitActionAs(caller, name, payload, (final) => {
      write(final);
      return undefined;
    });
    if (res.cancelled && res.denied) throw denialError(res.denied);
  }

  /** Synchronous store actions (runs.create/update) emit their event after the write: no veto is possible. */
  #emitAfterWrite<N extends EvName>(name: N, payload: ValetEvents[N]): void {
    void this.#deps.bus.emitAs(this.#caller, name, payload).catch((error: unknown) => {
      this.#deps.logger.error(`emit of "${name}" failed`, { error });
    });
  }

  // ---- reads (not events) ------------------------------------------------

  #getSession(id: string): Session | undefined {
    const row = this.#deps.db.query("SELECT * FROM sessions WHERE id = ?").get(id);
    return row === null ? undefined : rowToSession(row as Record<string, unknown>);
  }

  #getRun(id: string): Run | undefined {
    const row = this.#deps.db.query("SELECT * FROM runs WHERE id = ?").get(id);
    return row === null ? undefined : rowToRun(row as Record<string, unknown>);
  }

  #getMessage(id: string): Message | undefined {
    const row = this.#deps.db.query("SELECT * FROM messages WHERE id = ?").get(id);
    return row === null ? undefined : rowToMessage(row as Record<string, unknown>);
  }

  // ---- projects ------------------------------------------------------------

  readonly projects = {
    get: (id: string): Project | undefined => {
      const row = this.#deps.db.query("SELECT * FROM projects WHERE id = ?").get(id);
      return row === null ? undefined : rowToProject(row as Record<string, unknown>);
    },

    list: (): Project[] => {
      const rows = this.#deps.db.query("SELECT * FROM projects ORDER BY created_at").all();
      return (rows as Record<string, unknown>[]).map(rowToProject);
    },

    create: async (
      p: Pick<Project, "name" | "workspaceDir"> & { settings?: Project["settings"] },
    ): Promise<Project | CancelledResult> => {
      const now = Date.now();
      const project: Project = {
        id: newId("prj"),
        name: p.name,
        workspaceDir: p.workspaceDir,
        settings: p.settings ?? {},
        createdAt: now,
        updatedAt: now,
      };
      return this.#action(this.#caller, "project.create", { project }, ({ project: final }) =>
        this.#deps.db.transaction(() => {
          this.#deps.db
            .query(
              "INSERT INTO projects (id, name, workspace_dir, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
              final.id,
              final.name,
              final.workspaceDir,
              JSON.stringify(final.settings),
              final.createdAt,
              final.updatedAt,
            );
          return final;
        })(),
      );
    },

    update: async (
      id: string,
      patch: Partial<Pick<Project, "name" | "settings">>,
    ): Promise<Project | CancelledResult> => {
      const current = this.projects.get(id);
      if (!current) throw new Error(`unknown project "${id}"`);
      const project: Project = {
        ...current,
        name: patch.name ?? current.name,
        settings: patch.settings ?? current.settings,
        updatedAt: Date.now(),
      };
      return this.#action(this.#caller, "project.update", { project }, ({ project: final }) =>
        this.#deps.db.transaction(() => {
          this.#deps.db
            .query("UPDATE projects SET name = ?, settings = ?, updated_at = ? WHERE id = ?")
            .run(final.name, JSON.stringify(final.settings), final.updatedAt, final.id);
          return final;
        })(),
      );
    },
  };

  // ---- sessions ------------------------------------------------------------

  readonly sessions = {
    get: (id: string): Session | undefined => this.#getSession(id),

    // spec-gap: ordered most-recent-first; "before" is a cursor on that recency key.
    list: (q: {
      projectId?: string;
      status?: Session["status"];
      limit?: number;
      before?: number;
    }): Session[] => {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (q.projectId !== undefined) {
        where.push("project_id = ?");
        params.push(q.projectId);
      }
      if (q.status !== undefined) {
        where.push("status = ?");
        params.push(q.status);
      }
      if (q.before !== undefined) {
        where.push("COALESCE(last_message_at, created_at) < ?");
        params.push(q.before);
      }
      const sql = `SELECT * FROM sessions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(last_message_at, created_at) DESC`;
      const rows = (
        q.limit === undefined
          ? this.#deps.db.query(sql).all(...params)
          : this.#deps.db.query(`${sql} LIMIT ?`).all(...params, q.limit)
      ) as Record<string, unknown>[];
      return rows.map(rowToSession);
    },

    create: async (s: {
      projectId: string;
      title?: string;
      settings?: SessionSettings;
      parentSessionId?: string;
    }): Promise<Session | CancelledResult> => {
      const now = Date.now();
      const session: Session = {
        id: newId("ses"),
        projectId: s.projectId,
        title: s.title ?? null,
        color: null,
        parentSessionId: s.parentSessionId ?? null,
        status: "idle",
        settings: s.settings ?? {},
        providerState: {},
        createdAt: now,
        updatedAt: now,
        lastMessageAt: null,
      };
      return this.#action(this.#caller, "session.create", { session }, ({ session: final }) =>
        this.#deps.db.transaction(() => {
          this.#deps.db
            .query(
              `INSERT INTO sessions (id, project_id, title, color, parent_session_id, status, settings, provider_state, created_at, updated_at, last_message_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              final.id,
              final.projectId,
              final.title,
              final.color,
              final.parentSessionId,
              final.status,
              JSON.stringify(final.settings),
              JSON.stringify(final.providerState),
              final.createdAt,
              final.updatedAt,
              final.lastMessageAt,
            );
          return final;
        })(),
      );
    },

    update: async (
      id: string,
      patch: Partial<Pick<Session, "title" | "color" | "status" | "settings">>,
    ): Promise<Session | CancelledResult> => {
      const current = this.#getSession(id);
      if (!current) throw new Error(`unknown session "${id}"`);
      const session: Session = {
        ...current,
        title: patch.title === undefined ? current.title : patch.title,
        color: patch.color === undefined ? current.color : patch.color,
        status: patch.status === undefined ? current.status : patch.status,
        settings: patch.settings === undefined ? current.settings : patch.settings,
        updatedAt: Date.now(),
      };
      return this.#action(this.#caller, "session.update", { session, patch }, ({ session: final }) =>
        this.#deps.db.transaction(() => {
          this.#deps.db
            .query(
              "UPDATE sessions SET title = ?, color = ?, status = ?, settings = ?, updated_at = ? WHERE id = ?",
            )
            .run(
              final.title,
              final.color,
              final.status,
              JSON.stringify(final.settings),
              final.updatedAt,
              final.id,
            );
          return final;
        })(),
      );
    },

    delete: async (id: string): Promise<Session | CancelledResult> => {
      const session = this.#getSession(id);
      if (!session) throw new Error(`unknown session "${id}"`);
      return this.#action(this.#caller, "session.delete", { session }, ({ session: final }) =>
        this.#deps.db.transaction(() => {
          // spec-gap: plugin-owned tables that reference sessions are not cleaned up here.
          this.#deps.db
            .query("UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = ?")
            .run(final.id);
          this.#deps.db.query("DELETE FROM messages WHERE session_id = ?").run(final.id);
          this.#deps.db.query("DELETE FROM runs WHERE session_id = ?").run(final.id);
          this.#deps.db.query("DELETE FROM sessions WHERE id = ?").run(final.id);
          return final;
        })(),
      );
    },

    // Explicitly no event: private bookkeeping for one provider (8.4).
    setProviderState: (id: string, provider: string, state: unknown): void => {
      const session = this.#getSession(id);
      if (!session) throw new Error(`unknown session "${id}"`);
      const providerState = { ...session.providerState, [provider]: state };
      this.#deps.db
        .query("UPDATE sessions SET provider_state = ? WHERE id = ?")
        .run(JSON.stringify(providerState), id);
    },

    // spec-gap: 7.3 has no binding event; a rebind is a session change, so it reuses session.update.
    bind: async (id: string, binding: ChannelBinding): Promise<void> => {
      const session = this.#getSession(id);
      if (!session) throw new Error(`unknown session "${id}"`);
      await this.#actionVoid(this.#caller, "session.update", { session, patch: {} }, ({ session: final }) =>
        this.#deps.db.transaction(() => {
          this.#deps.db
            .query(
              `INSERT INTO session_bindings (session_id, platform, conversation_id, meta) VALUES (?, ?, ?, ?)
               ON CONFLICT (platform, conversation_id) DO UPDATE SET session_id = excluded.session_id, meta = excluded.meta`,
            )
            .run(final.id, binding.platform, binding.conversationId, JSON.stringify(binding.meta ?? {}));
        })(),
      );
    },

    findByBinding: (platform: string, conversationId: string): Session | undefined => {
      const row = this.#deps.db
        .query(
          `SELECT s.* FROM sessions s JOIN session_bindings b ON b.session_id = s.id
           WHERE b.platform = ? AND b.conversation_id = ?`,
        )
        .get(platform, conversationId);
      return row === null ? undefined : rowToSession(row as Record<string, unknown>);
    },
  };

  // ---- messages ------------------------------------------------------------

  readonly messages = {
    list: (
      sessionId: string,
      q: { beforeSeq?: number; limit?: number } = {},
    ): { message: Message; parts: Part[] }[] => {
      const where = q.beforeSeq === undefined ? "session_id = ?" : "session_id = ? AND seq < ?";
      const params: (string | number)[] = q.beforeSeq === undefined ? [sessionId] : [sessionId, q.beforeSeq];
      const limit = q.limit === undefined ? "" : ` LIMIT ${Math.trunc(q.limit)}`;
      const rows = this.#deps.db
        .query(`SELECT * FROM messages WHERE ${where} ORDER BY seq DESC${limit}`)
        .all(...params) as Record<string, unknown>[];
      rows.reverse();
      return rows.map((row) => ({
        message: rowToMessage(row),
        parts: this.#partsOf(row.id as string),
      }));
    },

    create: async (m: {
      sessionId: string;
      role: Message["role"];
      authorPrincipalId?: string;
      runId?: string;
      origin?: Message["origin"];
      status?: Message["status"];
      meta?: Record<string, unknown>;
      parts: PartData[];
    }): Promise<{ message: Message; parts: Part[] } | CancelledResult> => {
      for (const data of m.parts) this.#deps.partTypes.check(data, this.#caller.plugin);
      const now = Date.now();
      const seqRow = this.#deps.db
        .query<{ seq: number }, string>(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE session_id = ?",
        )
        .get(m.sessionId);
      const message: Message = {
        id: newId("msg"),
        sessionId: m.sessionId,
        seq: seqRow?.seq ?? 1,
        role: m.role,
        authorPrincipalId: m.authorPrincipalId ?? null,
        runId: m.runId ?? null,
        status: m.status ?? "complete",
        origin: m.origin ?? null,
        meta: m.meta ?? {},
        createdAt: now,
        updatedAt: now,
      };
      const parts: Part[] = m.parts.map((data, idx) => ({
        id: newId("prt"),
        messageId: message.id,
        idx,
        type: data.type,
        data,
        status: message.status === "streaming" ? "streaming" : "complete",
        createdAt: now,
        updatedAt: now,
      }));
      const caller = this.#callerWithAuthor(message.authorPrincipalId);
      return this.#action(caller, "message.create", { message, parts }, ({ message: msg, parts: prts }) =>
        this.#deps.db.transaction(() => {
          this.#deps.db
            .query(
              `INSERT INTO messages (id, session_id, seq, role, author_principal_id, run_id, status, origin, meta, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              msg.id,
              msg.sessionId,
              msg.seq,
              msg.role,
              msg.authorPrincipalId,
              msg.runId,
              msg.status,
              msg.origin === null ? null : JSON.stringify(msg.origin),
              JSON.stringify(msg.meta),
              msg.createdAt,
              msg.updatedAt,
            );
          for (const part of prts) this.#insertPart(part);
          this.#deps.db
            .query("UPDATE sessions SET last_message_at = ? WHERE id = ?")
            .run(msg.createdAt, msg.sessionId);
          return { message: msg, parts: prts };
        })(),
      );
    },

    openPart: (messageId: string, data: PartData): PartWriter => {
      this.#deps.partTypes.check(data, this.#caller.plugin);
      const row = this.#deps.db
        .query<{ session_id: string }, string>("SELECT session_id FROM messages WHERE id = ?")
        .get(messageId);
      if (!row) throw new Error(`unknown message "${messageId}"`);
      const idxRow = this.#deps.db
        .query<{ idx: number }, string>(
          "SELECT COALESCE(MAX(idx), -1) + 1 AS idx FROM parts WHERE message_id = ?",
        )
        .get(messageId);
      const now = Date.now();
      const part: Part = {
        id: newId("prt"),
        messageId,
        idx: idxRow?.idx ?? 0,
        type: data.type,
        data,
        status: "streaming",
        createdAt: now,
        updatedAt: now,
      };
      this.#insertPart(part);
      this.#deps.bus.signalAs(this.#caller, "part.update", {
        sessionId: row.session_id,
        messageId,
        part,
      });
      return new DbPartWriter(this.#deps, this.#caller, part, row.session_id);
    },

    complete: async (messageId: string, status: "complete" | "error" | "interrupted"): Promise<void> => {
      const current = this.#getMessage(messageId);
      if (!current) throw new Error(`unknown message "${messageId}"`);
      const message: Message = { ...current, status, updatedAt: Date.now() };
      await this.#actionVoid(this.#caller, "message.complete", { message }, ({ message: final }) =>
        this.#deps.db.transaction(() => {
          this.#deps.db
            .query("UPDATE messages SET status = ?, updated_at = ? WHERE id = ?")
            .run(final.status, final.updatedAt, final.id);
        })(),
      );
    },
  };

  #insertPart(part: Part): void {
    this.#deps.db
      .query(
        `INSERT INTO parts (id, message_id, idx, type, status, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        part.id,
        part.messageId,
        part.idx,
        part.type,
        part.status,
        JSON.stringify(part.data),
        part.createdAt,
        part.updatedAt,
      );
  }

  #partsOf(messageId: string): Part[] {
    const rows = this.#deps.db
      .query("SELECT * FROM parts WHERE message_id = ? ORDER BY idx")
      .all(messageId) as Record<string, unknown>[];
    return rows.map((row) => {
      const part = rowToPart(row);
      const live = this.#deps.liveParts.get(part.id);
      return live === undefined ? part : { ...part, data: live };
    });
  }

  // ---- runs ---------------------------------------------------------------

  readonly runs = {
    get: (id: string): Run | undefined => this.#getRun(id),

    // spec-gap: synchronous signature, so run.start is emitted post-write with no veto.
    create: (r: { sessionId: string; triggerMessageId?: string; role: Role }): Run => {
      const run: Run = {
        id: newId("run"),
        sessionId: r.sessionId,
        triggerMessageId: r.triggerMessageId ?? null,
        status: "queued",
        role: r.role,
        provider: null,
        model: null,
        startedAt: null,
        endedAt: null,
        error: null,
        usage: {},
      };
      this.#deps.db.transaction(() => {
        this.#deps.db
          .query(
            `INSERT INTO runs (id, session_id, trigger_message_id, status, role, provider, model, usage, started_at, ended_at, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
          )
          .run(
            run.id,
            run.sessionId,
            run.triggerMessageId,
            run.status,
            run.role,
            run.provider,
            run.model,
            run.startedAt,
            run.endedAt,
            run.error,
          );
      })();
      this.#emitAfterWrite("run.start", { run });
      return run;
    },

    // spec-gap: synchronous signature; run.update (and run.end on a terminal status) is emitted post-write.
    update: (
      id: string,
      patch: Partial<Pick<Run, "status" | "provider" | "model" | "error">> & {
        usage?: Record<string, number>;
      },
    ): void => {
      const current = this.#getRun(id);
      if (!current) throw new Error(`unknown run "${id}"`);
      const now = Date.now();
      const run: Run = { ...current };
      if (patch.status !== undefined) run.status = patch.status;
      if (patch.provider !== undefined) run.provider = patch.provider;
      if (patch.model !== undefined) run.model = patch.model;
      if (patch.error !== undefined) run.error = patch.error;
      if (patch.usage !== undefined) run.usage = { ...current.usage, ...patch.usage };
      if (run.status === "running" && run.startedAt === null) run.startedAt = now;
      if (TERMINAL_RUN.has(run.status) && run.endedAt === null) run.endedAt = now;
      this.#writeRun(run, patch.usage);
      this.#emitAfterWrite("run.update", { run });
      if (TERMINAL_RUN.has(run.status)) this.#emitAfterWrite("run.end", { run });
    },

    cancel: async (id: string, by: string): Promise<void> => {
      const current = this.#getRun(id);
      if (!current) throw new Error(`unknown run "${id}"`);
      const res = await this.#deps.bus.emitActionAs(this.#caller, "run.cancel", { runId: id, by }, (final) =>
        this.#deps.db.transaction(() => {
          const target = this.#getRun(final.runId);
          if (!target) throw new Error(`unknown run "${final.runId}"`);
          const run: Run = { ...target, status: "cancelled", endedAt: target.endedAt ?? Date.now() };
          this.#writeRun(run);
          return run;
        })(),
      );
      if (res.cancelled) {
        if (res.denied) throw denialError(res.denied);
        return;
      }
      this.#emitAfterWrite("run.end", { run: res.value as Run });
    },
  };

  #writeRun(run: Run, usage?: Record<string, number>): void {
    let usageJson: string | undefined;
    if (usage !== undefined) {
      const row = this.#deps.db
        .query<{ usage: string }, string>("SELECT usage FROM runs WHERE id = ?")
        .get(run.id);
      usageJson = JSON.stringify({ ...(row ? JSON.parse(row.usage) : {}), ...usage });
    }
    this.#deps.db.transaction(() => {
      this.#deps.db
        .query(
          `UPDATE runs SET status = ?, role = ?, provider = ?, model = ?, started_at = ?, ended_at = ?, error = ?
           ${usageJson === undefined ? "" : ", usage = ?"} WHERE id = ?`,
        )
        .run(
          ...([
            run.status,
            run.role,
            run.provider,
            run.model,
            run.startedAt,
            run.endedAt,
            run.error,
            ...(usageJson === undefined ? [] : [usageJson]),
            run.id,
          ] as (string | number | null)[]),
        );
    })();
  }

  // ---- principals -----------------------------------------------------------

  readonly principals = {
    get: (id: string): Principal | undefined => {
      const row = this.#deps.db.query("SELECT * FROM principals WHERE id = ?").get(id);
      return row === null ? undefined : rowToPrincipal(row as Record<string, unknown>);
    },

    // spec-gap: sync signature; no principal.create event exists in 7.3, so this writes directly.
    resolveIdentity: (
      platform: string,
      externalId: string,
      fallback?: { displayName: string },
    ): Principal => {
      const existing = this.#deps.db
        .query(
          `SELECT p.* FROM principals p JOIN identities i ON i.principal_id = p.id
           WHERE i.platform = ? AND i.external_id = ?`,
        )
        .get(platform, externalId);
      if (existing !== null) return rowToPrincipal(existing as Record<string, unknown>);
      return this.#deps.db.transaction(() => {
        const principal: Principal = {
          id: newId("pri"),
          displayName: fallback?.displayName ?? externalId,
          role: "guest",
        };
        this.#deps.db
          .query("INSERT INTO principals (id, display_name, role, created_at) VALUES (?, ?, ?, ?)")
          .run(principal.id, principal.displayName, principal.role, Date.now());
        this.#deps.db
          .query("INSERT INTO identities (platform, external_id, principal_id) VALUES (?, ?, ?)")
          .run(platform, externalId, principal.id);
        return principal;
      })();
    },

    link: async (principalId: string, platform: string, externalId: string): Promise<void> => {
      const principal = this.principals.get(principalId);
      if (!principal) throw new Error(`unknown principal "${principalId}"`);
      await this.#actionVoid(
        this.#caller,
        "principal.link",
        { principal, identity: { platform, externalId } },
        ({ principal: p, identity }) =>
          this.#deps.db.transaction(() => {
            this.#deps.db
              .query("INSERT INTO identities (platform, external_id, principal_id) VALUES (?, ?, ?)")
              .run(identity.platform, identity.externalId, p.id);
          })(),
      );
    },

    // spec-gap: no principal.update event exists in 7.3, so this writes directly.
    setRole: async (principalId: string, role: Role): Promise<void> => {
      const res = this.#deps.db.query("UPDATE principals SET role = ? WHERE id = ?").run(role, principalId);
      if (res.changes === 0) throw new Error(`unknown principal "${principalId}"`);
    },
  };

  // ---- part types (9.4) ----------------------------------------------------

  // spec-gap: defining a part type emits no event; it is plugin bookkeeping like a migration.
  readonly partTypes: PartTypes = {
    define: (def) => {
      const plugin = this.#caller.plugin;
      if (plugin === "core") throw new Error("only plugins define part types");
      const origin = this.#deps.origins.get(plugin) ?? { id: plugin, version: "0.0.0" };
      return this.#deps.partTypes.define(origin, def);
    },
    get: (id) => this.#deps.partTypes.get(id),
    list: () => this.#deps.partTypes.list(),
  };

  // ---- blobs ---------------------------------------------------------------

  // spec-gap: blobs have no action event in 7.3; writes go straight to disk + row.
  readonly blobs = {
    put: async (
      bytes: Uint8Array | Blob,
      meta: { mime?: string; name?: string },
    ): Promise<{ id: string }> => {
      const buffer = bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes;
      const sha256 = new Bun.CryptoHasher("sha256").update(buffer).digest("hex");
      const path = join(this.#deps.blobsDir, sha256.slice(0, 2), sha256);
      mkdirSync(dirname(path), { recursive: true });
      await Bun.write(path, buffer);
      const id = newId("blb");
      this.#deps.db
        .query("INSERT INTO blobs (id, sha256, mime, size, name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, sha256, meta.mime ?? null, buffer.byteLength, meta.name ?? null, Date.now());
      return { id };
    },

    path: (id: string): string => {
      const row = this.#deps.db
        .query<{ sha256: string }, string>("SELECT sha256 FROM blobs WHERE id = ?")
        .get(id);
      if (!row) throw new Error(`unknown blob "${id}"`);
      return join(this.#deps.blobsDir, row.sha256.slice(0, 2), row.sha256);
    },
  };
}

/** Streaming part writer (8.4): deltas signal `message.delta`; the row is checkpointed every 500ms. */
class DbPartWriter implements PartWriter {
  readonly partId: string;
  readonly #deps: StoreDeps;
  readonly #caller: Caller;
  readonly #sessionId: string;
  readonly #messageId: string;
  /** null for parts that are written whole (compaction, file, notice) and never receive deltas. */
  readonly #kind: "text" | "reasoning" | "tool-output" | null;
  #data: PartData;
  #closed = false;
  #lastFlush = Date.now();

  constructor(deps: StoreDeps, caller: Caller, part: Part, sessionId: string) {
    this.#deps = deps;
    this.#caller = caller;
    this.partId = part.id;
    this.#messageId = part.messageId;
    this.#sessionId = sessionId;
    this.#data = part.data;
    this.#kind =
      part.data.type === "text"
        ? "text"
        : part.data.type === "reasoning"
          ? "reasoning"
          : part.data.type === "tool-call"
            ? "tool-output"
            : null;
    deps.liveParts.set(part.id, this.#data);
  }

  append(delta: string): void {
    if (this.#closed) throw new Error(`part "${this.partId}" is closed`);
    const kind = this.#kind;
    if (kind === null) throw new Error(`part type "${this.#data.type}" takes replace(), not deltas`);
    let offset = 0;
    if (this.#data.type === "text" || this.#data.type === "reasoning") {
      offset = this.#data.text.length;
      this.#data = { ...this.#data, text: this.#data.text + delta };
    } else if (this.#data.type === "tool-call") {
      offset = (this.#data.output ?? "").length;
      this.#data = { ...this.#data, output: (this.#data.output ?? "") + delta };
    }
    this.#deps.liveParts.set(this.partId, this.#data);
    this.#deps.bus.signalAs(this.#caller, "message.delta", {
      sessionId: this.#sessionId,
      messageId: this.#messageId,
      partId: this.partId,
      kind,
      delta,
      offset,
    });
    const now = Date.now();
    if (now - this.#lastFlush >= PART_CHECKPOINT_MS) this.#flush(now);
  }

  replace(data: PartData): void {
    if (this.#closed) throw new Error(`part "${this.partId}" is closed`);
    this.#deps.partTypes.check(data, this.#caller.plugin);
    this.#data = data;
    this.#deps.liveParts.set(this.partId, this.#data);
    this.#flush();
    this.#publish("streaming");
  }

  close(status: "complete" | "error" | "interrupted", final?: PartData): void {
    if (this.#closed) return;
    if (final !== undefined) this.#deps.partTypes.check(final, this.#caller.plugin);
    if (final !== undefined) this.#data = final;
    this.#closed = true;
    this.#deps.liveParts.delete(this.partId);
    const now = Date.now();
    this.#deps.db
      .query("UPDATE parts SET status = ?, data = ?, updated_at = ? WHERE id = ?")
      .run(status, JSON.stringify(this.#data), now, this.partId);
    this.#lastFlush = now;
    this.#publish(status);
  }

  /** Whole-part update for clients that don't stream deltas (compaction markers). */
  #publish(status: "streaming" | "complete" | "error" | "interrupted"): void {
    this.#deps.bus.signalAs(this.#caller, "part.update", {
      sessionId: this.#sessionId,
      messageId: this.#messageId,
      part: {
        id: this.partId,
        messageId: this.#messageId,
        status,
        type: this.#data.type,
        data: this.#data,
      },
    });
  }

  #flush(now = Date.now()): void {
    this.#deps.db
      .query("UPDATE parts SET data = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(this.#data), now, this.partId);
    this.#lastFlush = now;
  }
}

/** Core-facing store: one instance, one Store view per caller (same pattern as CoreBus.forPlugin). */
export interface CoreStore {
  readonly db: Database;
  /** The Store a plugin sees; its writes carry caller.plugin = pluginId. */
  forPlugin(pluginId: string): Store;
  /** A Store bound to an explicit caller (e.g. an authenticated control-plane request). */
  forCaller(caller: Caller): Store;
  /**
   * 7.4 boot recovery: every run still "running" becomes "interrupted", and every
   * "streaming" message/part becomes "interrupted". Returns the interrupted runs so
   * the loader can emit `run.interrupted` for each after `core.ready`.
   */
  findInterruptedRuns(): Run[];
  close(): void;
}

export function createStore(deps: StoreDeps): CoreStore {
  return {
    db: deps.db,
    forPlugin: (pluginId) => new StoreView(deps, { plugin: pluginId }),
    forCaller: (caller) => new StoreView(deps, caller),
    findInterruptedRuns: () =>
      deps.db.transaction(() => {
        const rows = deps.db
          .query("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at")
          .all() as Record<string, unknown>[];
        const now = Date.now();
        deps.db
          .query("UPDATE runs SET status = 'interrupted', ended_at = ? WHERE status = 'running'")
          .run(now);
        deps.db
          .query("UPDATE messages SET status = 'interrupted', updated_at = ? WHERE status = 'streaming'")
          .run(now);
        deps.db
          .query("UPDATE parts SET status = 'interrupted', updated_at = ? WHERE status = 'streaming'")
          .run(now);
        return rows.map((row) => ({ ...rowToRun(row), status: "interrupted" as const, endedAt: now }));
      })(),
    close: () => deps.db.close(),
  };
}
