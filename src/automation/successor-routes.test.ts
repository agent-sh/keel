import { expect, test } from "bun:test";
import { parentLine, successorOrder } from "./successor.ts";
import { firstOpen } from "../providers/account.ts";

const models = [
  { id: "a:claude-1", provider: "a", family: "claude" as const, release: "2026-01" },
  { id: "a:claude-2", provider: "a", family: "claude" as const, release: "2026-06" },
  { id: "b:gpt", provider: "b", family: "gpt" as const, release: "2026-05" },
  { id: "acp:gw/glm", provider: "acp", family: "other" as const, release: "2026-09" },
];

test("a successor starts on the first model whose route takes work, and names the ones it passed over", () => {
  // The same family first (the lost model, then its kin), then the rest.
  const same = successorOrder(models, { current: "a:claude-1", family: "claude", switchFamily: false, avoid: [] });
  expect(same).toEqual(["a:claude-1", "a:claude-2", "acp:gw/glm", "b:gpt"]);
  // After a second refusal: another family only, the parent's model first.
  const moved = successorOrder(models, { current: "a:claude-1", family: "claude", switchFamily: true, avoid: ["claude"], parent: "acp:gw/glm" });
  expect(moved).toEqual(["acp:gw/glm", "b:gpt"]);
  const shut = (m: string) => (m.startsWith("acp:gw") ? "gw is out of credit or suspended for billing: no available balance" : undefined);
  expect(firstOpen(moved, shut)).toEqual({ model: "b:gpt", skipped: [{ model: "acp:gw/glm", why: "gw is out of credit or suspended for billing: no available balance" }] });
  expect(firstOpen(same, () => undefined)).toEqual({ model: "a:claude-1", skipped: [] });
  expect(firstOpen(["acp:gw/glm"], shut).model).toBeUndefined();
});

test("after a second refusal the model of another family is the nearest by price and window, never one far below", () => {
  const m = (id: string, family: "claude" | "gpt" | "gemini" | "other", context: number, output: number, input: number, out: number, release = "2026-05") =>
    ({ id, provider: id.split(":")[0]!, family, release, context, output, price: { input, output: out } });
  const catalog = [
    m("a:claude-big", "claude", 1_000_000, 64_000, 5, 25),
    m("o:mini", "other", 128_000, 8_000, 0.1, 0.4, "2026-11"),
    m("o:mid", "gpt", 600_000, 32_000, 1.25, 10),
    m("o:near", "gemini", 1_000_000, 64_000, 2, 12),
    m("o:huge", "gpt", 2_000_000, 128_000, 15, 75),
    m("o:small-window", "other", 100_000, 64_000, 5, 25),
  ];
  const opts = { current: "a:claude-big", family: "claude" as const, switchFamily: true, avoid: ["claude" as const], parent: "o:mini", preferred: "o:mini" };
  const order = successorOrder(catalog, opts);
  expect(order[0]).toBe("o:near");
  expect(order).toEqual(["o:near", "o:mid", "o:huge"]);
  expect(order).not.toContain("o:mini");
  expect(order).not.toContain("o:small-window");
  // Only far-below models of another family: nothing starts, the parent decides.
  expect(successorOrder(catalog.filter((x) => x.id === "a:claude-big" || x.id === "o:mini"), opts)).toEqual([]);
  // The lost model's facts may come from its listing though it is no longer a candidate.
  expect(successorOrder(catalog.filter((x) => x.id !== "a:claude-big"), { ...opts, lost: { context: 1_000_000, output: 64_000, price: { input: 5, output: 25 } } })[0]).toBe("o:near");
  // The same family after a first refusal is unchanged.
  expect(successorOrder(catalog, { ...opts, switchFamily: false, avoid: [] })[0]).toBe("a:claude-big");
});

test("the parent's line says which model and why", () => {
  const line = parentLine({ title: "Review", id: "ag1", loss: "refusal", n: 2, model: "o:near", moved: true, from: "a:claude-big" });
  expect(line).toContain("on o:near, a model of another family: the nearest of another family by price and window to a:claude-big");
});
