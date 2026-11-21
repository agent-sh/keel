import { expect, test } from "bun:test";
import type { Approval } from "../../../src/safety/gate.ts";
import { batches, batchName, SETTLE_MS } from "./approvals.ts";

const card = (id: string, over: Partial<Approval> = {}): Approval => ({
  id, session_id: "s", call_id: `c-${id}`, tool: "Bash", kind: "shell", summary: `echo ${id}`, input: {}, risk: "low", suggest: [], state: "pending", created: 1, ...over,
});
const at = (ids: string[], t: number) => new Map(ids.map((id) => [id, t]));

test("one batch per tool with two or more open requests, oldest first", () => {
  const cards = [card("a"), card("e", { tool: "Edit", kind: "edit" }), card("b"), card("c")];
  expect(batches(cards, at(["a", "b", "c", "e"], 0), SETTLE_MS)).toEqual([{ tool: "Bash", kind: "shell", ids: ["a", "b", "c"], waiting: 3 }]);
});

test("a request that just arrived is not covered until it has been shown a while", () => {
  const cards = [card("a"), card("b"), card("late")];
  const shown = new Map([["a", 0], ["b", 0], ["late", 5000]]);
  // The late one is counted as waiting, and no click answers it yet.
  expect(batches(cards, shown, 5000 + SETTLE_MS - 1)[0]).toMatchObject({ ids: ["a", "b"], waiting: 3 });
  expect(batches(cards, shown, 5000 + SETTLE_MS)[0]).toMatchObject({ ids: ["a", "b", "late"], waiting: 3 });
  // One that was never on screen (a hidden tab) is never covered.
  expect(batches([...cards, card("unseen")], shown, 99_999)[0]).toMatchObject({ ids: ["a", "b", "late"], waiting: 4 });
});

test("high-risk, refused and answered requests are never in a batch", () => {
  const cards = [card("a"), card("risky", { risk: "high" }), card("no", { kind: "refused" }), card("done", { state: "allowed" })];
  expect(batches(cards, at(["a", "risky", "no", "done"], 0), SETTLE_MS)).toEqual([]);
  expect(batches([...cards, card("b")], at(["a", "b", "risky", "no", "done"], 0), SETTLE_MS)[0]!.ids).toEqual(["a", "b"]);
});

test("a batch says what it holds", () => {
  expect(batchName({ tool: "Bash", kind: "shell" }, 3)).toBe("3 Bash commands");
  expect(batchName({ tool: "Edit", kind: "edit" }, 2)).toBe("2 Edit changes");
  expect(batchName({ tool: "fetch", kind: "other" }, 1)).toBe("1 fetch call");
});
