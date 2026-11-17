import { expect, test } from "bun:test";
import type { InferenceProvider } from "../src";

test("a provider may name a logo key, and may leave it out", () => {
  const base = { label: "Cursor", listModels: async () => [] };
  const providers: InferenceProvider[] = [
    {
      ...base,
      kind: "agent",
      id: "cursor",
      icon: "cursor",
      open: async () => Promise.reject(new Error("unused")),
    },
    { ...base, kind: "model", id: "plain", stream: async function* () {} },
  ];
  expect(providers.map((p) => p.icon)).toEqual(["cursor", undefined]);
});
