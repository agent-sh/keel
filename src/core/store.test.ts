// What the store reads for a question, which no page can see: how many event
// bodies a cursor read parses, and how it finds its place in a session in memory.
import { Database } from "bun:sqlite";
import { afterAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BARE_COST, BARE_KEPT_MS, IDLE_KEPT_MS, Store } from "./store.ts";

// These tests write a database of their own to disk; under a disk stall of a
// shared machine a write waits seconds, and the 5 s default was passed in
// whole-suite runs by tests that take milliseconds alone.
setDefaultTimeout(20_000);

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
  const kept = (cold as any).kept.get(id);
  kept.all = new Proxy(kept.all, { get: (t, k, r) => { if (typeof k === "string" && /^\d+$/.test(k)) looked++; return Reflect.get(t, k, r); } });
  parse.mockClear();
  const warm = cold.events(id, cursor);
  expect(parse).toHaveBeenCalledTimes(0);
  parse.mockRestore();
  expect(looked).toBeLessThanOrEqual(10 + Math.ceil(Math.log2(N)) + 1);
  expect(warm).toEqual(tail);

  // Cursor zero is the whole session: one list for every reader until the next event, and none
  // that grows under a reader that holds it (see the test of appends below). Past the end is nothing.
  const whole = cold.events(id, 0);
  expect(whole.length).toBe(N);
  expect(cold.events(id)).toBe(whole);
  expect(cold.events(id, N)).toEqual([]);
  expect(cold.events(id, N + 50)).toEqual([]);
  expect(new Store(dir).events(id, N)).toEqual([]);
  expect(cold.events(id, 1).length).toBe(N - 1);
  // An event written after the read is after the cursor, cold and warm.
  const more = cold.append(id, "user", { text: "one more" });
  expect(cold.events(id, N).map((e) => e.id)).toEqual([more.id]);
  expect(new Store(dir).events(id, N).map((e) => e.id)).toEqual([more.id]);
});

// Reads of a session's events from the table: its events without bodies, and the bodies of a run.
function tableReads(store: Store) {
  const reads: string[] = [];
  const db = store.db as any;
  const real = db.query.bind(db);
  db.query = (sql: string) => { if (/FROM events WHERE session_id = \? (ORDER|AND seq)/.test(sql)) reads.push(sql); return real(sql); };
  return { reads, stop: () => { db.query = real; } };
}

test("a step of a working session reads nothing again, however many other sessions work", () => {
  const store = new Store(scratch());
  // Twelve sessions with a history, each in a turn.
  const ids = Array.from({ length: 12 }, () => long(store, 200).id);
  for (const id of ids) store.updateSession(id, { phase: "working" });
  // (As after a start: nothing of them is in memory. A session made in this process holds what was appended to it.)
  for (const id of ids) (store as any).forget(id);
  for (const id of ids) store.lineage(id);
  const parse = spyOn(JSON, "parse");
  const { reads, stop } = tableReads(store);
  try {
    // Three rounds of one step each: the branch is read, a reply and a result are appended, it is read again.
    for (let round = 0; round < 3; round++) {
      for (const id of ids) {
        const before = store.lineage(id);
        const a = store.append(id, "assistant", { blocks: [{ type: "text", text: `step ${round}` }] });
        const b = store.append(id, "tool_result", { results: [] });
        const after = store.lineage(id);
        expect(after.length).toBe(before.length + 2);
        expect(after.slice(-2).map((e) => e.id)).toEqual([a.id, b.id]);
        expect(store.events(id, a.seq).map((e) => e.id)).toEqual([b.id]);
      }
    }
    // Nothing of a session was read from the table, and at most the appended events were parsed (their own round trip).
    expect(reads).toEqual([]);
    expect(parse.mock.calls.length).toBeLessThanOrEqual(3 * 12 * 2);
    // What a request reads, the bodies at the branch's end, is read once a session (the run they are in and the one before it at most), then held.
    for (const id of ids) expect(store.lineage(id).slice(-10).map((e) => e.kind + JSON.stringify(e.data).length).length).toBe(10);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBeLessThanOrEqual(2 * 12);
    reads.length = 0;
    parse.mockClear();
    for (const id of ids) expect(store.lineage(id).slice(-10).map((e) => JSON.stringify(e.data)).length).toBe(10);
    expect([reads, parse.mock.calls.length]).toEqual([[], 0]);
  } finally {
    stop();
    parse.mockRestore();
  }
  expect(store.keptEvents().sessions).toBe(12);
  // What is held is what the table holds.
  const cold = new Store(store.stateDir);
  for (const id of ids) expect(store.lineage(id)).toEqual(cold.lineage(id));
  for (const id of ids) expect(JSON.stringify(store.events(id))).toBe(JSON.stringify(cold.events(id)));
});

