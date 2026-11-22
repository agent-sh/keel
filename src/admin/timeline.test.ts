// Timeline cases the e2e cannot make: a turn with more notes inside it than
// any real turn writes, notes of a kind that has no row among the ones that
// do, and a branch too long to walk in one read. The store is real.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { Timeline } from "./timeline.ts";
import { markRow, NOTE_MARKS, timelineText } from "./timeline-rows.ts";

// These tests write a database of their own to disk (tens of thousands of
// rows); under a disk stall of a shared machine a write waits seconds, and the
// 5 s default was passed in whole-suite runs by tests that take under a second alone.
setDefaultTimeout(20_000);

const setup = () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "timeline-"));
  const store = new Store(dir);
  const s = store.createSession({ model: "fixture:m", workspace: dir });
  const add = (kind: Parameters<Store["append"]>[1], data: unknown = {}, parent?: string) => store.append(s.id, kind, data, parent);
  const turn = (inside = 0, end: Record<string, unknown> | null = { reason: "end_turn", ms: 5 }) => {
    add("user", { text: "go" });
    const start = add("turn_start", { model: "fixture:m" });
    for (let i = 0; i < inside; i++) add("note", { text: `hook note ${i}`, model: true });
    add("assistant", { blocks: [] });
    if (end) add("turn_end", end);
    return start.id;
  };
  const close = () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); };
  return { store, id: s.id, add, turn, close };
};

test("every kind of note that has a row is in the index, and no other", () => {
  for (const kind of NOTE_MARKS) expect(markRow({ id: "n", ts: 1, kind: "note", data: { kind } }), kind).not.toBeNull();
  for (const kind of [undefined, "tasks", "images", "handoff", "max_steps"]) expect(markRow({ id: "n", ts: 1, kind: "note", data: { kind } }), String(kind)).toBeNull();
});

test("a turn is read whole however many notes lie inside it and around it", () => {
  const f = setup();
  try {
    f.store.db.transaction(() => {
      for (let i = 0; i < 400; i++) f.add("note", { text: `before ${i}` });
      f.turn(600);
      f.add("note", { kind: "model_told", from: "a:one", to: "b:two", text: "changed" });
      for (let i = 0; i < 400; i++) f.add("note", { kind: "tasks", text: `between ${i}` });
      f.turn(0, { reason: "restart", ms: 3, crashed: true });
      for (let i = 0; i < 100; i++) f.add("note", { text: `after ${i}` });
      f.add("note", { kind: "restart", text: "held" });
      for (let i = 0; i < 400; i++) f.add("note", { text: `later ${i}` });
    })();
    const page = new Timeline(f.store).page(f.id);
    expect(page.rows.map((r) => r.text)).toEqual([
      "Owner prompt, cut when the daemon went down after 1 step",
      "Model changed from one to two",
      "Owner prompt, 1 step",
    ]);
    // The note between the turns belongs to no turn; the held note is what "now" says, not a row too.
    expect(page.rows[1]!.turn_event).toBeUndefined();
    expect(page.now).toMatchObject({ state: "owner", lines: [{ kind: "restart", text: "Needs you: a turn to resume, cut by a daemon restart" }] });
    expect(page.next).toBeNull();
  } finally {
    f.close();
  }
});

