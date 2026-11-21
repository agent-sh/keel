// A page of a branch (pageOf): which events a reader that holds a session in
// parts is given for each way of asking.
import { expect, test } from "bun:test";
import { lineage, pageOf } from "./tree.ts";
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
