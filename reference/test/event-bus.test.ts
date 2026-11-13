import assert from "node:assert/strict";
import test from "node:test";

import { EventBus, EventHookError } from "../src/event-bus.js";

interface TestEvents {
  message: { text: string };
  count: number;
}

test("runs before hooks by priority and lets them replace the payload", async () => {
  const bus = new EventBus<TestEvents>();
  const calls: string[] = [];

  bus.on(
    "message",
    (event) => {
      if (event.phase !== "before") return;
      calls.push("low");
      event.payload = { text: `${event.payload.text}!` };
    },
    { priority: 1 },
  );
  bus.on(
    "message",
    (event) => {
      if (event.phase !== "before") return;
      calls.push("high");
      event.payload = { text: event.payload.text.trim() };
    },
    { priority: 10 },
  );

  const result = await bus.emit("message", { text: " hello " });

  assert.deepEqual(calls, ["high", "low"]);
  assert.deepEqual(result, {
    payload: { text: "hello!" },
    cancelled: false,
  });
});

test("stops remaining before hooks when cancelled but always runs after hooks", async () => {
  const bus = new EventBus<TestEvents>();
  const calls: string[] = [];

  bus.on("count", (event) => {
    if (event.phase !== "before") return;
    calls.push("cancel");
    event.cancel("nope");
  });
  bus.on(
    "count",
    () => {
      calls.push("skipped");
    },
    { priority: -1 },
  );
  bus.on(
    "count",
    (event) => {
      assert.equal(event.cancelled, true);
      calls.push("after");
    },
    { phase: "after" },
  );

  const result = await bus.emit("count", 42);

  assert.deepEqual(calls, ["cancel", "after"]);
  assert.deepEqual(result, {
    payload: 42,
    cancelled: true,
    cancelReason: "nope",
  });
});

test("supports once hooks and disconnectable subscriptions", async () => {
  const bus = new EventBus<TestEvents>();
  let onceCalls = 0;
  let regularCalls = 0;

  bus.once("count", () => {
    onceCalls += 1;
  });
  const subscription = bus.on("count", () => {
    regularCalls += 1;
  });

  await bus.emit("count", 1);
  subscription.disconnect();
  await bus.emit("count", 2);

  assert.equal(onceCalls, 1);
  assert.equal(regularCalls, 1);
  assert.equal(subscription.active, false);
  assert.equal(bus.listenerCount("count"), 0);
});

test("wraps failures with event, phase, and plugin context", async () => {
  const bus = new EventBus<TestEvents>();
  const cause = new Error("database is down");

  bus.on(
    "message",
    () => {
      throw cause;
    },
    { plugin: "memory" },
  );

  await assert.rejects(bus.emit("message", { text: "hi" }), (error) => {
    assert.ok(error instanceof EventHookError);
    assert.equal(error.eventName, "message");
    assert.equal(error.phase, "before");
    assert.equal(error.plugin, "memory");
    assert.equal(error.cause, cause);
    return true;
  });
});
