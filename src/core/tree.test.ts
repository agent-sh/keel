// A page of a branch (pageOf): which events a reader that holds a session in
// parts is given for each way of asking.
import { expect, test } from "bun:test";
import { firstAt, leafCount, lineage, pageOf, pageOfLine, replyBefore } from "./tree.ts";
import type { StoredEvent } from "./types.ts";

const all: StoredEvent[] = [];
const ev = (kind: StoredEvent["kind"], data: any = {}, parent?: string | null): StoredEvent => {
  const seq = all.length + 1;
  const e: StoredEvent = { id: `e${seq}`, session_id: "s", seq, parent: parent === undefined ? all.at(-1)?.id ?? null : parent, kind, data, ts: seq };
  all.push(e);
  return e;
};
const turn = (parent?: string | null) => { const u = ev("user", { text: "p" }, parent); ev("turn_start"); ev("assistant", { blocks: [] }); ev("turn_end"); return u; };
// Ten turns, then a prompt with two versions: the first has two turns under it, the second (the session's branch) forty.
for (let i = 0; i < 10; i++) turn();
const fork = all.at(-1)!.id;
const first = turn(fork);
turn();
const sideEnd = all.at(-1)!.id;
const second = turn(fork);
for (let i = 0; i < 39; i++) turn();
const head = all.at(-1)!.id;
const main = lineage(all, head);
const onBranch = (p: { events: StoredEvent[] }, line: StoredEvent[]) => p.events.filter((e) => line.includes(e));

test("the newest page starts at a turn and carries the start of the last one", () => {
  const p = pageOf(all, head, { limit: 10 })!;
  const part = onBranch(p, main);
  expect(part.at(-1)!.id).toBe(head);
  expect(part.length).toBe(12); // ten events back is inside a turn: the page starts where that turn does
  expect(part[0]!.kind).toBe("user");
  expect(p).toMatchObject({ head, last: head, first: part[0]!.id, start: false, end: true, on_head: true });
});

test("older and newer pages continue where the reader's part stops", () => {
  const newest = pageOf(all, head, { limit: 10 })!;
  const from = main.find((e) => e.id === newest.first)!;
  const older = pageOf(all, head, { limit: 10, head, before: from.seq })!;
  const part = onBranch(older, main);
  expect(part.at(-1)!.seq).toBe(main[main.indexOf(from) - 1]!.seq);
  expect(older.end).toBe(false);
  const later = pageOf(all, head, { limit: 10, after: part.at(-1)!.seq })!;
  expect(onBranch(later, main)[0]!.id).toBe(from.id);
  expect(onBranch(later, main).length).toBe(10);
  // To the first event of the branch.
  const root = pageOf(all, head, { limit: 1000, before: from.seq })!;
  expect(root.start).toBe(true);
  expect(root.events[0]!.parent).toBeNull();
});

test("a page with a prompt carries its other versions", () => {
  const p = pageOf(all, head, { limit: 8, around: second.id })!;
  expect(p.on_head).toBe(true);
  expect(p.events.map((e) => e.id)).toContain(first.id);
  expect(p.events.map((e) => e.id)).not.toContain(sideEnd);
});

test("an event of another branch is shown on the branch that grew from it", () => {
  const p = pageOf(all, head, { limit: 20, around: first.id })!;
  expect(p).toMatchObject({ head: sideEnd, on_head: false, end: true });
  expect(p.events.map((e) => e.id)).toContain(second.id); // the other version
  expect(pageOf(all, head, { limit: 8, around: "nope" })).toBeNull();
  expect(pageOf(all, head, { limit: 8, head: "nope" })).toBeNull();
});

test("a page of a branch already walked is the page of the whole session, found by halving", () => {
  const versions = (parent: string | null) => all.filter((e) => e.kind === "user" && !e.data.origin && e.parent === parent);
  const ids = (p: { events: StoredEvent[] } | null) => p!.events.map((e) => e.id);
  const from = main[120]!.seq;
  for (const ask of [{ limit: 10 }, { limit: 10, before: from }, { limit: 10, after: from }, { limit: 1000, before: from }, { limit: 7, after: 0 }, { limit: 10, before: 1 }]) {
    const whole = pageOf(all, head, ask)!;
    const part = pageOfLine(main, ask, versions, head, true);
    expect(ids(part)).toEqual(ids(whole));
    expect({ ...part, events: 0 }).toEqual({ ...whole, events: 0 });
  }
  const at = firstAt(main, second.seq);
  expect(main[at]).toBe(second);
  expect(ids(pageOfLine(main, { limit: 8, at }, versions, head, true))).toEqual(ids(pageOf(all, head, { limit: 8, around: second.id })));
  // An event of another branch is not on the session's: its seq falls between two of the branch's.
  expect(main[firstAt(main, first.seq)]?.id).not.toBe(first.id);
});

