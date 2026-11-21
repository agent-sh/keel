// What the store reads for a question, which no page can see: how many event
// bodies a cursor read parses, and how it finds its place in a session in memory.
import { Database } from "bun:sqlite";
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
  const kept = (cold as any).kept.get(id);
  kept.all = new Proxy(kept.all, { get: (t, k, r) => { if (typeof k === "string" && /^\d+$/.test(k)) looked++; return Reflect.get(t, k, r); } });
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

test("a step of a working session parses nothing again, however many other sessions work", () => {
  const store = new Store(scratch());
  // Twelve sessions with a history, each in a turn.
  const ids = Array.from({ length: 12 }, () => long(store, 200).id);
  for (const id of ids) store.updateSession(id, { phase: "working" });
  for (const id of ids) store.lineage(id);
  const parse = spyOn(JSON, "parse");
  const reads: string[] = [];
  const db = store.db as any;
  const real = db.query.bind(db);
  db.query = (sql: string) => { if (/FROM events WHERE session_id = \? (ORDER|AND seq)/.test(sql)) reads.push(sql); return real(sql); };
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
    // Nothing of a session was read from the table, and only the appended events were parsed (their own round trip).
    expect(reads).toEqual([]);
    expect(parse).toHaveBeenCalledTimes(3 * 12 * 2);
  } finally {
    db.query = real;
    parse.mockRestore();
  }
  expect(store.keptEvents().sessions).toBe(12);
  // What is held is what the table holds.
  const cold = new Store(store.stateDir);
  for (const id of ids) expect(store.lineage(id)).toEqual(cold.lineage(id));
});

test("kept events are bounded by their bytes, and idle sessions go first", () => {
  const dir = scratch();
  const seed = new Store(dir);
  const text = "x".repeat(1000);
  const make = () => {
    const s = seed.createSession({ model: "m", workspace: "/" });
    for (let i = 0; i < 300; i++) seed.append(s.id, "user", { text });
    return s.id;
  };
  const [a, w, b, c] = [make(), make(), make(), make()];
  seed.updateSession(w, { phase: "working" });
  // Room for two of the four (each is a little over 300 kB of stored events).
  const kept = process.env.KEEL_EVENTS_MEMORY_MB;
  process.env.KEEL_EVENTS_MEMORY_MB = "0.7";
  let store: Store;
  try { store = new Store(dir); } finally { if (kept === undefined) delete process.env.KEEL_EVENTS_MEMORY_MB; else process.env.KEEL_EVENTS_MEMORY_MB = kept; }
  const held = () => [...((store as any).kept as Map<string, unknown>).keys()];
  store.lineage(w);
  store.lineage(a);
  expect(held()).toEqual([w, a]);
  // A third does not fit: the idle one goes, though the working one was read before it.
  store.lineage(b);
  expect(held()).toEqual([w, b]);
  store.lineage(c);
  expect(held()).toEqual([w, c]);
  expect(store.keptEvents().bytes).toBeLessThanOrEqual(store.keptEvents().budget);
  // An append counts: the working session grows past the budget with the idle one, which goes.
  for (let i = 0; i < 100; i++) store.append(w, "user", { text });
  expect(held()).toEqual([w]);
  expect(store.lineage(w).length).toBe(400);
  // Only working sessions left and over the budget: the one in hand stays, the other goes.
  store.updateSession(a, { phase: "working" });
  store.lineage(a);
  expect(held()).toEqual([a]);
  // A deleted session is not kept.
  store.deleteSession(a);
  expect(store.keptEvents()).toEqual({ sessions: 0, bytes: 0, budget: 0.7e6 });
  // What was dropped reads the same again.
  expect(store.lineage(c).length).toBe(300);
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
    expect([rec.id, rec.message]).toEqual(["", "after the close"]);
  } finally {
    console.error = log;
    rmSync(dir, { recursive: true, force: true });
  }
  expect(said.join("\n")).toContain("after the close (not recorded:");
});