test("kept events are bounded by the memory they take: idle sessions go first, then the bodies read longest ago, and an idle session unread for a while goes by itself", () => {
  const dir = scratch();
  const seed = new Store(dir);
  const text = "x".repeat(1000);
  const make = () => {
    const s = seed.createSession({ model: "m", workspace: "/" });
    seed.db.transaction(() => { for (let i = 0; i < 320; i++) seed.append(s.id, "user", { text, i }); })();
    return s.id;
  };
  const [a, w, v, c] = [make(), make(), make(), make()];
  seed.updateSession(w, { phase: "working" });
  seed.updateSession(v, { phase: "working" });
  // Each session's bodies are charged about 0.8 MB (320 kB of stored text at two and a half times), its events alone about 130 kB.
  const kept = process.env.KEEL_EVENTS_MEMORY_MB;
  process.env.KEEL_EVENTS_MEMORY_MB = "1.35";
  let store: Store;
  try { store = new Store(dir); } finally { if (kept === undefined) delete process.env.KEEL_EVENTS_MEMORY_MB; else process.env.KEEL_EVENTS_MEMORY_MB = kept; }
  const held = () => [...((store as any).kept as Map<string, unknown>).keys()];
  const runs = (id: string) => ((store as any).kept.get(id).runs as unknown[]).filter(Boolean).length;
  const bodies = (id: string) => store.lineage(id).map((e) => (e.data as { i: number }).i);
  const within = () => expect(store.keptEvents().bytes).toBeLessThanOrEqual(store.keptEvents().budget);
  const want = Array.from({ length: 320 }, (_, i) => i);

  // A session's events cost little until their bodies are read.
  store.lineage(w);
  store.lineage(a);
  expect(held()).toEqual([w, a]);
  expect(store.keptEvents().bytes).toBe(2 * 320 * BARE_COST);
  expect([runs(w), runs(a)]).toEqual([0, 0]);
  expect(bodies(a)).toEqual(want);
  expect(runs(a)).toBe(5);
  // The working session's bodies do not fit beside the idle one's: the idle session's bodies go (as many as it takes), and its events stay.
  expect(bodies(w)).toEqual(want);
  expect(held()).toEqual([a, w]);
  expect([runs(a) < 5, runs(w)]).toEqual([true, 5]);
  within();
  // Two working sessions that do not fit together: the idle session goes whole before a working one loses a body.
  // Both working ones stay, and the bodies read longest ago go.
  expect(bodies(v)).toEqual(want);
  expect(held()).toEqual([w, v]);
  expect(runs(v)).toBeGreaterThanOrEqual(4);
  expect(runs(w)).toBeLessThan(5);
  within();
  // The first runs of the one read before went first; reading its end again reads nothing from the table.
  const { reads, stop } = tableReads(store);
  try {
    expect(store.lineage(v).slice(-64).map((e) => (e.data as { i: number }).i)).toEqual(want.slice(-64));
    expect(reads).toEqual([]);
    // And what went is read again when asked for, a run at a time.
    expect(bodies(w)).toEqual(want);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.length).toBeLessThanOrEqual(5);
  } finally { stop(); }
  expect(held()).toEqual([v, w]);
  within();
  // An append counts: a body joins the run it falls in, or starts one.
  for (let i = 320; i < 400; i++) store.append(w, "user", { text, i });
  expect(bodies(w)).toEqual([...want, ...Array.from({ length: 80 }, (_, i) => 320 + i)]);
  expect(held()).toEqual([v, w]);
  within();
  // An event handed out before its session was dropped still reads its body, from the table.
  const old = store.lineage(c);
  expect(old.slice(-64).map((e) => (e.data as { i: number }).i)).toEqual(want.slice(-64));
  expect([held(), runs(c)]).toEqual([[v, w, c], 1]);
  const age = (ms: number) => { for (const k of ((store as any).kept as Map<string, { at: number }>).values()) k.at -= ms; };
  // Unread for the idle time: an idle session gives its bodies back and keeps its events; the working ones keep both.
  const had = { v: runs(v), w: runs(w) };
  age(IDLE_KEPT_MS);
  (store as any).sweep();
  expect([held(), runs(c), runs(v), runs(w)]).toEqual([[v, w, c], 0, had.v, had.w]);
  // Read by anyone meanwhile, a session stays: a session others keep reading is never read in again.
  age(BARE_KEPT_MS - IDLE_KEPT_MS - 1000);
  expect(store.lineage(c).length).toBe(320);
  age(2000);
  (store as any).sweep();
  // (The working ones stay too: a turn reads its session next, however long it sat in one call.)
  expect(held()).toEqual([v, w, c]);
  store.updateSession(v, { phase: "idle" });
  store.updateSession(w, { phase: "idle" });
  (store as any).sweep();
  expect(held()).toEqual([c]);
  // Unread by anyone for the long time, but held by a request that is still being answered: it stays,
  // against the sweep and against the budget, and nothing reads its rows again.
  age(BARE_KEPT_MS);
  const release = store.hold(c), second = store.hold(c);
  (store as any).sweep();
  expect(held()).toEqual([c]);
  expect(bodies(a)).toEqual(want);
  expect(bodies(v)).toEqual(want);
  expect(held()).toContain(c);
  const cold = store.coldReads().n;
  expect(store.lineage(c).length).toBe(320);
  expect(store.coldReads().n).toBe(cold);
  // Released by one of two: still held. By both (a release called twice counts once): it goes whole,
  // and what was handed out of it reads from the table.
  release(); release();
  age(BARE_KEPT_MS);
  (store as any).sweep();
  expect(held()).toContain(c);
  second();
  age(BARE_KEPT_MS);
  (store as any).sweep();
  expect(held()).toEqual([]);
  expect(old.map((e) => (e.data as { i: number }).i)).toEqual(want);
  expect(held()).toEqual([]);
  store.lineage(v);
  store.lineage(w);
  // A deleted session is not kept, and what was handed out of it says its events are gone.
  const gone = store.lineage(v);
  store.deleteSession(v);
  store.deleteSession(w);
  expect(() => gone[0]!.data).toThrow(/not stored/);
  expect(store.keptEvents()).toMatchObject({ sessions: 0, bytes: 0, budget: 1.35e6 });
  expect((store as any).sweeper).toBeUndefined();
});