test("a turn the branch walk has not reached says so, never that it is on the branch, and reading on places it", async () => {
  const f = setup();
  try {
    let left = "", kept = "";
    f.store.db.transaction(() => {
      kept = f.turn();
      const fork = f.store.session(f.id)!.head!;
      left = f.turn();
      f.add("user", { text: "again" }, fork);
      for (let i = 0; i < 60_000; i++) f.add("note", { text: `n ${i}` });
    })();
    const tl = new Timeline(f.store);
    const read = () => { const p = tl.page(f.id); const of = (id: string) => p.rows.find((r) => r.id === id)!; return { p, left: of(left), kept: of(kept) }; };
    // The first read walks a bounded piece from the head: neither turn is reached, and both say so.
    const first = read();
    expect(first.p.partial).toBe(true);
    expect([first.left.turn!.branch, first.kept.turn!.branch]).toEqual(["unknown", "unknown"]);
    expect(first.left.text).toBe("Owner prompt, 1 step, branch not placed yet");
    expect(timelineText(first.p).split("\n").at(-1)).toBe('2 of these turns are not placed on a branch yet (marked "branch not placed yet"): this session is long and the read stopped part way. The same read again goes on.');
    // Read on: the turn left behind is never shown as on the branch, on any read.
    let reads = 1;
    for (let r = read(); r.p.partial && reads < 500; r = read(), reads++) {
      // A read's walk is bounded in time: it may stop after it passed the one and before it placed the other.
      expect(["unknown", "other"]).toContain(r.left.turn!.branch!);
      expect(["unknown", undefined]).toContain(r.kept.turn!.branch);
    }
    const last = read();
    expect(last.p.partial).toBeUndefined();
    expect([last.left.turn!.branch, last.kept.turn!.branch]).toEqual(["other", undefined]);
    expect(last.left.text).toBe("Owner prompt, 1 step, on a branch not shown");

    // The text form's read goes on by itself until the turns are placed; with no time for it, it says what is not.
    const fresh = new Timeline(f.store);
    expect((await fresh.settled(f.id, {}, 0)).partial).toBe(true);
    const whole = await new Timeline(f.store).settled(f.id);
    expect(whole.partial).toBeUndefined();
    expect(whole.rows.find((r) => r.id === left)!.turn!.branch).toBe("other");
  } finally {
    f.close();
  }
});

test("a walk still on its way outlives two hundred other sessions read meanwhile", () => {
  const f = setup();
  try {
    let turn = "";
    const others: string[] = [];
    f.store.db.transaction(() => {
      turn = f.turn();
      for (let i = 0; i < 60_000; i++) f.add("note", { text: `n ${i}` });
      for (let i = 0; i < 300; i++) {
        const s = f.store.createSession({ model: "fixture:m", workspace: f.store.stateDir });
        f.store.append(s.id, "user", { text: "go" });
        f.store.append(s.id, "turn_start", { model: "fixture:m" });
        f.store.append(s.id, "turn_end", { reason: "end_turn", ms: 1 });
        others.push(s.id);
      }
    })();
    const tl = new Timeline(f.store);
    const placed = () => tl.page(f.id).rows.find((r) => r.id === turn)!.turn!.branch !== "unknown";
    // Between two reads of the long session every other session is read: its walk goes on, and ends.
    let rounds = 0;
    while (!placed() && ++rounds < 100) for (const id of others) tl.page(id);
    expect(placed()).toBe(true);
    expect(rounds).toBeLessThan(100);
  } finally {
    f.close();
  }
});

test("a turn that goes on after a restart with no prompt between (its card was still open) says a restart started it", () => {
  const f = setup();
  try {
    // The owner's prompt, cut with a card open; the turn the next daemon started goes on with the same card and stores no prompt.
    f.add("user", { text: "go" });
    f.add("turn_start", { model: "fixture:m" });
    f.add("assistant", { blocks: [] });
    f.add("turn_end", { reason: "restart", ms: 5, crashed: true });
    f.add("user", { text: "[harness] restarted", origin: "restart" });
    f.add("turn_start", { model: "fixture:m" });
    f.add("turn_end", { reason: "restart", ms: 4, crashed: true });
    const again = f.add("turn_start", { model: "fixture:m" });
    f.add("turn_end", { reason: "restart", ms: 3 });
    const live = f.add("turn_start", { model: "fixture:m" });
    const rows = new Timeline(f.store).page(f.id).rows;
    // It read "Owner prompt, cut by a daemon restart before its first step".
    expect(rows.find((r) => r.id === again.id)!.text).toBe("Resumed after a daemon restart, cut by a daemon restart before its first step");
    expect(rows.map((r) => r.turn?.origin)).toEqual(["restart", "restart", "restart", "owner"]);
    // And what runs now: not "a turn started by the owner".
    const now = new Timeline(f.store, { turnOf: () => live.id, isRunning: () => true }).now(f.id);
    expect(now.lines[0]!.text).toStartWith("Running a turn resumed after a daemon restart: step 1");
  } finally {
    f.close();
  }
});
