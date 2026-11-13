# Valet event bus prototype

A deliberately small typed event bus for testing Valet's plugin model.

```ts
interface Events {
  "session.message.send": {
    sessionId: string;
    content: string;
  };
}

const events = new EventBus<Events>();

events.on("session.message.send", (event) => {
  if (event.phase !== "before") return;
  event.payload = {
    ...event.payload,
    content: event.payload.content.trim(),
  };
});

const result = await events.emit("session.message.send", {
  sessionId: "ses_123",
  content: "  hello  ",
});
```

## Semantics

- Hooks run sequentially by descending priority, then registration order.
- `before` hooks can replace payloads or cancel an event.
- Cancellation skips the remaining `before` hooks.
- `after` hooks always run and observe the final payload and cancellation state.
- A hook can run once or return a subscription that can be disconnected.
- Hook failures throw `EventHookError` with the event, phase, plugin, and original cause.

The prototype does not decide persistence, process isolation, manifest loading, or cross-process delivery. Those belong above this primitive.

## Run it

```sh
npm install
npm test
npm run typecheck
npm run demo
```
