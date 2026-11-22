// A store from before the index of its events' rows (src/core/bare-index.ts): it opens without building
// it, reads work meanwhile from the table, and the build made after the daemon listens runs off the
// loop, on the checkpoint thread, with the turns' writes waiting for it (index-build.ts).
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BARE_INDEX, hasBareIndex, INDEX_NOW_ROWS } from "../core/bare-index.ts";
import { Checkpointer } from "../core/checkpoint.ts";
import { Store } from "../core/store.ts";
import { buildBareIndex } from "./index-build.ts";

// A store with one long session and one short, as a build before the index left it.
function before(events = INDEX_NOW_ROWS + 5_000) {
  const dir = mkdtempSync(join(tmpdir(), "keel-index-"));
  const seed = new Store(dir);
  const long = seed.createSession({ model: "p:m", workspace: "/" }).id, short = seed.createSession({ model: "p:m", workspace: "/" }).id;
  const ins = seed.db.query("INSERT INTO events (id, session_id, seq, parent, kind, data, ts) VALUES (?, ?, ?, ?, ?, ?, ?)");
  seed.db.transaction(() => {
    let prev: string | null = null;
    for (let i = 1; i <= events; i++) { const id = Bun.randomUUIDv7(); ins.run(id, long, i, prev, i === 1 ? "user" : i % 2 ? "tool_result" : "assistant", JSON.stringify({ text: "x".repeat(200), i }), 1_700_000_000_000 + i); prev = id; }
    seed.db.query("UPDATE sessions SET head = ? WHERE id = ?").run(prev, long);
  })();
  (seed as any).forget(long);
  seed.append(short, "user", { text: "hello" });
  seed.db.exec(`DROP INDEX ${BARE_INDEX}`);
  seed.db.close();
  return { dir, long, short, events, end: () => rmSync(dir, { recursive: true, force: true }) };
}
const plan = (store: Store, id: string) => store.db.query<{ detail: string }, [string]>("EXPLAIN QUERY PLAN SELECT id, seq, parent, kind, ts FROM events WHERE session_id = ? ORDER BY seq").all(id).map((r) => r.detail).join("; ");
const until = async (f: () => boolean, ms = 20_000) => { for (const t0 = Date.now(); !f() && Date.now() - t0 < ms;) await Bun.sleep(5); return f(); };

test("a large store without the index opens without building it, and every read works meanwhile", async () => {
  const b = before();
  try {
    const t0 = performance.now();
    const store = new Store(b.dir);
    // Nothing was built in the open: the index is owed, and no statement names it.
    expect([store.indexOwed >= b.events, hasBareIndex(store.db)]).toEqual([true, false]);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(plan(store, b.long)).not.toContain(BARE_INDEX);
    // What reads a session without its bodies, each way there is: a kind looked for, the head, the walk back, the read ahead, the whole.
    expect([store.hasKind(b.long, "user"), store.hasKind(b.short, "assistant"), store.headEvent(b.long)?.kind, store.lastSeq(b.long)]).toEqual([true, false, "assistant", b.events]);
    let walked = 0;
    for (const e of store.back(b.long)) { walked++; if (walked === 300) { expect(e.seq).toBe(b.events - 299); break; } }
    await store.warm(b.short, false);
    expect(store.lineage(b.short).map((e) => e.kind)).toEqual(["user"]);
    expect(store.lineage(b.long).length).toBe(b.events);
    // A small store has it built as it is opened.
    store.db.close();
    const small = mkdtempSync(join(tmpdir(), "keel-index-small-"));
    try { const s = new Store(small); expect([s.indexOwed, hasBareIndex(s.db)]).toEqual([0, true]); s.db.close(); } finally { rmSync(small, { recursive: true, force: true }); }
  } finally { b.end(); }
}, 60_000);

test("the build runs on the checkpoint thread after the events were read ahead: the loop goes on, turns hold their writes, and reads use the index from there", async () => {
  const b = before();
  const store = new Store(b.dir);
  const failures: unknown[] = [];
  const c = new Checkpointer(store, (e) => failures.push(e), undefined, { tickMs: 10, syncMs: 30 });
  try {
    c.start();
    expect(await until(() => c.armed)).toBe(true);
    // The loop's turns while it is built, and what a turn that asks would be told.
    let turns = 0, paced = 0;
    const beat = setInterval(() => { turns++; if (store.pacing?.()) paced++; }, 2);
    const parts: (string | number | null)[][] = [];
    const said: string[] = [];
    const reads = { sql: async <T>(sql: string, params: (string | number | null)[] = []) => { parts.push(params); return store.db.query(sql).all(...params) as T[]; } };
    const done = await buildBareIndex(store, reads, c, (l) => void said.push(l));
    clearInterval(beat);
    expect(done).toMatchObject({ where: "thread" });
    expect([store.indexOwed, hasBareIndex(store.db), failures]).toEqual([0, true, []]);
    // Read ahead in parts over every event, then built.
    expect(parts).toEqual([[0, 20_000], [20_000, 40_000]]);
    expect(said[0]).toStartWith("[store] building the index of the events' rows, once (about ");
    expect(said[1]).toMatch(/^\[store\] the index is built \(\d+\.\d s reading the events, \d+\.\d s building\)$/);
    expect(turns).toBeGreaterThan(3);
    expect(paced).toBeGreaterThan(0);
    // From here the rows are read from the index, and the thread works on as before.
    expect(plan(store, b.long)).toContain(`COVERING INDEX ${BARE_INDEX}`);
    expect([store.hasKind(b.long, "user"), c.armed, store.pacing?.()]).toEqual([true, true, false]);
    store.append(b.short, "assistant", { blocks: [] });
    expect(store.lineage(b.short).map((e) => e.kind)).toEqual(["user", "assistant"]);
    // Asked again: nothing to do.
    expect(await buildBareIndex(store, reads, c, () => {})).toBeUndefined();
  } finally { c.stop(); try { store.db.close(); } catch {} b.end(); }
}, 60_000);

test("with no checkpoint thread the build is made on the loop, and a statement that fails leaves the thread working", async () => {
  const b = before();
  const store = new Store(b.dir);
  const failures: unknown[] = [];
  const c = new Checkpointer(store, (e) => failures.push(e), undefined, { tickMs: 10, syncMs: 30 });
  try {
    const reads = { sql: async <T>(sql: string, params: (string | number | null)[] = []) => store.db.query(sql).all(...params) as T[] };
    // No thread runs (not started): made on the loop, and said.
    const said: string[] = [];
    expect(c.build("SELECT 1", "testing")).toBeUndefined();
    expect(await buildBareIndex(store, reads, undefined, (l) => void said.push(l))).toMatchObject({ where: "loop" });
    expect([hasBareIndex(store.db), said[1]!.endsWith(", on the loop: no checkpoint thread works)")]).toEqual([true, true]);
    // A statement the thread cannot make is told to who asked; the thread is not ended for it.
    c.start();
    expect(await until(() => c.armed)).toBe(true);
    await expect(c.build("CREATE INDEX nope ON no_such_table(x)", "testing")!).rejects.toThrow(/no such table/);
    expect([c.armed, failures]).toEqual([true, []]);
    expect(await c.build("CREATE INDEX IF NOT EXISTS events_kind_probe ON events(kind) WHERE kind = 'never'", "testing")).toBe(true);
    store.append(b.short, "assistant", { blocks: [] });
  } finally { c.stop(); try { store.db.close(); } catch {} b.end(); }
}, 60_000);
