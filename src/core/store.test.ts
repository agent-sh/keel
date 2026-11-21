// What the store reads for a question, which no page can see: how many event
// bodies a cursor read parses, and how it finds its place in a session in memory.
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "keel-store-")); dirs.push(d); return d; };

// A long session with a branch: an edited prompt half way starts a second line.
function long(store: Store, n: number) {
  const s = store.createSession({ model: "m", workspace: "/" });
  let fork: string | null = null;
  for (let i = 1; i <= n; i++) {
    const e = store.append(s.id, i % 2 ? "user" : "assistant", i % 2 ? { text: `prompt ${i}` } : { blocks: [{ type: "text", text: `reply ${i}` }] }, i === n - 4 ? fork : undefined);
    if (i === Math.floor(n / 2)) fork = e.id;
  }
  return { id: s.id, fork: fork! };
}

test("a cursor read parses only the events after the cursor, and finds them in memory without a pass over the session", () => {
  const dir = scratch();
  const N = 2000;
  const { id, fork } = long(new Store(dir), N);
  const cursor = N - 10;

  // Cold: a store that has not read the session.
  const cold = new Store(dir);
  const parse = spyOn(JSON, "parse");
  const tail = cold.events(id, cursor);
  expect(parse).toHaveBeenCalledTimes(10);
  parse.mockClear();
  expect(tail.map((e) => e.seq)).toEqual(Array.from({ length: 10 }, (_, i) => cursor + 1 + i));
  // Both lines of the tree are in it: the branch's first event hangs off the middle of the session.
  expect(tail.find((e) => e.seq === N - 4)!.parent).toBe(fork);
  expect(tail.find((e) => e.seq === N - 3)!.parent).toBe(tail.find((e) => e.seq === N - 4)!.id);

  // Warm: the whole session is in memory now. Count the events looked at.
  const all = cold.events(id);
  expect(all.length).toBe(N);
  expect(all.map((e) => e.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  let looked = 0;
  const cache = (cold as any).parsed;
  cache.set(id, new Proxy(cache.get(id), { get: (t, k, r) => { if (typeof k === "string" && /^\d+$/.test(k)) looked++; return Reflect.get(t, k, r); } }));
  parse.mockClear();
  const warm = cold.events(id, cursor);
  expect(parse).toHaveBeenCalledTimes(0);
  parse.mockRestore();
  expect(warm).toEqual(tail);
  expect(looked).toBeLessThanOrEqual(10 + Math.ceil(Math.log2(N)) + 1);

  // Cursor zero is the whole session, as a list of the caller's own; past the end is nothing.
  const whole = cold.events(id, 0);
  expect(whole.length).toBe(N);
  whole.pop();
  expect(cold.events(id).length).toBe(N);
  expect(cold.events(id, N)).toEqual([]);
  expect(cold.events(id, N + 50)).toEqual([]);
  expect(new Store(dir).events(id, N)).toEqual([]);
  expect(cold.events(id, 1).length).toBe(N - 1);
  // An event written after the read is after the cursor, cold and warm.
  const more = cold.append(id, "user", { text: "one more" });
  expect(cold.events(id, N).map((e) => e.id)).toEqual([more.id]);
  expect(new Store(dir).events(id, N).map((e) => e.id)).toEqual([more.id]);
});

test("the session list reads its partition in order from an index, with the same sessions in the same order", () => {
  const store = new Store(scratch());
  // 400 sessions, three in four archived, activity times in no order of creation.
  const made: { id: string; archived: boolean; updated: number }[] = [];
  store.db.transaction(() => {
    for (let i = 0; i < 400; i++) {
      const s = store.createSession({ model: "m", workspace: "/" });
      const row = { id: s.id, archived: i % 4 !== 0, updated: 1_000_000 + ((i * 7919) % 400) };
      store.db.query("UPDATE sessions SET archived = ?, updated = ? WHERE id = ?").run(row.archived ? 1 : 0, row.updated, row.id);
      made.push(row);
    }
  })();
  store.db.exec("ANALYZE");
  // The statement the list runs, and its plan.
  const seen: string[] = [];
  const db = store.db as any;
  const real = db.query.bind(db);
  db.query = (sql: string) => { seen.push(sql); return real(sql); };
  const lists = { active: store.sessions(), archived: store.sessions({ archived: true }) };
  db.query = real;
  expect(seen.length).toBe(2);
  const plan = store.db.query<{ detail: string }, [number]>(`EXPLAIN QUERY PLAN ${seen[0]}`).all(0).map((r) => r.detail);
  expect(plan).toEqual(["SEARCH sessions USING INDEX sessions_list (archived=?)"]);

  for (const [name, list] of Object.entries(lists)) {
    const want = made.filter((m) => m.archived === (name === "archived")).sort((a, b) => b.updated - a.updated).map((m) => m.id);
    expect(list.map((s) => s.id)).toEqual(want);
  }
  // Activity moves a session to the top of its list; archiving moves it to the other.
  const last = lists.active.at(-1)!.id;
  store.append(last, "user", { text: "again" });
  expect(store.sessions()[0]!.id).toBe(last);
  store.updateSession(last, { archived: true });
  expect(store.sessions().some((s) => s.id === last)).toBe(false);
  expect(store.sessions({ archived: true })[0]!.id).toBe(last);
});
