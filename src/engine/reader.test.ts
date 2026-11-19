// Which model reads for a session: the owner's choice, else the cheapest of the
// session's provider and family that holds the text, never a dearer one.
import { expect, test } from "bun:test";
import type { ModelInfo } from "../providers/types.ts";
import { pickReader } from "./reader.ts";

const m = (id: string, input: number | undefined, o: Partial<ModelInfo> = {}): ModelInfo => ({
  id: `p:${id}`, provider: "p", model: id, name: id, family: "claude", context: 200_000, output: 8_000, efforts: [],
  billing: input === undefined ? "subscription" : "per_token", ...(input === undefined ? {} : { price: { input, output: input * 5 } as any }), ...o,
});
const big = m("big", 5);
const small = m("small", 0.1, { release: "2026-10-01" });
const older = m("older", 0.1, { release: "2024-01-01" });
const tiny = m("tiny", 0.05, { context: 32_000 });
const other = m("other", 0.01, { family: "gpt" });
const all = [big, small, older, tiny, other, m("elsewhere", 0.01, { provider: "q", id: "q:x" })];

test("the cheapest of the same provider and family that fits, newest of equals", () => {
  expect(pickReader(all, big, 10_000, {}).id).toBe("p:tiny");
  expect(pickReader(all, big, 50_000, {}).id).toBe("p:small");
});

test("the owner's reader, then the configured small Claude model", () => {
  expect(pickReader(all, big, 10_000, { KEEL_READER_MODEL: "p:older" }).id).toBe("p:older");
  expect(pickReader(all, big, 10_000, { ANTHROPIC_DEFAULT_HAIKU_MODEL: "small" }).id).toBe("p:small");
});

test("never dearer than the session's model, and nothing by price without one", () => {
  expect(pickReader(all, tiny, 10_000, {}).id).toBe("p:tiny");
  const plan = m("plan", undefined);
  expect(pickReader([...all, plan], plan, 10_000, {}).id).toBe("p:plan");
});
