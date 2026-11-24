// The transcript's rows built step by step are the rows built at once, and a
// step leaves the rows it does not change as the objects they were.
import { expect, test } from "bun:test";
import { lineage } from "../../../src/core/tree.ts";
import type { StoredEvent } from "../../../src/core/types.ts";
import { BLOCK_BITS, buildRows, nextLineage, nextSiblings, type Built, type LineageOf, type Row, type SiblingsOf } from "./rows.ts";

let seq = 0;
const all: StoredEvent[] = [];
const ev = (kind: StoredEvent["kind"], data: any, parent?: string | null): StoredEvent => {
  const e: StoredEvent = { id: `e${++seq}`, session_id: "s", seq, parent: parent === undefined ? all.at(-1)?.id ?? null : parent, kind, data, ts: seq };
  all.push(e);
  return e;
};
const input = (e: StoredEvent) => e.data.kind === "task";
const flat = (b: Built): Row[] => b.blocks.flat();
const plain = (b: Built) => flat(b).map(({ e, vs, prompt, notes, ...r }) => ({ ...r, vs: vs?.map((x) => x.id), prompt: prompt?.id, notes: notes?.map((x) => x.id) }));

function turn(n: number, parent?: string | null) {
  const u = ev("user", { text: `prompt ${n}` }, parent);
  ev("note", { memory: { hooks: [] }, text: "- a fact" });
  ev("turn_start", {});
  ev("assistant", { blocks: [{ type: "text", text: `step ${n}` }, { type: "tool_use", id: `call${n}`, name: "Bash", input: {} }] });
  ev("tool_result", { results: [{ type: "tool_result", tool_use_id: `call${n}`, content: `out ${n}` }] });
  ev("assistant", { blocks: [{ type: "text", text: `done ${n}` }] });
  ev("turn_end", { reason: "end_turn", ms: 1 });
  return u;
}

test("rows built event by event are the rows built at once", () => {
  for (let n = 1; n <= 30; n++) turn(n);
  ev("assistant", { blocks: [], stop: "refusal" });
  ev("note", { kind: "fallback", text: "fallback" });
  ev("user", { text: "notice", kind: "task" });
  ev("compaction", { mode: "clear", undo_head: "e1" });
  ev("note", { text: "a page note" });
  const fork = all.at(-1)!.id;
  turn(31);
  turn(32, fork); // an edited prompt: a second version, a new branch

  let line: LineageOf | undefined, sibs: SiblingsOf | undefined, built: Built | undefined;
  const seen: StoredEvent[] = [];
  for (const e of all) {
    seen.push(e);
    const list = seen.slice();
    line = nextLineage(line, list, e.id);
    expect(line.out.map((x) => x.id)).toEqual(lineage(list, e.id).map((x) => x.id));
    sibs = nextSiblings(sibs, list);
    const before = built ? flat(built) : [];
    built = buildRows(built, line.out, sibs.map, false, input);
    const whole = buildRows(undefined, lineage(list, e.id), nextSiblings(undefined, list).map, false, input);
    expect(plain(built)).toEqual(plain(whole));
    expect(built.pending.map((x) => x.id)).toEqual(whole.pending.map((x) => x.id));
    // A step on the same branch keeps every row it did not change: at most the
    // new row, and one earlier row whose content the event changed (a call's
    // result, a clear no longer undoable, a refusal the fallback took).
    const after = flat(built);
    if (after.length >= before.length && before.every((r, i) => r.id === after[i]!.id)) {
      expect(before.filter((r, i) => r !== after[i]).length).toBeLessThanOrEqual(1);
    }
  }
  const rows = flat(built!);
  expect(rows.find((r) => r.kind === "refusal")!.handled).toBe(true);
  expect(rows.find((r) => r.kind === "checkpoint")!.undoable).toBe(false);
  expect(rows.find((r) => r.id === all.find((e) => e.data.text === "prompt 32")!.id)!.vs!.length).toBe(2);
  expect(rows.filter((r) => r.kind === "work" && r.steps!.some((st) => st.items.some((i) => i.t === "call" && i.result))).length).toBe(31);
  expect(rows.at(-1)!.notes!.length).toBe(1);
});

