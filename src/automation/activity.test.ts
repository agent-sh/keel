// The Activity list across sessions: a busy session is held to its newest rows
// with the rest counted, page after page. (One row a turn, the failures, the
// time range, the text form and a declined turn are checked through the daemon
// in test/e2e/past-truth.spec.ts. Here: the paging of the held list, which
// needs more rows than that workload makes.)
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import * as activity from "./activity.ts";
import { setDeps } from "./core.ts";

test("the held list pages without a row twice or a row lost, and counts a session's rest once", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-activity-")));
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  setDeps({ store, bus: new Bus(), errors: { capture: () => {} } } as any);
  activity.migrate();
  const now = Date.now();
  const add = store.db.query("INSERT INTO activity (id, ts, kind, sub, session_id, text, turn_event) VALUES (?, ?, ?, ?, ?, ?, ?)");
  // A busy session with 400 turns, each with the alert of its end; forty sessions with five turns each;
  // six rows of the daemon's own. Rows share milliseconds (ten a millisecond).
  let n = 0;
  const row = (kind: string, sub: string, session: string | null, turn: string | null) => add.run(`a-${String(n).padStart(6, "0")}`, now - 3_600_000 + Math.floor(n++ / 10), kind, sub, session, `${session ?? "daemon"}: ${kind} ${sub}`, turn);
  store.db.transaction(() => {
    for (let i = 0; i < 400; i++) {
      row("turn", i % 50 === 0 ? "error" : "end_turn", "busy", `busy-${i}`);
      row("alert", i % 50 === 0 ? "failed" : "finished", "busy", `busy-${i}`);
      if (i % 10 === 0) for (let k = 0; k < 5; k++) row("turn", "end_turn", `s-${i / 10}`, `s-${i / 10}-${k}`);
      if (i % 70 === 0) row("awake", "held", null, null);
    }
  })();
  // Every page of the held list, to its end.
  const pages: activity.Activity[][] = [];
  for (let before: string | undefined; ; ) {
    const page = activity.list({ cap: 3, limit: 25, before });
    pages.push(page.items);
    if (!page.has_more) break;
    const last = page.items.at(-1)!;
    before = `${last.ts}:${last.id}`;
  }
  const all = pages.flat();
  // No row twice, newest first across the pages, and no session with more than its three newest.
  expect(new Set(all.map((a) => a.id)).size).toBe(all.length);
  expect(all.map((a) => `${a.ts}:${a.id}`)).toEqual([...all.map((a) => `${a.ts}:${a.id}`)].sort().reverse());
  const by = new Map<string, activity.Activity[]>();
  for (const a of all) (by.get(a.session_id ?? a.kind) ?? by.set(a.session_id ?? a.kind, []).get(a.session_id ?? a.kind)!).push(a);
  expect([...by.keys()].sort()).toEqual(["awake", "busy", ...Array.from({ length: 40 }, (_, i) => `s-${i}`)].sort());
  expect([...by.values()].every((rows) => rows.length === 3)).toBe(true);
  // The busy session's rows are its three newest turns (an alert of a turn's end is no row), and its last one counts the rest.
  expect(by.get("busy")!.map((a) => [a.kind, a.turn_event, a.more])).toEqual([["turn", "busy-399", undefined], ["turn", "busy-398", undefined], ["turn", "busy-397", 397]]);
  expect(by.get("s-39")!.map((a) => a.more)).toEqual([undefined, undefined, 2]);
  expect(by.get("awake")!.at(-1)!.more).toBe(3);
  // Held to failures: the busy session's three newest failures, the rest of them counted.
  const wrong = activity.list({ cap: 3, limit: 25, failures: true }).items;
  expect(wrong.map((a) => [a.session_id, a.sub, a.more])).toEqual([["busy", "error", undefined], ["busy", "error", undefined], ["busy", "error", 5]]);
  // One session alone is not held: every turn of it, a page at a time.
  expect(activity.list({ session_id: "busy", limit: 500 }).items).toHaveLength(400);
});
