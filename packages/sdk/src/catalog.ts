import type { HookPhase } from "./events";
import type { Message, Part, Principal, Project, Run, Session } from "./store";
import type { Role } from "./tools";

// Section 7.3: the core event catalog, declaration-merged into the open maps.
declare module "./events" {
  interface ValetEvents {
    "project.create": { project: Project };
    "project.update": { project: Project };
    "session.create": { session: Session };
    "session.update": {
      session: Session;
      patch: Partial<Pick<Session, "title" | "color" | "status" | "settings">>;
    };
    "session.delete": { session: Session };
    "message.create": { message: Message; parts: Part[] };
    "message.complete": { message: Message };
    "run.start": { run: Run };
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
    };
    "run.status": { sessionId: string; runId: string; status: string };
    "core.hook.error": { eventName: string; phase: HookPhase; plugin: string | undefined; error: unknown };
  }
}