test("a head named before its event arrives keeps the branch until it does", () => {
  const list = all.slice(0, 20);
  const next = all[20]!;
  let line = nextLineage(undefined, list, list.at(-1)!.id);
  line = nextLineage(line, list, next.id); // the session's frame came first
  expect(line.out.at(-1)).toBe(list.at(-1)!); // the branch shown stays meanwhile
  line = nextLineage(line, [...list, next], next.id);
  expect(line.out.map((e) => e.id)).toEqual(lineage([...list, next], next.id).map((e) => e.id));
});

test("a branch first read before any of its head's events came is read again when they come", () => {
  // The session's row (with the head its turn reached) came before the page's older snapshot.
  const list = all.slice(0, 20);
  const head = all[24]!.id;
  let line = nextLineage(undefined, list, head);
  expect(line.out).toEqual([]);
  line = nextLineage(line, all.slice(0, 22), head); // a part of what came after the snapshot
  line = nextLineage(line, all.slice(0, 25), head);
  expect(line.out.map((e) => e.id)).toEqual(lineage(all.slice(0, 25), head).map((e) => e.id));
});

test("going back to a branch gives its rows as the objects they were", () => {
  const a = all.find((e) => e.data.text === "prompt 31")!;
  const leafA = all[all.findIndex((e) => e.id === a.id) + 6]!;
  const leafB = all.at(-1)!;
  const sibs = nextSiblings(undefined, all).map;
  const onB = buildRows(undefined, lineage(all, leafB.id), sibs, false, input);
  const onA = buildRows(onB, lineage(all, leafA.id), sibs, false, input);
  const back = buildRows(onA, lineage(all, leafB.id), sibs, false, input);
  const shared = flat(onB).filter((r) => r.e.seq < a.seq);
  expect(shared.length).toBeGreaterThan(100);
  for (const r of shared) expect(flat(onA)).toContain(r);
  // Whole blocks under the fork are the same arrays.
  expect(onA.blocks[0]).toBe(onB.blocks[0]);
  expect(plain(back)).toEqual(plain(onB));
});

test("a turn's failures stand with its footer, and restarts in a row are one footer", () => {
  const from = all.length;
  // A failed turn: its end, then what failed (two events), then a failure by itself after a note.
  ev("user", { text: "fails" });
  ev("turn_start", {});
  const failedEnd = ev("turn_end", { reason: "error", ms: 1 });
  const f1 = ev("error", { message: "HTTP 529: overloaded" });
  const f2 = ev("error", { message: "gave up" });
  const note = ev("note", { text: "a page note" });
  const alone = ev("error", { message: "by itself" });
  // Three restarts with nothing said between, then one after a reply.
  ev("user", { text: "waits through restarts" });
  ev("turn_start", {});
  const r1 = ev("turn_end", { reason: "restart", ms: 1 });
  ev("user", { text: "", origin: "restart" });
  ev("turn_start", {});
  const r2 = ev("turn_end", { reason: "restart", ms: 1 });
  ev("user", { text: "", origin: "restart" });
  ev("turn_start", {});
  ev("tool_result", { results: [] });
  const r3 = ev("turn_end", { reason: "restart", ms: 1 });
  ev("user", { text: "", origin: "restart" });
  ev("turn_start", {});
  ev("assistant", { blocks: [{ type: "text", text: "went on" }] });
  const r4 = ev("turn_end", { reason: "restart", ms: 1 });

  // Event by event, and at once: the same rows.
  let line: LineageOf | undefined, built: Built | undefined;
  for (let n = from; n <= all.length; n++) {
    const list = all.slice(0, n);
    line = nextLineage(line, list, list.at(-1)!.id);
    built = buildRows(built, line.out, nextSiblings(undefined, list).map, false, input);
    expect(plain(built)).toEqual(plain(buildRows(undefined, lineage(list, list.at(-1)!.id), nextSiblings(undefined, list).map, false, input)));
  }
  const rows = new Map(flat(built!).map((r) => [r.id, r]));
  expect(rows.get(failedEnd.id)!.failures!.map((e) => e.id)).toEqual([f1.id, f2.id]);
  expect(rows.has(f1.id) || rows.has(f2.id)).toBe(false);
  expect(rows.get(alone.id)).toMatchObject({ kind: "error", after: note.id });
  expect([r1, r2, r3, r4].map((e) => [rows.get(e.id)!.folded ?? false, rows.get(e.id)!.times ?? 1])).toEqual([[true, 1], [true, 2], [false, 3], [false, 1]]);
  // The folded footers' notes (the restart marks) are on the one that stands for them.
  expect(rows.get(r3.id)!.notes!.length).toBe(2);
});