test("a long session is brought into memory in parts, with the loop free in between", async () => {
  const dir = scratch();
  const seed = new Store(dir);
  const s = seed.createSession({ model: "m", workspace: "/" });
  seed.db.transaction(() => { for (let i = 0; i < 9000; i++) seed.append(s.id, "user", { text: "y".repeat(400), i }); })();
  const store = new Store(dir);
  // Turns of the loop while it is read in: its 9,000 events come in three parts, so the loop is given back twice at least.
  let turns = 0, counting = true;
  const turn = () => { if (counting) { turns++; setImmediate(turn); } };
  setImmediate(turn);
  const before = store.keptEvents().sessions;
  const warming = store.warm(s.id);
  // Written while it is read in: part of what is kept at the end.
  await new Promise((r) => setImmediate(r));
  const late = store.append(s.id, "user", { text: "late", i: 9000 });
  await warming;
  counting = false;
  expect(before).toBe(0);
  expect(turns).toBeGreaterThanOrEqual(2);
  // Everything is there: the whole session is read with nothing more taken from the table.
  const { reads, stop } = tableReads(store);
  try {
    const all = store.events(s.id);
    expect(all.length).toBe(9001);
    expect(all.at(-1)!.id).toBe(late.id);
    expect(all.map((e) => (e.data as { i: number }).i)).toEqual(Array.from({ length: 9001 }, (_, i) => i));
    expect(reads).toEqual([]);
  } finally { stop(); }
  // Warming a session already there reads nothing either.
  await store.warm(s.id);
});

