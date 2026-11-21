import { expect, test } from "bun:test";
import { nowLines, type TimelineRow } from "../../../src/admin/timeline-rows.ts";
import { mergePlaced, mergeSince, refreshFrom, unplacedFrom } from "./timeline-merge.ts";

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
  expect(mergeSince(held, page([r("d", 350), r("c", 300, { text: "ended" })]), 250, 390)).toEqual({ rows: [r("d", 350), r("c", 300, { text: "ended" }), r("b", 200), r("a", 100)], next: "100:a" });
  // A row that recent which the read no longer has is gone (what "now" took over).
  expect(mergeSince(held, page([]), 250, 390)!.rows.map((x) => x.id)).toEqual(["b", "a"]);
  // A row that moved up (a failure that happened again) is not kept at its old place.
  expect(mergeSince(held, page([r("a", 360)]), 250, 390)!.rows.map((x) => x.id)).toEqual(["a", "b"]);
});

// Something open for more than a page of rows: the refresh's reply is full (it has a `next`).
test("a full refresh keeps the older pages the panel holds, and reads once", () => {
  const rows = (from: number, to: number) => Array.from({ length: from - to }, (_, i) => r(`r${from - i}`, (from - i) * 10));
  // Two pages held (r100..r1), read at 2_000; an agent has been open since ts 100.
  const held = { rows: rows(100, 0), next: "10:r1" };
  // The refresh from ts 100 gives the newest 50 (two of them new) and stops at its limit.
  const fresh = { session_id: "s", as_of: 3_000, rows: [r("n2", 1_020), r("n1", 1_010), ...rows(100, 52)], next: "530:r53" };
  const joined = mergeSince(held, fresh, 100, 2_000)!;
  expect(joined.rows).toHaveLength(102);
  expect(joined.rows.map((x) => x.id).slice(0, 3)).toEqual(["n2", "n1", "r100"]);
  expect(joined.rows.at(-1)!.id).toBe("r1");
  // The cursor of the pages below is the held list's, not the refresh's.
  expect(joined.next).toBe("10:r1");
  // A filtered refresh that stopped at its bound with nothing found keeps what is held below where it stopped.
  expect(mergeSince(held, { session_id: "s", as_of: 3_000, rows: [], next: "530:r53", scanned: 500 }, 100, 2_000)!.rows.map((x) => x.id)).toEqual(rows(52, 0).map((x) => x.id));
  // More than a page is new since the last read: what is held no longer joins it, so the reply is the list (one read, its own cursor).
  const flood = { session_id: "s", as_of: 3_000, rows: rows(400, 350), next: "3510:r351" };
  expect(mergeSince(held, flood, 100, 2_000)).toEqual({ rows: flood.rows, next: "3510:r351" });
});

// A long session's turns are placed on a branch a piece a read: the panel asks again for the ones that are not.
test("turns not placed on a branch yet are asked for again from the newest of them, and only they change", () => {
  const turn = (id: string, ts: number, branch?: "other" | "unknown"): TimelineRow => r(id, ts, { kind: "turn", sub: "ok", turn: { origin: "owner", outcome: "ok", steps: 1, tools: 0, failed_tools: 0, ...(branch ? { branch } : {}) } });
  const held = { rows: [turn("t5", 500), r("w", 450), turn("t4", 400, "unknown"), turn("t3", 300, "unknown"), turn("t2", 200, "other")], next: "200:t2" };
  expect(unplacedFrom(null)).toBeNull();
  expect(unplacedFrom({ rows: [turn("t5", 500)], next: null })).toBeNull();
  // From just above the newest unplaced turn: the cursor takes every row at or before its time.
  expect(unplacedFrom(held)).toBe("401:");
  // The answer places one, leaves one unknown, and names turns the list does not hold: only the unplaced rows move.
  const fresh = { session_id: "s", as_of: 9_000, rows: [turn("t4", 400), turn("t3", 300, "unknown"), turn("t2", 200), turn("t1", 100)], next: null };
  const next = mergePlaced(held, fresh);
  expect(next.rows.map((x) => [x.id, x.turn?.branch])).toEqual([["t5", undefined], ["w", undefined], ["t4", undefined], ["t3", "unknown"], ["t2", "other"]]);
  expect(next.next).toBe("200:t2");
  expect(unplacedFrom(next)).toBe("301:");
});

