// The transcript's rows built step by step are the rows built at once, and a
// step leaves the rows it does not change as the objects they were.
import { expect, test } from "bun:test";
import { lineage } from "../../../src/core/tree.ts";
import type { StoredEvent } from "../../../src/core/types.ts";
import { buildRows, nextLineage, nextSiblings, type Built, type LineageOf, type Row, type SiblingsOf } from "./rows.ts";

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
  expect(rows.filter((r) => r.kind === "assistant" && r.results!.some(Boolean)).length).toBe(31);
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
