import { EventBus } from "./event-bus.js";

interface ValetEvents {
  "session.message.send": {
    sessionId: string;
    author: "user" | "agent" | "system";
    content: string;
  };
  "session.created": {
    projectId: string;
    sessionId: string;
  };
}

const events = new EventBus<ValetEvents>();

events.on(
  "session.message.send",
  async (event) => {
    if (event.phase !== "before") return;
    event.payload = {
      ...event.payload,
      content: event.payload.content.trim(),
    };
  },
  { plugin: "normalize-messages", priority: 100 },
);

events.on(
  "session.message.send",
  (event) => {
    if (event.phase !== "before") return;
    if (event.payload.content.length === 0) {
      event.cancel("Messages cannot be empty");
    }
  },
  { plugin: "message-validation", priority: 50 },
);

events.on(
  "session.message.send",
  (event) => {
    if (event.phase !== "after") return;
    console.log(
      `[audit] ${event.cancelled ? "rejected" : "accepted"} message for ${event.payload.sessionId}`,
    );
  },
  { plugin: "audit-log", phase: "after" },
);

console.log(
  await events.emit("session.message.send", {
    sessionId: "ses_123",
    author: "user",
    content: "  hello, valet  ",
  }),
);

console.log(
  await events.emit("session.message.send", {
    sessionId: "ses_123",
    author: "user",
    content: "   ",
  }),
);
