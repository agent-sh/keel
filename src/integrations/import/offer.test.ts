// Pages of a listing: every row once whatever ties its place, and what a
// reader is told when the list changes between two of its pages.
import { expect, test } from "bun:test";
import { byCodePoint, CursorError, offered, page, select, type ListQuery } from "./offer.ts";
import type { Found } from "./types.ts";

// A catalog with rows a machine does not offer, rows a plain listing leaves
// out, and many rows that tie on every sort value.
function catalog(n: number): Found[] {
  const rows: Found[] = [];
  for (let i = 0; i < n; i++) {
    const hidden = i % 9 === 4; // under a credentials folder: never offered
    const sub = i % 11 === 7;
    rows.push({
      harness: i % 3 ? "claude" : "codex", id: `id-${i}`, path: `/store/${hidden ? ".ssh/" : ""}p${i % 17}/${String(i).padStart(5, "0")}.jsonl`,
      cwd: `/work/p${i % 17}`, title: `Title ${i % 40}`, first_prompt: `prompt ${i}`, updated_ms: 1_700_000_000_000 + (i % 25) * 1000, size_bytes: 100 + (i % 13), kind: sub ? "subagent" : "interactive",
    });
  }
  return rows;
}

// Every page of a listing, as a reader follows `next_cursor`; `between` runs after each page.
function readAll(rows: () => Found[], q: ListQuery, between?: (n: number) => void) {
  const out: Found[] = [];
  const flags: boolean[] = [];
  let cursor: string | undefined;
  let total = 0;
  for (let n = 1; ; n++) {
    const p = page(rows(), { ...q, cursor }, { max: 200 });
    out.push(...p.sessions);
    flags.push(!!p.changed);
    total = p.total;
    if (!(cursor = p.next_cursor)) break;
    between?.(n);
  }
  return { out, flags, total };
}

test("a list of more than 500 offered rows is paged whole: each eligible row once, in order, ties and excluded rows included", () => {
  const all = catalog(1400);
  const mine = all.filter(offered);
  const eligible = mine.filter((f) => f.kind === "interactive");
  expect(eligible.length).toBeGreaterThan(500);
  expect(all.length - mine.length).toBeGreaterThan(100);
  for (const sort of ["updated", "size", "title"] as const) {
    const { out, flags, total } = readAll(() => mine, { sort, limit: 200 });
    expect(total).toBe(eligible.length);
    expect(out.map((f) => f.id)).toEqual(select(mine, { sort }).map((f) => f.id));
    expect(new Set(out.map((f) => f.id)).size).toBe(eligible.length);
    expect(flags.some(Boolean)).toBe(false);
  }
  // The order does not depend on the order the rows were read in.
  expect(select([...mine].reverse(), {}).map((f) => f.id)).toEqual(select(mine, {}).map((f) => f.id));
});

test("a row that arrives, leaves or moves between two pages never hides another row, and the page says the list changed", () => {
  const base = catalog(900).filter(offered);
  const want = new Set(select(base, {}).map((f) => f.id));
  const fresh = (id: string, updated_ms: number): Found => ({ harness: "claude", id, path: `/store/new/${id}.jsonl`, title: id, updated_ms, size_bytes: 1, kind: "interactive" });
  const check = (change: (rows: Found[]) => Found[], changedAt: boolean[], gone: string[] = []) => {
    let rows = base;
    const { out, flags } = readAll(() => rows, { limit: 200 }, (n) => { if (n === 2) rows = change(rows); });
    const ids = out.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length); // no row twice
    for (const id of want) if (!gone.includes(id)) expect(ids.includes(id)).toBe(true); // no row skipped
    expect(flags.slice(0, changedAt.length)).toEqual(changedAt);
  };
  // A newer session arrives above the pages read: the rest still comes whole, and page 3 says so.
  check((r) => [...r, fresh("arrived-top", 1_800_000_000_000)], [false, false, true, false]);
  // One arrives below them: it is simply in a later page.
  check((r) => [...r, fresh("arrived-below", 1)], [false, false, false, false]);
  // A row already read is removed: nothing after it is skipped.
  const first = select(base, {})[3]!.id;
  check((r) => r.filter((f) => f.id !== first), [false, false, true], [first]);
  // A row not read yet moves above the cursor (its session went on): it would be
  // missed, so the page says the list changed. A reader that starts again sees it.
  const late = select(base, {}).at(-5)!.id;
  let moved = base;
  const run = readAll(() => moved, { limit: 200 }, (n) => { if (n === 2) moved = moved.map((f) => (f.id === late ? { ...f, updated_ms: 1_800_000_000_000 } : f)); });
  expect(run.out.some((f) => f.id === late)).toBe(false);
  expect(run.flags[2]).toBe(true);
  expect(readAll(() => moved, { limit: 200 }).out.filter((f) => f.id === late)).toHaveLength(1);
});

test("a cursor belongs to its listing, and strings order as the index orders them", () => {
  const rows = catalog(300);
  const c = page(rows, { limit: 50 }).next_cursor!;
  expect(page(rows, { limit: 10, cursor: c }).sessions).toHaveLength(10); // another page size is the same listing
  for (const q of [{ q: "prompt" }, { sort: "size" as const }, { show: "all" }]) expect(() => page(rows, { ...q, cursor: c })).toThrow(CursorError);
  expect(() => page(rows, { cursor: "60" })).toThrow(CursorError);
  expect(page(rows, { cursor: "0", limit: 5 }).sessions.map((f) => f.id)).toEqual(page(rows, { limit: 5 }).sessions.map((f) => f.id));
  const words = ["a", "B", "é", "\uffff", "\u{1f600}", "\ue000", "ab", "", "א"];
  const bytes = (x: string, y: string) => Buffer.compare(Buffer.from(x), Buffer.from(y));
  expect([...words].sort(byCodePoint)).toEqual([...words].sort(bytes));
});
