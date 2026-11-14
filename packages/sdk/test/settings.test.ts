import { expect, test } from "bun:test";
import type { SettingsBlock, SettingsPanel, ValetScopes } from "../src/index";

test("a display-only panel needs no schema, get or set", async () => {
  const blocks: SettingsBlock[] = [
    { type: "text", text: "hello", tone: "warning" },
    { type: "badge", text: "ok", tone: "good" },
    { type: "stat", label: "Devices", value: "3", caption: "signed in" },
    { type: "meter", label: "Session", value: 44, display: "44% left", marker: 40, status: "On pace" },
    { type: "table", columns: ["Device"], rows: [["phone"]] },
    { type: "button", label: "Refresh", action: "refresh", confirm: "Sure?" },
    { type: "group", layout: "row", blocks: [{ type: "text", text: "nested" }] },
  ];
  const ran: string[] = [];
  const panel: ValetScopes["settings"] = {
    title: "Usage",
    view: () => blocks,
    refreshMs: 30_000,
    actions: { refresh: async () => void ran.push("refresh") },
  } satisfies SettingsPanel;
  expect(await panel.view?.()).toBe(blocks);
  await panel.actions?.refresh?.({});
  expect(ran).toEqual(["refresh"]);
});
