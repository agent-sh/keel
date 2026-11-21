// Timeline cases the e2e cannot make: a turn with more notes inside it than
// any real turn writes, notes of a kind that has no row among the ones that
// do, and a branch too long to walk in one read. The store is real.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { Timeline } from "./timeline.ts";
import { markRow, NOTE_MARKS } from "./timeline-rows.ts";

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
    expect(page.now).toMatchObject({ state: "owner", lines: [{ kind: "restart", text: "Waits on the owner: a turn cut by a daemon restart was not continued" }] });
    expect(page.next).toBeNull();
  } finally {
    f.close();
  }
});

test("a turn the branch walk has not reached is not called off the branch, and the next read goes on", () => {
  const f = setup();
  try {
    let left = "", kept = "";
    f.store.db.transaction(() => {
      kept = f.turn();
      const fork = f.store.session(f.id)!.head!;
      left = f.turn();
      f.add("user", { text: "again" }, fork);
      for (let i = 0; i < 30_000; i++) f.add("note", { text: `n ${i}` });
    })();
    const tl = new Timeline(f.store);
    const branch = (id: string) => tl.page(f.id).rows.find((r) => r.id === id)!.turn!.branch;
    // Read until the walk from the head has passed both turns: a bounded part a read.
    let reads = 0;
    while (branch(left) !== "other" && ++reads < 200) expect(branch(kept)).toBeUndefined();
    expect(branch(left)).toBe("other");
    expect(branch(kept)).toBeUndefined();
  } finally {
    f.close();
  }
});