test("a part neither ends nor starts between a failed turn's end and what failed", () => {
  const line: StoredEvent[] = [];
  const add = (kind: StoredEvent["kind"], data: any = {}) => { const seq = line.length + 1; line.push({ id: `f${seq}`, session_id: "s", seq, parent: line.at(-1)?.id ?? null, kind, data, ts: seq }); return line.at(-1)!; };
  const whole = () => { add("user", { text: "p" }); add("turn_start"); add("assistant", { blocks: [] }); return add("turn_end"); };
  for (let i = 0; i < 3; i++) whole();
  add("user", { text: "fails" }); add("turn_start");
  const failed = add("turn_end", { reason: "error" });
  const e1 = add("error", { message: "one" });
  const e2 = add("error", { message: "two" });
  for (let i = 0; i < 3; i++) whole();
  const none = () => [];
  const at = line.indexOf(failed);
  // A part cut right after the failed turn's end goes on over its failures.
  const upTo = pageOfLine(line, { limit: 4, before: e1.seq }, none, line.at(-1)!.id, true);
  expect(upTo.events.at(-1)!.id).toBe(e2.id);
  expect(upTo.last).toBe(e2.id);
  // A part around an event that would end there does too.
  const around = pageOfLine(line, { limit: 4, at: at - 1 }, none, line.at(-1)!.id, true);
  expect(around.events.map((e) => e.id).slice(-3)).toEqual([failed.id, e1.id, e2.id]);
  // The part that follows starts at the next turn, and one cut inside the failures starts at their turn.
  const next = pageOfLine(line, { limit: 4, after: e2.seq }, none, line.at(-1)!.id, true);
  expect(next.events[0]!.kind).toBe("user");
  const cut = pageOfLine(line, { limit: 5, before: line.at(-1)!.seq + 1 - 8 }, none, line.at(-1)!.id, true);
  expect(cut.events[0]!.kind).toBe("user");
  const from = pageOfLine(line, { limit: 12 }, none, line.at(-1)!.id, true);
  expect(from.events[0]!.kind).toBe("user");
  expect(from.events[0]!.data.text).toBe("p");
});

test("a turn's whole reply is its texts back to its prompt, whatever part a reader holds", () => {
  const line: StoredEvent[] = [];
  const add = (kind: StoredEvent["kind"], data: any = {}) => { const seq = line.length + 1; line.push({ id: `r${seq}`, session_id: "s", seq, parent: line.at(-1)?.id ?? null, kind, data, ts: seq }); return line.at(-1)!; };
  const say = (text: string) => add("assistant", { blocks: [{ type: "text", text }, { type: "tool_use", id: `c${line.length}`, name: "Bash", input: {} }] });
  add("user", { text: "first" }); say("one"); add("turn_end");
  add("user", { text: "second" }); add("turn_start");
  say("a"); add("user", { text: "", origin: "restart" }); say("b"); add("assistant", { blocks: [], stop: "refusal" }); say("  "); say("c");
  const end = add("turn_end");
  add("user", { text: "third" }); add("turn_start");
  const silent = add("turn_end");
  expect(replyBefore(line, line.indexOf(end))).toEqual(["a", "b", "c"]);
  // A turn that said nothing has no reply; the last reply with text is the one before it.
  expect(replyBefore(line, line.indexOf(silent))).toEqual([]);
  expect(replyBefore(line, line.length, true)).toEqual(["a", "b", "c"]);
});

test("the branches of a session are counted without a set of every parent", () => {
  const naive = (list: StoredEvent[]) => { const parents = new Set(list.map((e) => e.parent)); return list.filter((e) => !parents.has(e.id)).length; };
  expect(leafCount(all)).toBe(naive(all));
  expect(leafCount(all)).toBe(2);
  expect(leafCount([])).toBe(0);
  // A parent with a child right after it and another further on, and one with two far children.
  const mk = (id: string, parent: string | null, seq: number): StoredEvent => ({ id, session_id: "s", seq, parent, kind: "note", data: {}, ts: seq });
  const list = [mk("a", null, 1), mk("b", "a", 2), mk("c", "b", 3), mk("d", "a", 4), mk("e", "b", 5), mk("f", "b", 6), mk("g", null, 7)];
  expect(leafCount(list)).toBe(naive(list));
  expect(leafCount(list)).toBe(5);
});