test("the sessions a restart cut are found from their last event, with no session read", () => {
  const dir = scratch();
  const seed = new Store(dir);
  const make = (reason: string | null) => {
    const { id } = long(seed, 40);
    if (reason) seed.append(id, "turn_end", { reason });
    return id;
  };
  const cut = make("restart");
  make("end_turn");
  make(null);
  const archived = make("restart");
  seed.updateSession(archived, { archived: true });
  // Its cut turn is on a branch the session no longer shows.
  const moved = make("restart");
  seed.updateSession(moved, { head: seed.events(moved).at(-2)!.id });
  const newer = make("restart");
  seed.db.query("UPDATE sessions SET updated = updated + 1000 WHERE id = ?").run(newer);

  const store = new Store(dir);
  const seen: string[] = [];
  const db = store.db as any;
  const real = db.query.bind(db);
  db.query = (sql: string) => { seen.push(sql); return real(sql); };
  const found = store.cutSessions().map((s) => s.id);
  db.query = real;
  expect(found).toEqual([newer, cut]);
  expect(seen.length).toBe(1);
  expect(store.db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${seen[0]}`).all().map((r) => r.detail)).toEqual([
    "SEARCH s USING INDEX sessions_list (archived=?)",
    "SEARCH e USING INDEX sqlite_autoindex_events_1 (id=?)",
  ]);
  expect(store.keptEvents().sessions).toBe(0);
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

// A database from before the event tree: no parent, no head; two sessions
// whose events were written in turns.
function beforeTheTree(dir: string) {
  const db = new Database(join(dir, "keel.db"), { create: true });
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', model TEXT NOT NULL, workspace TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, phase TEXT NOT NULL DEFAULT 'idle', archived INTEGER NOT NULL DEFAULT 0, usage TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, ts INTEGER NOT NULL, UNIQUE(session_id, seq));
    INSERT INTO sessions (id, model, workspace, created, updated) VALUES ('a', 'm', '/', 1, 1), ('b', 'm', '/', 2, 2);
  `);
  const add = db.query("INSERT INTO events (id, session_id, seq, kind, data, ts) VALUES (?, ?, ?, ?, ?, ?)");
  for (let i = 1; i <= 4; i++) {
    add.run(`a${i}`, "a", i, i % 2 ? "user" : "assistant", JSON.stringify(i % 2 ? { text: `prompt ${i}` } : { blocks: [] }), i);
    if (i <= 3) add.run(`b${i}`, "b", i * 10, "user", JSON.stringify({ text: `prompt ${i}` }), i);
  }
  return db;
}
const tree = (dir: string) => {
  const db = new Database(join(dir, "keel.db"), { readonly: true });
  try {
    return {
      events: db.query("SELECT id, session_id, seq, parent FROM events ORDER BY session_id, seq").all() as { id: string; session_id: string; seq: number; parent: string | null }[],
      heads: db.query("SELECT id, head FROM sessions ORDER BY id").all(),
    };
  } finally { db.close(); }
};
const LINES = {
  events: [
    { id: "a1", session_id: "a", seq: 1, parent: null }, { id: "a2", session_id: "a", seq: 2, parent: "a1" }, { id: "a3", session_id: "a", seq: 3, parent: "a2" }, { id: "a4", session_id: "a", seq: 4, parent: "a3" },
    { id: "b1", session_id: "b", seq: 10, parent: null }, { id: "b2", session_id: "b", seq: 20, parent: "b1" }, { id: "b3", session_id: "b", seq: 30, parent: "b2" },
  ],
  heads: [{ id: "a", head: "a4" }, { id: "b", head: "b3" }],
};

test("the event tree migration that fails part way is done whole by the next start", () => {
  const dir = scratch();
  const db = beforeTheTree(dir);
  // The fault: the first statement after the columns are added fails.
  db.exec("CREATE TRIGGER fault BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'injected fault'); END");
  db.close();
  expect(() => new Store(dir)).toThrow("injected fault");

  const clear = new Database(join(dir, "keel.db"));
  clear.exec("DROP TRIGGER fault");
  clear.close();
  const store = new Store(dir);
  expect(tree(dir)).toEqual(LINES);
  expect(store.session("a")!.head).toBe("a4");
  expect(store.events("b").map((e) => [e.id, e.parent])).toEqual([["b1", null], ["b2", "b1"], ["b3", "b2"]]);
  store.db.close();

  // Another start changes nothing, also after the tree was used: a branch
  // off the middle of a session stays a branch.
  const again = new Store(dir);
  const fork = again.append("a", "user", { text: "edited" }, "a2");
  again.db.close();
  new Store(dir).db.close();
  expect(tree(dir)).toEqual({ events: [...LINES.events.slice(0, 4), { id: fork.id, session_id: "a", seq: 5, parent: "a2" }, ...LINES.events.slice(4)], heads: [{ id: "a", head: fork.id }, { id: "b", head: "b3" }] });
});

test("a database whose tree columns were added and not filled, or half filled, gets its lines", () => {
  const backfill = [
    "UPDATE events SET parent = (SELECT e2.id FROM events e2 WHERE e2.session_id = events.session_id AND e2.seq < events.seq ORDER BY e2.seq DESC LIMIT 1)",
    "UPDATE sessions SET head = (SELECT id FROM events WHERE session_id = sessions.id ORDER BY seq DESC LIMIT 1)",
  ];
  // An older start cut after the columns, after the parents, or (the other half alone) with only the heads.
  for (const done of [[], [backfill[0]!], [backfill[1]!]]) {
    const dir = scratch();
    const db = beforeTheTree(dir);
    db.exec("ALTER TABLE events ADD COLUMN parent TEXT; ALTER TABLE sessions ADD COLUMN head TEXT");
    for (const sql of done) db.exec(sql);
    db.close();
    new Store(dir).db.close();
    expect(tree(dir)).toEqual(LINES);
  }
});

test("a failure captured after the store closed is said on the console and throws nothing", async () => {
  const { ErrorTracker } = await import("./errors.ts");
  const { Bus } = await import("./bus.ts");
  const dir = mkdtempSync(join(tmpdir(), "keel-errors-"));
  const store = new Store(dir);
  const errors = new ErrorTracker(store, new Bus());
  expect(errors.capture("server", new Error("first")).id).not.toBe("");
  store.db.close();
  const said: string[] = [];
  const log = console.error;
  console.error = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    const rec = errors.capture("server", new Error("after the close"));
    // (Not stored: it is kept in memory under a name of its own, and shown from there.)
    expect([rec.id, rec.message, errors.unwritten().map((e) => e.message)]).toEqual(["unwritten-1", "after the close", ["after the close"]]);
  } finally {
    console.error = log;
    rmSync(dir, { recursive: true, force: true });
  }
  expect(said.join("\n")).toContain("after the close (not recorded:");
});

