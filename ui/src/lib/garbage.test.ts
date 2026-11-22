import { expect, test } from "bun:test";
import type { StoredEvent } from "../../../src/core/types.ts";
import { lineage } from "../../../src/core/tree.ts";

// What the page works out at every event of any session, kept from one event to the next.
test("callsigns are given again, the same object, for the same sessions", async () => {
  const { callsigns } = await import("./callsigns.ts");
  const a = [{ id: "1", title: "Fix the build", created: 1 }, { id: "2", title: "Fix the bridge", created: 2 }, { id: "3", title: "", created: 3 }];
  const codes = callsigns(a);
  expect(codes).toEqual({ "1": "FB", "2": "FI", "3": "NS" });
  // The store hands out new objects with every event: the answer is the one already made.
  expect(callsigns(a.map((s) => ({ ...s, updated: 99 })))).toBe(codes);
  // A title that changed, or a session more, is worked out again.
  expect(callsigns([{ ...a[0]!, title: "Ship it" }, a[1]!, a[2]!])).toEqual({ "1": "SH", "2": "FB", "3": "NS" });
  expect(callsigns(a)).toBe(codes);
  // Every pair of a title's letters taken: a number after its first letter, the lowest free.
  const same = Array.from({ length: 5 }, (_, i) => ({ id: `x${i}`, title: "Go", created: i }));
  expect(Object.values(callsigns(same))).toEqual(["GO", "G2", "G3", "G4", "G5"]);
});

test("a session's branch grows with its events and is the same list while its head stands", async () => {
  const { branchLine } = await import("./rows.ts");
  const ev = (id: string, parent: string | null, seq: number) => ({ id, parent, seq, kind: "note", session_id: "s", ts: seq, data: {} }) as unknown as StoredEvent;
  let all = [ev("a", null, 1), ev("b", "a", 2), ev("x", "a", 3)];
  const first = branchLine("s", all, "b");
  expect(first.map((e) => e.id)).toEqual(["a", "b"]);
  // The list is a new one with every event; the branch is the same while the head is.
  all = [...all, ev("y", "x", 4)];
  expect(branchLine("s", all, "b")).toBe(first);
  // An event added at the branch's end adds to it, as the whole tree's reading gives.
  all = [...all, ev("c", "b", 5)];
  expect(branchLine("s", all, "c").map((e) => e.id)).toEqual(["a", "b", "c"]);
  expect(branchLine("s", all, "c")).toEqual(lineage(all, "c"));
  // Another branch is read whole.
  expect(branchLine("s", all, "y")).toEqual(lineage(all, "y"));
  // Sessions do not share one.
  expect(branchLine("t", [ev("q", null, 1)], "q").map((e) => e.id)).toEqual(["q"]);
  expect(branchLine("s", all, "y").map((e) => e.id)).toEqual(["a", "x", "y"]);
});
