import { expect, test } from "bun:test";
import { successorOrder } from "./successor.ts";
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