test("a version of a prompt appended while the session's events are out of the cache is among its versions", () => {
  const store = new Store(scratch());
  const s = store.createSession({ model: "m", workspace: "/" });
  const first = store.append(s.id, "user", { text: "first version" });
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: "reply" }] });
  expect(store.versions(s.id, null)).toEqual([]); // the only prompt under its parent: no other version
  // Other sessions are read meanwhile: this one's parsed events and branch leave their caches, its versions stay.
  for (let i = 0; i < 6; i++) {
    const other = store.createSession({ model: "m", workspace: "/" });
    store.append(other.id, "user", { text: "elsewhere" });
    store.events(other.id);
    store.lineage(other.id);
  }
  const second = store.append(s.id, "user", { text: "second version" }, null);
  expect(store.versions(s.id, null).map((e) => e.id)).toEqual([first.id, second.id]);
  store.db.close();
});

// An append changes more pages than SQLite keeps in memory for a statement's
// undo by default; in a file, each append would create, write and remove one.
test("a statement's undo pages are kept in memory, not in a temporary file", () => {
  const store = new Store(scratch());
  expect(store.db.query<{ temp_store: number }, []>("PRAGMA temp_store").get()!.temp_store).toBe(2);
  store.db.close();
});

// The connection keeps the pages working sessions write to in its own memory (16 MB), not SQLite's default of 2 MB.
test("the daemon's connection keeps 16 MB of pages", () => {
  const store = new Store(scratch());
  expect(store.db.query<{ cache_size: number }, []>("PRAGMA cache_size").get()!.cache_size).toBe(-16384);
  store.db.close();
});

// A session that is not in memory is read from the file. The read thread reads its pages first (what
// the daemon gives the store as `offLoop`), so the loop's own read finds them in memory and waits for no disk.
test("a session not in memory has its pages read off the loop before the loop reads it", async () => {
  const dir = scratch();
  const seed = new Store(dir);
  const s = seed.createSession({ model: "m", workspace: "/" });
  for (let i = 0; i < 40; i++) seed.append(s.id, "user", { text: "z".repeat(200), i });
  const store = new Store(dir);
  const asked: { sql: string; params: unknown[]; kept: number }[] = [];
  store.offLoop = async (sql, params) => { asked.push({ sql, params, kept: store.keptEvents().sessions }); };
  await store.warm(s.id);
  // Asked once, for this session, every row with its body, and before anything of it was in memory.
  expect(asked).toHaveLength(1);
  expect(asked[0]!.params).toEqual([s.id]);
  expect(asked[0]!.sql).toContain("LENGTH(data)");
  expect(asked[0]!.kept).toBe(0);
  expect(store.keptEvents().sessions).toBe(1);
  expect(store.events(s.id)).toHaveLength(40);
  // In memory now: nothing is asked again.
  await store.warm(s.id);
  await store.warm(s.id, false);
  expect(asked).toHaveLength(1);
  // A read thread that fails does not stop the session from being read.
  const other = new Store(dir);
  other.offLoop = async () => { throw new Error("no read thread"); };
  await other.warm(s.id);
  expect(other.events(s.id)).toHaveLength(40);
});

// A turn reads its context: the events after the last checkpoint. Their
// bodies alone are brought in, in slices, and a later read of that part reads
// nothing more.
test("the bodies from an event on are read in slices, and no body before it", async () => {
  const dir = scratch();
  const seed = new Store(dir);
  const s = seed.createSession({ model: "m", workspace: "/" });
  for (let i = 0; i < 1000; i++) seed.append(s.id, "user", { text: "z".repeat(2000), i });
  const store = new Store(dir);
  await store.warm(s.id, false);
  const bare = store.keptEvents().bytes;
  const all = store.events(s.id);
  await store.warm(s.id, true, all[900]!.seq);
  const part = store.keptEvents().bytes - bare;
  // A tenth of the bodies, to the run (64 events) the first one lies in.
  expect(part).toBeGreaterThan(100 * 2000 * 2);
  expect(part).toBeLessThan(170 * 2000 * 3);
  // Reading that part reads nothing more; an event before it reads its own run.
  expect(all.slice(900).every((e) => (e.data as { i: number }).i >= 900)).toBe(true);
  expect(store.keptEvents().bytes - bare).toBe(part);
  expect((all[10]!.data as { i: number }).i).toBe(10);
  expect(store.keptEvents().bytes - bare).toBeGreaterThan(part);
});