test("a footer whose turn began before the events shown says its reply is not all here", () => {
  const from = all.length;
  ev("user", { text: "a long turn" });
  ev("turn_start", {});
  for (let i = 0; i < 6; i++) ev("assistant", { blocks: [{ type: "text", text: `step ${i}` }] });
  const end = ev("turn_end", { reason: "end_turn", ms: 1 });
  const next = turn(99);
  const line = lineage(all, all.at(-1)!.id);
  // The part held starts inside the long turn.
  const part = line.slice(line.findIndex((e) => e.id === all[from + 5]!.id));
  const rows = new Map(buildRows(undefined, part, nextSiblings(undefined, part).map, false, input).blocks.flat().map((r) => [r.id, r]));
  expect(rows.get(end.id)).toMatchObject({ partial: true, reply: ["step 3", "step 4", "step 5"] });
  expect(rows.get(end.id)!.prompt).toBeUndefined();
  // The next turn's prompt is held: its footer is whole. So is the long turn's with its prompt in the run.
  expect(rows.get(all.at(-1)!.id)!.partial).toBeUndefined();
  expect(rows.get(all.at(-1)!.id)!.prompt).toBe(next);
  expect(buildRows(undefined, line, nextSiblings(undefined, line).map, false, input).blocks.flat().find((r) => r.id === end.id)!.partial).toBeUndefined();
});

// A run of calls longer than the part a page holds: `n` replies, each a short line and a call.
function longRun(n: number) {
  const from = all.length;
  ev("user", { text: "a long run" });
  ev("turn_start", {});
  for (let k = 1; k <= n; k++) {
    ev("assistant", { blocks: [{ type: "text", text: `Step ${k}.` }, { type: "tool_use", id: `run${seq}`, name: "Bash", input: { command: `echo ${k}` } }] });
    ev("tool_result", { results: [{ type: "tool_result", tool_use_id: `run${seq - 1}`, content: `${k}` }] });
  }
  return all.slice(from);
}

