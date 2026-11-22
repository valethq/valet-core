import { describe, expect, test } from "bun:test";
import type { Logger } from "@valethq/sdk";
import { createCoreBus } from "../src/bus";
import { type HubSocket, WsHub } from "../src/control/ws";
import { createWsRegistry } from "../src/hosts";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function fakeWs(sendResult: number): {
  ws: HubSocket;
  closes: { code: number; reason: string }[];
} {
  const closes: { code: number; reason: string }[] = [];
  const ws = {
    data: {
      caller: { plugin: "core" },
      principal: undefined,
      url: new URL("ws://localhost/ws"),
      subs: new Set<string>(),
      headers: [],
    },
    send: () => sendResult,
    close: (code: number, reason?: string) => closes.push({ code, reason: reason ?? "" }),
  } as HubSocket;
  return { ws, closes };
}

function makeHub(): WsHub {
  return new WsHub({
    bus: createCoreBus({ logger, onHookError: () => {} }),
    ws: createWsRegistry(),
    logger,
    reidentify: async () => ({ ok: false }),
    authorize: () => ({ allow: true }),
    ownerOf: () => undefined,
  });
}

describe("ws send", () => {
  test("a dropped frame (send() === 0) closes the socket so the client resumes via since", () => {
    const hub = makeHub();
    const { ws, closes } = fakeWs(0);
    ws.data.subs.add("session:s1");
    hub.open(ws);
    hub.publish("session:s1", "message.delta", { delta: "x", offset: 0 });
    expect(closes).toEqual([{ code: 1011, reason: "send dropped" }]);
  });

  test("a delivered frame leaves the socket open", () => {
    const hub = makeHub();
    const { ws, closes } = fakeWs(42);
    ws.data.subs.add("session:s1");
    hub.open(ws);
    hub.publish("session:s1", "message.delta", { delta: "x", offset: 0 });
    expect(closes).toEqual([]);
  });
});