// An append does nothing that grows with the session: the branch it ends is
// not copied for it (the events appended join the branch when it is next
// read), and every event as one list is made once for the readers between two
// appends. What a reader holds stays as it was read.
test("an append costs the same in a long session as in a new one, and what a reader holds stays as it was", () => {
  const store = new Store(scratch());
  const fill = (n: number) => {
    const s = store.createSession({ model: "m", workspace: "/" });
    store.db.transaction(() => { for (let i = 0; i < n; i++) store.append(s.id, i % 2 ? "assistant" : "user", i % 2 ? { blocks: [] } : { text: `prompt ${i}` }); })();
    return s.id;
  };
  const longId = fill(50_000);
  const shortId = fill(10);

  // The branch and the whole, held across appends: neither changes under its reader.
  const line = store.lineage(longId);
  const whole = store.events(longId);
  const last = line.at(-1)!.id;
  expect(store.events(longId)).toBe(whole);
  const added = [store.append(longId, "note", { text: "one" }), store.append(longId, "note", { text: "two" })];
  expect(line.length).toBe(50_000);
  expect(line.at(-1)!.id).toBe(last);
  expect(whole.length).toBe(50_000);
  const next = store.lineage(longId);
  expect(next.length).toBe(50_002);
  expect(next.slice(-2).map((e) => e.id)).toEqual(added.map((e) => e.id));
  expect(next.slice(0, 50_000).every((e, i) => e === line[i])).toBe(true);
  expect(store.lineage(longId)).toBe(next);
  expect(store.events(longId).length).toBe(50_002);
  // An edited prompt (another parent) shows another branch: walked again, the one held unchanged.
  const edit = store.append(longId, "user", { text: "edited" }, line[9]!.id);
  expect(store.lineage(longId).map((e) => e.id)).toEqual([...line.slice(0, 10).map((e) => e.id), edit.id]);
  expect(next.length).toBe(50_002);

  // 1,000 appends at a time, the two sessions taking turns: the least of five rounds each.
  const time = (id: string) => {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) store.append(id, "note", { text: "y".repeat(200) });
    return performance.now() - t0;
  };
  store.lineage(longId);
  store.lineage(shortId);
  let long = Infinity, short = Infinity;
  for (let round = 0; round < 5; round++) { short = Math.min(short, time(shortId)); long = Math.min(long, time(longId)); }
  // (With a copy of the branch at each append the long session took three times the new one's time.)
  expect(long).toBeLessThan(short * 1.8 + 5);
  expect(store.lineage(longId).length).toBe(11 + 5000);
});

// A reader of how a branch ends walks it from the head back, and a reader
// that looks for something among the events of one kind takes them newest
// first. Both give what the whole session gives, whether the session is in
// memory or not, and for one that is not they bring nothing in: only as far
// as the reader goes is read.
test("a walk back from the head and a look over one kind give the session's own events without bringing it in", () => {
  const dir = scratch();
  const { id, fork } = long(new Store(dir), 3000);
  const whole = new Store(dir);
  const line = [...whole.lineage(id)].reverse();
  const users = whole.events(id).filter((e) => e.kind === "user").reverse();
  const brief = (e: { id: string; seq: number; parent: string | null; kind: string; ts: number; data: unknown }) => ({ id: e.id, seq: e.seq, parent: e.parent, kind: e.kind, ts: e.ts, data: e.data });
  expect(line.length).toBe(1505);
  expect(line.some((e) => e.id === fork)).toBe(true);
  // In memory: the kept branch, the same events.
  expect([...whole.back(id)].map(brief)).toEqual(line.map(brief));
  expect([...whole.newest(id, "user")].map(brief)).toEqual(users.map(brief));
  // Not in memory: the same events, a few read, nothing kept, no whole read counted.
  const cold = new Store(dir);
  cold.serving = true;
  const bodies = spyOn(JSON, "parse");
  const tail: { id: string; kind: string; data: unknown }[] = [];
  for (const e of cold.back(id)) { tail.push({ id: e.id, kind: e.kind, data: e.kind === "user" ? e.data : null }); if (tail.length === 40) break; }
  // (Only the bodies asked for were parsed.)
  expect(bodies.mock.calls.length).toBe(tail.filter((e) => e.kind === "user").length);
  bodies.mockRestore();
  expect(tail.map((e) => e.id)).toEqual(line.slice(0, 40).map((e) => e.id));
  expect(tail.filter((e) => e.kind === "user").map((e) => e.data)).toEqual(line.slice(0, 40).filter((e) => e.kind === "user").map((e) => e.data));
  const few: string[] = [];
  for (const e of cold.newest(id, "user")) { few.push(e.id); if (few.length === 50) break; }
  expect(few).toEqual(users.slice(0, 50).map((e) => e.id));
  const since = users[9]!.ts;
  expect([...cold.newest(id, "user", since)].map(brief)).toEqual(users.filter((e) => e.ts >= since).map(brief));
  expect(cold.isKept(id)).toBe(false);
  expect(cold.coldReads().n).toBe(0);
  // A walk past the branch's fork (its first half lies under 1,500 newer events of another branch) is still the branch.
  expect([...cold.back(id)].map((e) => e.id)).toEqual(line.map((e) => e.id));
  expect(cold.isKept(id)).toBe(false);
  // One that goes very far has the session brought in after all, and is counted as that.
  const far = long(new Store(dir), 9000);
  const farLine = [...new Store(dir).lineage(far.id)].reverse().map((e) => e.id);
  const again = new Store(dir);
  again.serving = true;
  expect([...again.back(far.id)].map((e) => e.id)).toEqual(farLine);
  expect(again.isKept(far.id)).toBe(true);
  expect(again.coldReads().n).toBe(1);
});

