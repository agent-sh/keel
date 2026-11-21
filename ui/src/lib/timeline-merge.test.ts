import { expect, test } from "bun:test";
import { nowLines, type TimelineRow } from "../../../src/admin/timeline-rows.ts";
import { mergeSince, refreshFrom } from "./timeline-merge.ts";

const quiet = { ts: 100_000, approvals: [], questions: [], waits: [], agents: [], loops: [], queue: { queued: 0, steers: 0, held: false, owed: false } };
// The panel's live refresh: it asks only for what can have changed, and joins it to what it holds.
const r = (id: string, ts: number, more: Partial<TimelineRow> = {}): TimelineRow => ({ id, ts, kind: "wait", sub: "set", tone: "plain", text: id, ...more });
test("a refresh reads from the oldest thing still open, else from just before the last read", () => {
  const open = nowLines({ ...quiet, turn: { id: "t1", ts: 40_000, steps: 1, status: { kind: "idle" } }, waits: [{ id: "w1", kind: "timer", created: 20_000, deadline: 400_000 }] });
  expect(refreshFrom(100_000, open)).toBe(20_000);
  expect(refreshFrom(100_000, nowLines({ ...quiet, last: { ts: 90_000, outcome: "ok" } }))).toBe(99_000);
  expect(refreshFrom(100_000, undefined)).toBe(99_000);
});

test("a refresh replaces what is that recent and keeps the older rows", () => {
  const held = { rows: [r("c", 300), r("b", 200), r("a", 100)], next: "100:a" };
  const page = (rows: TimelineRow[], next: string | null = null) => ({ session_id: "s", as_of: 400, rows, next });
  // A new row, and a held one that changed in place (a turn that ended).
  expect(mergeSince(held, page([r("d", 350), r("c", 300, { text: "ended" })]), 250)).toEqual({ rows: [r("d", 350), r("c", 300, { text: "ended" }), r("b", 200), r("a", 100)], next: "100:a" });
  // A row that recent which the read no longer has is gone (what "now" took over).
  expect(mergeSince(held, page([]), 250)!.rows.map((x) => x.id)).toEqual(["b", "a"]);
  // A row that moved up (a failure that happened again) is not kept at its old place.
  expect(mergeSince(held, page([r("a", 360)]), 250)!.rows.map((x) => x.id)).toEqual(["a", "b"]);
  // More than a page arrived: the list is read again from the top.
  expect(mergeSince(held, page([r("z", 900)], "900:z"), 250)).toBeNull();
});
