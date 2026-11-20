import { expect, test } from "bun:test";
import type { RuntimeSubsection, SettingsContribution, SettingsDoc, ValetScopes } from "../src/index";

test("a settings doc and a settings@2 contribution type-check and run", async () => {
  const doc: SettingsDoc = {
    sections: {
      system: {
        subsections: [
          {
            id: "main",
            label: "Main",
            items: [
              { type: "note", text: "hi", tone: "warning" },
              {
                id: "mode",
                label: "Mode",
                input: { type: "select", options: [{ value: "a" }] },
                scopes: ["user"],
              },
              { type: "meter", from: "usage", args: { model: { $: "mode" } } },
            ],
          },
        ],
      },
    },
  };
  const ran: string[] = [];
  const usage: RuntimeSubsection = {
    id: "usage",
    label: "Usage",
    refreshMs: 30_000,
    items: [{ type: "stat", label: "Calls", value: "3" }],
  };
  const contribution: ValetScopes["settings"] = {
    options: { efforts: async ({ model }) => [{ value: String(model) }] },
    views: { usage: () => ({ value: 44, display: "44% left" }) },
    actions: { refresh: async () => void ran.push("refresh") },
    subsections: () => [usage],
  } satisfies SettingsContribution;
  expect(doc.sections.system?.subsections[0]?.items).toHaveLength(3);
  expect(await contribution.options?.efforts?.({ model: "m" })).toEqual([{ value: "m" }]);
  await contribution.actions?.refresh?.({});
  expect(ran).toEqual(["refresh"]);
  expect(await contribution.subsections?.()).toEqual([usage]);
});
