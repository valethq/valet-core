import type { HookPhase } from "./events";
import type { Message, Part, Principal, Project, Run, Session } from "./store";
import type { Role } from "./tools";

// Section 7.3: the core event catalog, declaration-merged into the open maps.
declare module "./events" {
  interface ValetEvents {
    "project.create": { project: Project };
    "project.update": { project: Project };
    // spec-gap: project.delete is not in the architecture doc's event catalog.
    "project.delete": { project: Project };
    "session.create": { session: Session };
    "session.update": {
      session: Session;
      patch: Partial<Pick<Session, "title" | "color" | "status" | "settings">>;
    };
    "session.delete": { session: Session };
    "message.create": { message: Message; parts: Part[] };
    "message.complete": { message: Message };
    "run.start": { run: Run };
    "run.update": { run: Run };
    "run.end": { run: Run };
    "run.cancel": { runId: string; by: string };
    "run.interrupted": { run: Run };
    "tool.call": { runId: string; callId: string; name: string; input: unknown; role: Role };
    "principal.link": { principal: Principal; identity: { platform: string; externalId: string } };
    "control.request": {
      kind: "http" | "ws.sub" | "ws.call";
      method: string;
      path: string;
      /** The plugin that owns the matched route or topic prefix, when there is one. */
      plugin?: string;
    };
    "identity.changed": { principalId?: string };
    "core.ready": Record<string, never>;
    "core.shutdown": Record<string, never>;
  }

  interface ValetSignals {
    "message.delta": {
      sessionId: string;
      messageId: string;
      partId: string;
      kind: "text" | "reasoning" | "tool-output";
      delta: string;
      /** Length of the part's text/output before this delta was appended; dedupe or refetch on overlap. */
      offset: number;
    };
    /** A part was opened, replaced or closed; carries the whole part so a client can update it in place. */
    "part.update": { sessionId: string; messageId: string; part: unknown };
    "run.status": { sessionId: string; runId: string; status: string };
    "core.config.changed": { changed: string[]; restartRequired: string[] };
    /** A secret file was written or removed through the control plane (12.2); carries the name only. */
    "core.secrets.changed": { name: string };
    "core.hook.error": { eventName: string; phase: HookPhase; plugin: string | undefined; error: unknown };
  }
}
