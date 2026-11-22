// Which sessions a list carries, and how the ones it leaves out are counted.
import { expect, test } from "bun:test";
import type { Session } from "../core/types.ts";
import { agentsUnder, leanSessions } from "./session-list.ts";

const row = (id: string, parent_id?: string, settings: Record<string, unknown> = {}) => ({ id, title: id, parent_id, settings } as unknown as Session);

test("agents at rest are left out and counted under the session the list carries", () => {
  const all = [
    row("top"), row("other"),
    row("done-1", "top"), row("done-2", "top"),
    row("works", "top"),
    row("pinned", "top", { pinned_ms: 5 }),
    row("failed-unseen", "top", { failed_ms: 9, fail_seen_ms: 0 }),
    row("failed-seen", "top", { failed_ms: 9, fail_seen_ms: 9 }),
    row("declined-unseen", "top", { fail_seen_ms: 0 }),
    // An agent at rest whose own agent works stays, with the line up to the top.
    row("lead", "other"), row("lead-kid", "lead"), row("lead-kid-done", "lead"), row("deep-done", "lead-kid-done"),
    // An agent whose parent is not in this list has nothing to be counted under.
    row("orphan", "archived-parent"),
  ];
  const working = new Set(["works", "lead-kid"]);
  const { sessions, left } = leanSessions(all, (id) => working.has(id));
  expect(sessions.map((s) => s.id)).toEqual(["top", "other", "works", "pinned", "failed-unseen", "declined-unseen", "lead", "lead-kid", "orphan"]);
  // done-1, done-2 and failed-seen under top; the two at rest under lead, the deeper one counted where the list's row is.
  expect(left).toEqual({ top: 3, lead: 2 });
  // Every session is carried or counted.
  expect(sessions.length + Object.values(left).reduce((a, b) => a + b, 0)).toBe(all.length);
  // The ones under a session, at any depth, whatever their state.
  expect(agentsUnder(all, "top").map((s) => s.id)).toEqual(["done-1", "done-2", "works", "pinned", "failed-unseen", "failed-seen", "declined-unseen"]);
  expect(agentsUnder(all, "other").map((s) => s.id)).toEqual(["lead", "lead-kid", "lead-kid-done", "deep-done"]);
  expect(agentsUnder(all, "works")).toEqual([]);
});