test("under memory pressure the store gives back the kept events beyond a share of its budget, idle sessions first", () => {
  const dir = scratch();
  const seed = new Store(dir);
  const text = "x".repeat(1000);
  const make = (phase?: "working") => {
    const s = seed.createSession({ model: "m", workspace: "/" });
    seed.db.transaction(() => { for (let i = 0; i < 320; i++) seed.append(s.id, "user", { text, i }); })();
    if (phase) seed.updateSession(s.id, { phase });
    return s.id;
  };
  const [idle, working] = [make(), make("working")];
  const kept = process.env.KEEL_EVENTS_MEMORY_MB;
  process.env.KEEL_EVENTS_MEMORY_MB = "4";
  let store: Store;
  try { store = new Store(dir); } finally { if (kept === undefined) delete process.env.KEEL_EVENTS_MEMORY_MB; else process.env.KEEL_EVENTS_MEMORY_MB = kept; }
  // Both sessions with every body: about 1.9 MB charged, within the budget of 4.
  for (const id of [idle, working]) for (const e of store.lineage(id)) void e.data;
  const before = store.keptEvents();
  expect(before.bytes).toBeGreaterThan(1.8e6);
  expect(before.bytes).toBeLessThan(before.budget);
  // Pressure: a quarter of the budget is all that may stay. The idle session's bodies and rows go, then bodies of the working one.
  const gave = store.giveBack(0.25);
  const after = store.keptEvents();
  expect(gave).toBe(before.bytes - after.bytes);
  expect(after.bytes).toBeLessThanOrEqual(0.25 * after.budget);
  expect(after.budget).toBe(before.budget);
  expect([...((store as any).kept as Map<string, unknown>).keys()]).toEqual([working]);
  // What went is read again from the table when asked for.
  expect(store.lineage(idle).map((e) => (e.data as { i: number }).i).length).toBe(320);
  // Nothing beyond the share: nothing to give.
  expect(store.giveBack(1)).toBe(0);
  store.shrink();
});

// A session at rest gives its event bodies back. What reads them again reads
// a run of 64 from the table, on the loop: counted with who asked, and not
// needed at all by a reader that has them read off the loop first.
test("bodies read on the loop are counted by who asked; warmed off the loop, a turn's start reads none", async () => {
  const dir = scratch();
  const seed = new Store(dir);
  const s = seed.createSession({ model: "m", workspace: "/" });
  for (let i = 0; i < 300; i++) seed.append(s.id, i % 2 ? "assistant" : "user", { text: `body ${i}`, i });
  const store = new Store(dir);
  store.serving = true;
  const rest = () => { for (const k of ((store as any).kept as Map<string, { at: number }>).values()) k.at -= IDLE_KEPT_MS; (store as any).sweep(); };
  const loop = () => store.bodyReads();
  await store.warm(s.id, false);
  expect(loop()).toMatchObject({ n: 0, rows: 0, off: 0 });
  // Read through the events, on the loop: one run for the last event, counted under a label of the path that asked.
  const reader = function turnStart() { return store.lineage(s.id).at(-1)!.data.i; };
  expect(reader()).toBe(299);
  expect(loop()).toMatchObject({ n: 1, rows: 300 - 256, off: 0 });
  expect(loop().by).toHaveLength(1);
  expect(loop().by[0]).toMatchObject({ n: 1, rows: 44 });
  expect(loop().by[0]!.who).toContain("turnStart");
  expect(loop().by[0]!.bytes).toBeGreaterThan(44 * 20);
  expect(store.keptEvents().body_reads.n).toBe(1);
  // At rest the bodies go. Warmed through the read thread, the part asked for is in memory and the loop read nothing.
  rest();
  const asked: unknown[][] = [];
  const other = new Database(join(dir, "keel.db"), { readonly: true });
  store.readOff = async (sql, params) => { asked.push(params); return other.query<{ data: string }, any[]>(sql).all(...params); };
  const line = store.lineage(s.id);
  await store.warmBodies(s.id, line[100]!.seq);
  expect(asked.map((p) => [p[1], p[2]])).toEqual([[65, 128], [129, 192], [193, 256], [257, 300]]);
  expect(line.slice(100).map((e) => e.data.i)).toEqual(Array.from({ length: 200 }, (_, i) => 100 + i));
  expect(loop()).toMatchObject({ n: 1, off: 4 });
  // Asked again, nothing is read; one part only, only its run.
  await store.warmBodies(s.id, line[100]!.seq);
  await store.warmBodies(s.id, line[10]!.seq, line[20]!.seq);
  expect(asked).toHaveLength(5);
  expect(asked[4]!.slice(1)).toEqual([1, 64]);
  expect(loop()).toMatchObject({ n: 1, off: 5 });
  // An event stored while its run is not in memory keeps its own body: the prompt after a rest, its
  // turn's first events and their reader read nothing back. Its run, read later, holds it too.
  rest();
  const prompt = store.append(s.id, "user", { text: "after the rest", i: 300 });
  const start = store.append(s.id, "turn_start", { model: "m" });
  expect([store.lineage(s.id).at(-2)!.data.text, store.lineage(s.id).at(-1)!.data.model, prompt.data.i, start.data.model]).toEqual(["after the rest", "m", 300, "m"]);
  expect(loop()).toMatchObject({ n: 1, off: 5 });
  // One body by itself is one row, not a run (the last turn's end, asked at every prompt).
  expect(store.body(line[5]!)).toEqual({ text: "body 5", i: 5 });
  expect(loop()).toMatchObject({ n: 1, off: 5 });
  await store.warmBodies(s.id, prompt.seq);
  expect(store.lineage(s.id).slice(-3).map((e) => e.data.i ?? e.data.model)).toEqual([299, 300, "m"]);
  expect((store as any).kept.get(s.id).fresh).toBeUndefined();
  // No read thread, or one that does not answer: the runs are read here, and counted.
  rest();
  store.readOff = async () => undefined;
  await store.warmBodies(s.id, line[280]!.seq);
  expect(loop().n).toBe(2);
  expect(line.at(-1)!.data.i).toBe(299);
  // A run that grew meanwhile is read again as it is now, still off the loop.
  rest();
  let retried = 0;
  store.readOff = async (sql, params) => {
    const rows = other.query<{ data: string }, any[]>(sql).all(...params);
    if (++retried === 1) store.append(s.id, "note", { text: "meanwhile" });
    return rows;
  };
  await store.warmBodies(s.id, line[280]!.seq);
  expect(retried).toBe(2);
  expect(loop().n).toBe(2);
  expect(store.lineage(s.id).at(-1)!.data.text).toBe("meanwhile");
  expect(store.lineage(s.id).slice(-4, -1).map((e) => e.data.i ?? e.data.model)).toEqual([299, 300, "m"]);
  other.close();
  store.db.close();
});

