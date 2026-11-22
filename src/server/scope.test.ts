// Where each frame goes, and when a session's row is told to the lists.
import { expect, test } from "bun:test";
import type { Frame, Session } from "../core/types.ts";
import { ALL, EVERY, LAZY_MS, named, route, rowChange, RowGate, rowPrint } from "./scope.ts";

const row = (over: Partial<Session> = {}): Session => ({
  id: "s1", title: "One", model: "p:m", workspace: "/w", created: 1, updated: 10, phase: "idle", archived: false,
  usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 } as Session["usage"], head: null, settings: {}, ...over,
});

test("a session's stream goes to the sockets that named it; what a list needs goes to all", () => {
  const topics = (f: Frame) => route(f).topics;
  expect(topics({ t: "delta", session_id: "s1", index: 0, kind: "text", text: "x" })).toEqual(["s:s1", EVERY]);
  expect(topics({ t: "event", event: { session_id: "s1" } as any })).toEqual(["s:s1", EVERY]);
  expect(topics({ t: "status", session_id: "s1", status: { kind: "idle" } })).toEqual(["s:s1", EVERY]);
  expect(topics({ t: "feature", name: "checkpoints", session_id: "s1", data: {} })).toEqual(["s:s1", EVERY]);
  // The state, what waits on the owner, alerts, errors: every socket.
  expect(topics({ t: "feature", name: "state", session_id: "s1", data: { watch: "work" } })).toEqual([ALL]);
  expect(topics({ t: "feature", name: "approval", data: { session_id: "s1" } })).toEqual([ALL]);
  expect(topics({ t: "feature", name: "automation", data: { kind: "alert", data: { session_id: "s1" } } })).toEqual([ALL]);
  expect(topics({ t: "questions", pending: [] })).toEqual([ALL]);
  expect(topics({ t: "error", error: {} as any })).toEqual([ALL]);
  // Read by one view across sessions: a feed, and the session's own stream.
  expect(topics({ t: "feature", name: "automation", data: { kind: "activity", data: { session_id: "s1" } } })).toEqual(["f:activity", EVERY, "s:s1"]);
  expect(topics({ t: "feature", name: "artifacts", session_id: "s1", data: {} })).toEqual(["f:artifacts", EVERY, "s:s1"]);
  expect(topics({ t: "feature", name: "awake", data: {} })).toEqual(["f:awake", EVERY]);
  // A row and a queue are decided apart (the gate, the last queue told).
  expect(route({ t: "session", session: row() })).toMatchObject({ topics: ["s:s1", EVERY], row: { key: "s1", gone: false } });
  expect(route({ t: "session", session: row(), deleted: true }).row?.gone).toBe(true);
  expect(route({ t: "queue", session_id: "s1", queue: [], held: false })).toEqual({ topics: [], queue: { key: "s1", body: "[[],false]" } });
});

test("another daemon's relayed frame is scoped as its own would be, under the id its session has here", () => {
  const far = (frame: any): Frame => ({ t: "feature", name: "fleet_frame", data: { machine: "m1", frame } });
  expect(route(far({ t: "delta", session_id: "s9", index: 0, kind: "text", text: "x" })).topics).toEqual(["s:m1--s9", EVERY]);
  expect(route(far({ t: "event", event: { session_id: "s9" } })).topics).toEqual(["s:m1--s9", EVERY]);
  expect(route(far({ t: "status", session_id: "s9", status: { kind: "idle" } })).topics).toEqual(["s:m1--s9", EVERY]);
  expect(route(far({ t: "session", session: row({ id: "s9" }) })).row?.key).toBe("m1--s9");
  expect(route(far({ t: "queue", session_id: "s9", queue: [], held: false })).queue?.key).toBe("m1--s9");
  expect(route(far({ t: "feature", name: "state", session_id: "s9", data: {} })).topics).toEqual([ALL]);
  expect(route(far({ t: "questions", pending: [] })).topics).toEqual([ALL]);
  expect(route(far({ t: "states", states: {} })).topics).toEqual([ALL]);
});

test("a row change a list shows is told at once; activity alone is told once in a while", () => {
  const was = rowPrint(row());
  expect(rowChange(undefined, was)).toBe("shown");
  expect(rowChange(was, rowPrint(row({ title: "Two" })))).toBe("shown");
  expect(rowChange(was, rowPrint(row({ settings: { pinned_ms: 5 } })))).toBe("shown");
  expect(rowChange(was, rowPrint(row({ archived: true })))).toBe("shown");
  expect(rowChange(was, rowPrint(row({ phase: "working" })))).toBe("lazy");
  expect(rowChange(was, rowPrint(row({ updated: 11 })))).toBe("lazy");
  // What only an open view reads: its tokens, the event it stands on.
  expect(rowChange(was, rowPrint(row({ head: "e9", usage: { input: 5, output: 1, cache_read: 0, cache_write: 0 } as Session["usage"], rev: 4 })))).toBe("none");

  const sent: string[] = [];
  let now = 1_000;
  const gate = new RowGate((d) => void sent.push(d), () => now);
  gate.offer("s1", row(), false, "first");
  gate.offer("s1", row({ head: "e2" }), false, "tokens only");
  expect(sent).toEqual(["first"]);
  // A turn starts and ends within the time: the list is told the newest row at its end, once.
  now += 100;
  gate.offer("s1", row({ phase: "working", updated: 20 }), false, "working");
  now += 100;
  gate.offer("s1", row({ phase: "idle", updated: 30 }), false, "idle again");
  expect(sent).toEqual(["first"]);
  // A rename meanwhile does not wait, and takes what waited with it.
  gate.offer("s1", row({ title: "Renamed", updated: 30 }), false, "renamed");
  expect(sent).toEqual(["first", "renamed"]);
  gate.flush("s1");
  expect(sent).toHaveLength(2);
  now += 100;
  gate.offer("s1", row({ title: "Renamed", updated: 40, phase: "working" }), false, "working 2");
  gate.flush("s1"); // the end of the time
  expect(sent.at(-1)).toBe("working 2");
  // Quiet for longer than the time: the next change of activity is told at once.
  now += LAZY_MS;
  gate.offer("s1", row({ title: "Renamed", updated: 50, phase: "idle" }), false, "after a pause");
  expect(sent.at(-1)).toBe("after a pause");
  // A session that is gone is told at once, and nothing is kept of it.
  gate.offer("s1", row({ archived: true }), true, "gone");
  expect(sent.at(-1)).toBe("gone");
  gate.offer("s1", row(), false, "back");
  expect(sent.at(-1)).toBe("back");
});

test("names a client sends are taken as ids only", () => {
  expect(named(["a-1", "m1--s2", 5, "", "has space", "x".repeat(201), null])).toEqual(["a-1", "m1--s2"]);
  expect(named("a")).toEqual([]);
  expect(named(Array.from({ length: 600 }, (_, i) => `s${i}`))).toHaveLength(512);
});