test("a run of calls keeps its name, its place and its unchanged steps when older events of it are read in above", () => {
  const events = longRun(120);
  const sib = nextSiblings(undefined, events).map;
  // The page holds the end of the run first (its start is in a part not held), then an older part, then the whole.
  const tail = events.slice(-60), mid = events.slice(-140);
  const first = buildRows(undefined, tail, sib, false, input);
  const run = flat(first).find((r) => r.kind === "work")!;
  expect(run.id).toBe(`w:${tail[0]!.id}`);
  const more = buildRows(first, mid, sib, false, input);
  const grown = flat(more).filter((r) => r.kind === "work");
  expect(grown.length).toBe(1);
  // The same row: its name and the event that names it, in the block that event is in.
  expect(grown[0]!.id).toBe(run.id);
  expect(grown[0]!.e).toBe(run.e);
  expect(more.blocks[more.at.get(run.id)!]!.includes(grown[0]!)).toBe(true);
  expect(more.blocks.every((rows) => rows.length > 0 && rows.every((r) => (r.e.seq >> BLOCK_BITS) === (rows[0]!.e.seq >> BLOCK_BITS)))).toBe(true);
  expect(new Set(more.blocks.map((rows) => rows[0]!.e.seq >> BLOCK_BITS)).size).toBe(more.blocks.length);
  // It begins earlier now, and the steps it had are the objects they were (but the one the older events joined).
  expect(grown[0]!.steps!.length).toBe(70);
  const had = new Set(run.steps);
  expect(grown[0]!.steps!.filter((st) => had.has(st)).length).toBe(run.steps!.length);
  // A result that lands later still finds the run under its name.
  const call = (grown[0]!.steps!.at(-1)!.items.find((i) => i.t === "call") as { id: string }).id;
  const late = [...mid, { ...mid.at(-1)!, id: "late", seq: seq + 1, kind: "tool_result" as const, data: { results: [{ type: "tool_result", tool_use_id: call, content: "again" }] } }];
  const after = flat(buildRows(more, late, sib, false, input)).find((r) => r.kind === "work")!;
  expect(after.id).toBe(run.id);
  expect((after.steps!.at(-1)!.items.find((i) => i.t === "call") as { result?: { content: unknown } }).result!.content).toBe("again");
  // Read in whole, it is still that row; built with nothing before it, it is named by its own first event.
  const whole = flat(buildRows(more, events, sib, false, input)).find((r) => r.kind === "work")!;
  expect([whole.id, whole.steps!.length]).toEqual([run.id, 120]);
  expect(flat(buildRows(undefined, events, sib, false, input)).find((r) => r.kind === "work")!.id).toBe(`w:${events[2]!.id}`);
});

test("a reply's words and calls stand in the order it has them, each row with a name of its own", () => {
  const from = all.length;
  const long = "A reply long enough to stand on the page as a reply of its own: it explains what was found, at some length, and why the next call is made. ".repeat(2);
  ev("user", { text: "order" });
  ev("turn_start", {});
  const e = ev("assistant", { blocks: [
    { type: "text", text: "A few words." }, { type: "tool_use", id: "o1", name: "Read", input: { file_path: "/w/a.ts" } },
    { type: "text", text: long }, { type: "tool_use", id: "o2", name: "Bash", input: { command: "ls" } },
    { type: "thinking", thinking: "and then" }, { type: "text", text: `${long} Again.` },
  ] });
  const rows = flat(buildRows(undefined, all.slice(from), nextSiblings(undefined, all).map, false, input)).filter((r) => r.e === e);
  expect(rows.map((r) => [r.kind, r.id])).toEqual([["work", `w:${e.id}`], ["assistant", `${e.id}:2`], ["work", `w:${e.id}:3`], ["assistant", `${e.id}:5`]]);
  expect(rows[0]!.steps!.map((st) => st.items.map((i) => i.t))).toEqual([["note", "call"]]);
  expect(rows[1]!.prose).toEqual([2]);
  expect(rows[2]!.steps!.map((st) => st.items.map((i) => i.t))).toEqual([["call", "thought"]]);
  expect(rows[3]!.prose).toEqual([5]);
  expect(new Set(rows.map((r) => r.id)).size).toBe(4);
});

test("the calls of one reply are grouped by what they do, however the model ordered them", () => {
  const from = all.length;
  ev("user", { text: "parallel" });
  ev("turn_start", {});
  const names = ["Bash", "Read", "Grep", "Edit"];
  const blocks = Array.from({ length: 100 }, (_, k) => ({ type: "tool_use", id: `p${k}`, name: names[k % 4]!, input: names[k % 4] === "Edit" ? { file_path: `/w/f${k}.ts`, old_string: "a", new_string: "b" } : { command: "ls", file_path: `/w/f${k}.ts`, pattern: "x" } }));
  ev("assistant", { blocks });
  const run = flat(buildRows(undefined, all.slice(from), nextSiblings(undefined, all).map, false, input)).find((r) => r.kind === "work")!;
  expect(run.steps!.map((st) => [st.family, st.items.length])).toEqual([["run", 25], ["explore", 50], ["change", 25]]);
});