// A session not in memory is brought in with its rows read on the read thread
// and handed over: the loop reads only what was stored meanwhile.
test("a session's rows come from the read thread, and what was stored meanwhile from the table", async () => {
  const dir = scratch();
  const seed = new Store(dir);
  const s = seed.createSession({ model: "m", workspace: "/" });
  seed.db.transaction(() => { for (let i = 0; i < 9000; i++) seed.append(s.id, "user", { text: "t", i }); })();
  const store = new Store(dir);
  const other = new Database(join(dir, "keel.db"), { readonly: true });
  const asked: string[] = [];
  let late: string | undefined;
  store.readOff = async (sql, params) => {
    asked.push(sql.includes("SELECT data") ? "bodies" : "rows");
    const rows = other.query<any, any[]>(sql).all(...params);
    // An event stored while the thread's last part was on its way.
    if (asked.length === 3 && !late) late = store.append(s.id, "note", { text: "meanwhile" }).id;
    return rows;
  };
  const { reads, stop } = tableReads(store);
  try {
    await store.warm(s.id, false);
    // Three parts from the thread (4,096, 4,096, 808), then one look at the table for what came since.
    expect(asked).toEqual(["rows", "rows", "rows"]);
    expect(reads).toHaveLength(1);
    const all = store.events(s.id);
    expect(all).toHaveLength(9001);
    expect(all.at(-1)!.id).toBe(late!);
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: 9001 }, (_, i) => i + 1));
    expect(store.coldReads().n).toBe(0);
    // With its bodies: every run from the thread, none read here.
    asked.length = 0;
    await store.warm(s.id);
    expect(asked.every((a) => a === "bodies")).toBe(true);
    expect(asked.length).toBe(Math.ceil(9001 / 64));
    expect(store.bodyReads()).toMatchObject({ n: 0, off: asked.length });
    expect(all[4500]!.data.i).toBe(4500);
    expect(reads).toHaveLength(1);
  } finally { stop(); }
  // No thread: the rows are read here, a part at a time, as before.
  const plain = new Store(dir);
  plain.readOff = async () => undefined;
  await plain.warm(s.id, false);
  expect(plain.events(s.id)).toHaveLength(9001);
  other.close();
});

test("a prompt stored under a rewind's notes is a version of the prompt it replaced", () => {
  const store = new Store(scratch());
  const s = store.createSession({ model: "m", workspace: "/" });
  const first = store.append(s.id, "user", { text: "first" });
  const end = store.append(s.id, "turn_end", {});
  const old = store.append(s.id, "user", { text: "second" });
  store.append(s.id, "turn_end", {});
  expect(store.versions(s.id, end.id)).toEqual([]);
  // The rewind: the head goes back, two notes are stored under it, then the new prompt.
  store.updateSession(s.id, { head: end.id });
  store.append(s.id, "note", { kind: "rewind", model: true });
  store.append(s.id, "note", { kind: "rewound" });
  const fresh = store.append(s.id, "user", { text: "second again" });
  expect(store.versions(s.id, end.id).map((e) => e.id)).toEqual([old.id, fresh.id]);
  expect(first.id).toBeDefined();
});
