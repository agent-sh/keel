// The search index's own bookkeeping, which the e2e cannot see: how an
// event's rows leave the index, what a start does to an index it finds, and
// how an index of the layout before is replaced.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import { searchRoutes } from "./search.ts";
import { fill, startFill } from "./search-fill.ts";
import { dropStep, fillStep, initSearchIndex, keepIndexed, searchMeta, searchTable, WRITES, writeOld } from "./search-index.ts";
import { searchContent } from "./search-content.ts";
import { ftsQuery } from "./search.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function open(dir?: string) {
  if (!dir) dirs.push((dir = mkdtempSync(join(tmpdir(), "keel-search-"))));
  const store = new Store(dir);
  const start = () => searchRoutes({ store } as any)["/api/search"].GET as (req: Request) => Promise<Response>;
  const hits = async (get: (req: Request) => Promise<Response>, q: string): Promise<any[]> =>
    (await (await get(new Request(`http://keel/api/search?q=${encodeURIComponent(q)}&limit=100`))).json()).hits.filter((h: any) => h.kind !== "title");
  return { dir, store, start, hits };
}

// A session with six rows: a prompt, a reply's text, two tool calls of that
// reply and their two outputs.
function talk(store: Store, word: string) {
  const s = store.createSession({ model: "m", workspace: "/" });
  store.append(s.id, "user", { text: `find the ${word} ledger` });
  store.append(s.id, "assistant", { blocks: [
    { type: "text", text: `looking for ${word}` },
    { type: "tool_use", id: "c1", name: "Bash", input: { command: `grep ${word} a.txt` } },
    { type: "tool_use", id: "c2", name: "Bash", input: { command: `grep ${word} b.txt` } },
  ] });
  store.append(s.id, "tool_result", { results: [{ tool_use_id: "c1", content: `a.txt: ${word}` }, { tool_use_id: "c2", content: [{ type: "text", text: `b.txt: ${word} ${word}` }] }] });
  return s.id;
}

const filler = (store: Store, n: number) => {
  const s = store.createSession({ model: "m", workspace: "/" });
  for (let i = 0; i < n; i++) store.append(s.id, "user", { text: `unrelated filler line ${i}` });
};

// What a hit is, without its time: the same for the same row of any index.
const shape = (h: any) => `${h.session_id}:${h.event_id}:${h.kind}:${h.ref ?? ""}:${h.partial ? 1 : 0}:${h.snippet}`;
// The index holds what the events say, word by word. FTS5's own check against its content and its
// 'rebuild' cannot read this index's view (search-index.ts), and its plain integrity-check checks
// the index only against itself: here a plain FTS5 table of the same columns is made from the view's text and the two
// are compared, every word of every row at its place, and each row's count of words.
function intact(store: Store) {
  const db = store.db;
  store.side.flush();
  db.run("INSERT INTO search_words (search_words) VALUES ('integrity-check')");
  db.exec(`CREATE VIRTUAL TABLE temp.plain USING fts5(text, event_id UNINDEXED, session_id UNINDEXED, kind UNINDEXED, ts UNINDEXED, ref UNINDEXED, cut UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
    INSERT INTO temp.plain (rowid, text) SELECT doc, text FROM search_text;
    CREATE VIRTUAL TABLE temp.v_words USING fts5vocab(main, search_words, instance);
    CREATE VIRTUAL TABLE temp.v_ref USING fts5vocab(temp, plain, instance);`);
  const differ = (a: string, b: string) => {
    const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM ${a} EXCEPT SELECT * FROM ${b}`).all();
    if (rows.length && process.env.KEEL_TRACE_INTACT) console.log(a, "not in", b, rows.slice(0, 4));
    return rows.length;
  };
  const words = "(SELECT term, doc, col, offset FROM temp.v_words)", ref = "(SELECT term, doc, col, offset FROM temp.v_ref)";
  expect([differ(words, ref), differ(ref, words)]).toEqual([0, 0]);
  const sizes = "(SELECT id, sz FROM main.search_words_docsize)", refSizes = "(SELECT id, sz FROM temp.plain_docsize)";
  expect([differ(sizes, refSizes), differ(refSizes, sizes)]).toEqual([0, 0]);
  expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM temp.v_ref").get()!.n).toBeGreaterThan(0);
  for (const t of ["v_words", "v_ref", "plain"]) db.run(`DROP TABLE temp.${t}`);
}
// How many rows the index itself holds (its own count of each row's words; a count over the table would read the view).
const indexed = (db: Database) => db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_words_docsize").get()!.n;

// The plan of every statement a delete trigger of the index runs.
function deletePlans(store: Store): string[] {
  const out: string[] = [];
  const triggers = store.db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'search_%' AND sql LIKE '% DELETE ON %'").all();
  for (const { sql } of triggers) {
    const body = sql.slice(sql.indexOf("BEGIN") + 5, sql.lastIndexOf("END"));
    for (const st of body.split(";").map((x) => x.trim()).filter(Boolean)) {
      // Finalized: the plan of a DELETE read with all() stays open and holds the next commit.
      const plan = store.db.prepare<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${st.replace(/OLD\.\w+/g, "1")}`);
      for (const r of plan.all()) out.push(r.detail);
      plan.finalize();
    }
  }
  return out;
}

test("the index holds no copy of the text, and an event's rows leave it by their numbers", async () => {
  const { store, start, hits } = open();
  const get = start();
  // No table of the index holds text: the words are read from the events.
  const tables = store.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'search%'").all().map((t) => t.name);
  expect(tables.filter((t) => t.endsWith("_content"))).toEqual([]);
  // Removing an event's rows reads its rows by a range of numbers and its event by its row number, never a whole table.
  const plans = deletePlans(store);
  expect(plans.length).toBeGreaterThan(0);
  // (A scan is of a JSON function over the one event's body, never of a table.)
  for (const p of plans.filter((x) => /^(SCAN|SEARCH) /.test(x))) expect(p).toMatch(/^SEARCH \w+ USING INTEGER PRIMARY KEY \(rowid|^SCAN \w+ VIRTUAL TABLE INDEX \d+:$/);
  expect(plans.filter((p) => p.startsWith("SEARCH")).length).toBe(3);

  const removed: number[] = [];
  const kept = talk(store, "quokka");
  for (const n of [20, 180]) {
    filler(store, n);
    const gone = talk(store, "quokka");
    const order = (await hits(get, "quokka")).filter((h) => h.session_id === kept).map(shape);
    expect(order.length).toBe(6);
    expect((await hits(get, "quokka")).filter((h) => h.session_id === gone).length).toBe(6);
    const before = indexed(store.db);
    store.deleteSession(gone);
    removed.push(before - indexed(store.db));
    // Every row of the deleted session is gone, its words with it; the other session's hits and their order stay.
    const after = await hits(get, "quokka");
    expect(after.filter((h) => h.session_id === gone)).toEqual([]);
    expect(after.filter((h) => h.session_id === kept).map(shape)).toEqual(order);
    intact(store);
  }
  expect(removed).toEqual([6, 6]);
  expect(store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_rows").get()!.n).toBe(indexed(store.db));
  // A hit says what it is as before: its kind, the call it belongs to, its snippet.
  const got = (await hits(get, "quokka")).map((h) => `${h.kind}:${h.ref ?? ""}`).sort();
  expect(got).toEqual(["assistant:", "tool_result:c1", "tool_result:c2", "tool_use:c1", "tool_use:c2", "user:"]);
  expect((await hits(get, "ledger"))[0].snippet).toBe("find the quokka \u0001ledger\u0002");
});

test("an event's rows are made from that event alone, and a fill's from its range of row numbers", () => {
  const { store, start } = open();
  start();
  for (const [name, list] of Object.entries(WRITES)) for (const sql of list) {
    const plan = store.db.query<{ detail: string }, number[]>(`EXPLAIN QUERY PLAN ${sql.slice(sql.indexOf("SELECT"))}`).all(...(name === "ONE" ? [1] : [1, 2])).map((p) => p.detail);
    expect(plan[0]).toMatch(name === "ONE" ? /^SEARCH e USING INTEGER PRIMARY KEY \(rowid=\?\)$/ : /^SEARCH e USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)$/);
    for (const p of plan.filter((x) => /^(SCAN|SEARCH) /.test(x)).slice(1)) expect(p).toMatch(/^SEARCH r USING INTEGER PRIMARY KEY \(rowid=\?\)$|^SCAN \w+ VIRTUAL TABLE INDEX \d+:$/);
  }
});

test("a step of the fill takes the events' bodies up to its bytes, and one at least", () => {
  const { store } = open();
  const s = store.createSession({ model: "m", workspace: "/" });
  for (let i = 0; i < 10; i++) store.append(s.id, "user", { text: `short ${i}` });
  store.append(s.id, "tool_result", { results: [{ tool_use_id: "c", content: "long ".repeat(20_000) }] });
  for (let i = 0; i < 10; i++) store.append(s.id, "user", { text: `after ${i}` });
  initSearchIndex(store.db);
  const size = store.db.query<{ n: number }, []>("SELECT octet_length(data) AS n FROM events WHERE kind = 'user' LIMIT 1").get()!.n;
  // Three short prompts' worth: three of them (the newest first).
  expect(fillStep(store.db, 3 * size).events).toBe(3);
  // A step that reaches the long output stops before it, and the next takes it alone.
  expect(fillStep(store.db, 100 * size).events).toBe(7);
  expect(fillStep(store.db, size).events).toBe(1);
  expect(fillStep(store.db, 1_000_000).events).toBe(10);
  expect(searchMeta(store.db)?.fill_below).toBeNull();
  intact(store);
});

// A step reads the lengths of as many events as its bytes can hold, not of five thousand: on a store
// of large tool outputs that read made every step cost the same, and steps of a few events each.
test("a step of the fill looks at no more events than its bytes can hold", () => {
  const { store } = open();
  const s = store.createSession({ model: "m", workspace: "/" });
  for (let i = 0; i < 300; i++) store.append(s.id, "user", { text: `p${i}` });
  initSearchIndex(store.db);
  expect(fillStep(store.db, 4096).events).toBe(64);
  expect(fillStep(store.db, 1_000_000).events).toBe(236);
  intact(store);
});

// The layout before (version 4): every row's text in the index, mapped to its event by search_docs.
const V4 = `
DROP TABLE IF EXISTS search_meta;
CREATE TABLE search_meta (version INTEGER NOT NULL, upto INTEGER);
CREATE VIRTUAL TABLE search_idx USING fts5(text, event_id UNINDEXED, session_id UNINDEXED, kind UNINDEXED, ts UNINDEXED, ref UNINDEXED, cut UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE search_docs (event_id TEXT NOT NULL, doc INTEGER NOT NULL, PRIMARY KEY (event_id, doc)) WITHOUT ROWID;
CREATE VIEW search_in AS SELECT NULL AS text, NULL AS event_id, NULL AS session_id, NULL AS kind, NULL AS ts, NULL AS ref, NULL AS cut;
CREATE TRIGGER search_in_ins INSTEAD OF INSERT ON search_in BEGIN
  INSERT INTO search_idx (text, event_id, session_id, kind, ts, ref, cut) VALUES (NEW.text, NEW.event_id, NEW.session_id, NEW.kind, NEW.ts, NEW.ref, NEW.cut);
  INSERT INTO search_docs (event_id, doc) VALUES (NEW.event_id, last_insert_rowid());
END;
CREATE TRIGGER search_docs_del AFTER DELETE ON search_docs BEGIN DELETE FROM search_idx WHERE rowid = OLD.doc; END;
CREATE TRIGGER search_idx_del AFTER DELETE ON events WHEN OLD.kind IN ('user', 'assistant', 'tool_result', 'compaction', 'note') BEGIN
  DELETE FROM search_docs WHERE event_id = OLD.id;
END;`;
// A store as a build of that layout leaves it: its index whole, version 4 recorded, nothing of this layout.
function asV4(store: Store) {
  const db = store.db;
  for (const t of ["search_rows_del", "search_add_ins"]) db.exec(`DROP TRIGGER IF EXISTS ${t}`);
  db.exec("DROP VIEW IF EXISTS search_add; DROP TABLE IF EXISTS search_words; DROP VIEW IF EXISTS search_text; DROP TABLE IF EXISTS search_rows;");
  db.exec(V4);
  for (const e of db.query<{ rowid: number; kind: string }, []>("SELECT rowid, kind FROM events ORDER BY rowid").all()) writeOld(db, e.rowid, e.kind);
  db.run("INSERT INTO search_meta (version, upto) VALUES (4, (SELECT MAX(rowid) FROM events))");
}

test("an index of the layout before is read until the new one is whole, kept current meanwhile, then dropped", async () => {
  const first = open();
  first.start();
  const a = talk(first.store, "wombat");
  filler(first.store, 30);
  const b = talk(first.store, "wombat");
  first.store.side.flush();
  asV4(first.store);
  first.store.db.close();

  // A start makes the new index empty and leaves its fill to the thread: searches read the old one.
  const next = open(first.dir);
  const db = next.store.db;
  expect(initSearchIndex(db)).toEqual({ fill: true, drain: false });
  keepIndexed(next.store);
  expect(searchTable(db)).toBe("search_idx");
  // (Read as the route reads, without the route's start, which would fill the index at once here.)
  const find = (w: string) => { next.store.side.flush(); return searchContent(db, { match: ftsQuery(w)!, where: "", args: [], limit: 100, perSession: false, pid: "NULL" }).map((h) => ({ ...h, partial: !!h.cut })); };
  const was = find("wombat").map(shape);
  expect(was.length).toBe(12);
  // What is stored and deleted meanwhile reaches both.
  const c = talk(next.store, "wombat");
  next.store.deleteSession(a);
  const now = find("wombat").map((h) => h.session_id);
  expect(now.filter((s) => s === c).length).toBe(6);
  expect(now.filter((s) => s === a)).toEqual([]);
  // Part of the fill (the newest event alone): still the old index, whole.
  expect(fillStep(db, 1).events).toBe(1);
  expect(searchTable(db)).toBe("search_idx");
  expect(find("wombat").length).toBe(12);
  // The rest: the new one is read, with the same hits, and the old one is dropped.
  for (let i = 0; i < 1000 && searchMeta(db)?.fill_below !== null; i++) fillStep(db, 2000);
  expect(searchTable(db)).toBe("search_words");
  const after = find("wombat");
  expect(after.map((h) => h.session_id).sort()).toEqual([...Array(6).fill(b), ...Array(6).fill(c)].sort());
  expect(after.filter((h) => h.session_id === b).map(shape).sort()).toEqual(was.filter((h) => h.startsWith(b)).sort());
  intact(next.store);
  // The old index is removed in steps of so many rows, then its tables go.
  expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('search_in')").all()).toEqual([]);
  const oldRows = () => db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_idx").get()!.n;
  const had = oldRows();
  expect(dropStep(db, 5)).toMatchObject({ rows: 5, left: true });
  expect(oldRows()).toBe(had - 5);
  expect(find("wombat").length).toBe(12);
  startFill(next.store, { oldGone: () => {}, thread: false });
  expect(db.query("SELECT name FROM sqlite_master WHERE name IN ('search_idx', 'search_docs', 'search_in')").all()).toEqual([]);
  // A later event goes to the new index alone.
  const d = talk(next.store, "wombat");
  expect(find("wombat").filter((h) => h.session_id === d).length).toBe(6);
  intact(next.store);
  next.store.db.close();
});

test("the fill thread fills a store's index off the loop and drops the old one", async () => {
  const first = open();
  first.start();
  const s = talk(first.store, "numbat");
  filler(first.store, 400);
  first.store.side.flush();
  asV4(first.store);
  first.store.db.close();
  const next = open(first.dir);
  initSearchIndex(next.store.db);
  const kept = keepIndexed(next.store);
  await new Promise<void>((ok) => startFill(next.store, { oldGone: kept.oldGone, thread: true, done: ok }));
  expect(fill.done).toBe(true);
  expect(fill.filled).toBeGreaterThan(400);
  expect(searchTable(next.store.db)).toBe("search_words");
  expect(next.store.db.query("SELECT name FROM sqlite_master WHERE name IN ('search_idx', 'search_docs')").all()).toEqual([]);
  const get = searchRoutes({ store: next.store } as any)["/api/search"].GET as (req: Request) => Promise<Response>;
  expect((await next.hits(get, "numbat")).map((h) => h.session_id)).toEqual(Array(6).fill(s));
  // (The rows that hold both words; the ones with "filler" alone follow them.)
  expect((await next.hits(get, "filler 399")).filter((h) => !h.missing).length).toBe(1);
  intact(next.store);
  next.store.db.close();
});

// Every statement a start runs on the database.
function record(store: Store): string[] {
  const seen: string[] = [];
  const db = store.db as any;
  for (const m of ["query", "prepare", "run", "exec"]) {
    const real = db[m].bind(db);
    db[m] = (sql: string, ...rest: unknown[]) => { seen.push(sql); return real(sql, ...rest); };
  }
  return seen;
}
const version = (store: Store) =>
  store.db.query("SELECT 1 FROM sqlite_master WHERE name = 'search_meta'").get() ? store.db.query<{ version: number }, []>("SELECT version FROM search_meta").get()?.version : undefined;

test("the first start and an older layout index what was stored before", async () => {
  const { dir, store, start, hits } = open();
  const s = talk(store, "numbat");
  expect((await hits(start(), "numbat")).length).toBe(6);
  // Older layouts than the one before are not read: made again from the events.
  let last = store;
  for (const old of [2, 3]) {
    last.side.flush();
    asV4(last);
    last.db.exec(`DELETE FROM search_docs; UPDATE search_meta SET version = ${old};`);
    last.db.close();
    const next = open(dir);
    expect((await next.hits(next.start(), "numbat")).map((h) => h.session_id)).toEqual(Array(6).fill(s));
    expect(version(next.store)).toBe(5);
    intact(next.store);
    last = next.store;
  }
  last.db.close();
});

test("an event that cannot be read is left out of the fill, and said so", async () => {
  const { store, hits } = open();
  const s = talk(store, "bilby");
  store.db.run("INSERT INTO events (id, session_id, seq, kind, data, ts) VALUES ('broken', ?, 99, 'user', '{not json', 1)", [s]);
  const said: unknown[] = [];
  const get = searchRoutes({ store, errors: { capture: (_s: string, e: Error, ctx: unknown) => said.push([e.message, ctx]) } } as any)["/api/search"].GET as (req: Request) => Promise<Response>;
  expect((await hits(get, "bilby")).length).toBe(6);
  expect(version(store)).toBe(5);
  expect(searchMeta(store.db)?.fill_below).toBeNull();
  expect(said.length).toBe(1);
  expect(JSON.stringify(said[0])).toContain("could not be indexed");
  // The other events are indexed whole; the one that cannot be read has no rows.
  store.db.run("DELETE FROM events WHERE id = 'broken'");
  intact(store);
});

test("a later start reads the recorded version and nothing of the index, even an empty one", async () => {
  const first = open();
  talk(first.store, "dunnart");
  expect((await first.hits(first.start(), "dunnart")).length).toBe(6);
  const done = version(first.store);
  // Emptied on purpose (the index told to forget every row, and its numbers with it).
  first.store.db.exec("INSERT INTO search_words (search_words) VALUES ('delete-all'); DELETE FROM search_rows;");
  first.store.db.close();
  for (let i = 0; i < 2; i++) {
    const next = open(first.dir);
    const seen = record(next.store);
    const get = next.start();
    expect(seen.some((q) => q.includes("search_meta"))).toBe(true);
    // (But for the events stored after the last one whose rows were written: a seek past it, which finds none.)
    expect(seen.filter((q) => /count\s*\(|\bFROM events\b|\bsearch_words\b|\bsearch_rows\b/i.test(q) && !/e\.rowid > \?|MAX\(rowid\)/.test(q))).toEqual([]);
    expect(version(next.store)).toBe(done);
    // Not filled again: the events are still there, the hits are not.
    expect(await next.hits(get, "dunnart")).toEqual([]);
    next.store.db.close();
  }
});

test("a recorded version whose index objects are gone is made again", async () => {
  const first = open();
  const s = talk(first.store, "quokka");
  expect((await first.hits(first.start(), "quokka")).length).toBe(6);
  const done = version(first.store);
  // An older binary cut while it rebuilt its own layout: the version stays, the index does not.
  first.store.db.exec("DROP TRIGGER search_rows_del; DROP TABLE search_words;");
  first.store.db.close();
  const next = open(first.dir);
  expect((await next.hits(next.start(), "quokka")).map((h) => h.session_id)).toEqual(Array(6).fill(s));
  expect(version(next.store)).toBe(done);
  intact(next.store);
  next.store.db.close();
});

// An event's rows are not written in its commit: they wait with the other
// side rows. A search still finds the event at once, and a daemon killed
// while rows waited writes them at its next start, once.
test("an event's rows wait for the next side commit, are found at once, and survive a kill", async () => {
  const first = open();
  const get = first.start();
  const rows = (s: Store) => s.db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_rows").get()!.n;
  const committed = () => { const db = new Database(join(first.dir, "keel.db"), { readonly: true }); try { return db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_rows").get()!.n; } finally { db.close(); } };
  const s = talk(first.store, "wombat");
  // Stored, not yet indexed: the log holds the events and none of their rows.
  expect(first.store.side.pending).toBeGreaterThan(0);
  expect(committed()).toBe(0);
  // A search has them written first.
  expect((await first.hits(get, "wombat")).map((h) => h.session_id)).toEqual(Array(6).fill(s));
  expect(first.store.side.pending).toBe(0);
  expect(committed()).toBe(6);
  // An import's events are indexed in its own transaction, after the ones that waited.
  const late = talk(first.store, "potoroo");
  const copy = first.store.createWithEvents({ model: "m", workspace: "/" }, [{ id: "imp-1", kind: "user", data: { text: "an imported bettong prompt" }, ts: 5 }]);
  expect(committed()).toBe(13);
  expect((await first.hits(get, "bettong")).map((h) => h.session_id)).toEqual([copy.id]);
  // Killed with rows waiting: the events are stored, their rows are not.
  const cut = talk(first.store, "quoll");
  expect(first.store.side.pending).toBeGreaterThan(0);
  first.store.db.close();
  expect(committed()).toBe(13);
  // The next start writes them from the events, each once, and a start after that finds nothing to write.
  for (let i = 0; i < 2; i++) {
    const next = open(first.dir);
    const again = next.start();
    expect(rows(next.store)).toBe(19);
    expect((await next.hits(again, "quoll")).map((h) => h.session_id)).toEqual(Array(6).fill(cut));
    expect((await next.hits(again, "potoroo")).map((h) => h.session_id)).toEqual(Array(6).fill(late));
    intact(next.store);
    next.store.db.close();
  }
});

// Among hundreds of sessions named alike (agents), the title asked for by its own words is ranked
// before the ones that merely share them, whichever was used last.
test("a title that holds the words as typed, as whole words, comes before one that shares them", async () => {
  const { titleRank } = await import("./search.ts");
  const words = ["agent", "17"];
  expect(titleRank("Agent 17: check the parser against the fixtures of lane 3", words)).toBe(0);
  expect(titleRank("Agent 170: check the parser against the fixtures of lane 17", words)).toBe(1);
  expect(titleRank("Agent 4: check the parser against the fixtures of lane 17", words)).toBe(2);
  expect(titleRank("Ağent 17", ["agent", "17"])).toBe(0);
  expect(titleRank("anything", [])).toBe(2);
});

// A search of limits alone (no words) lists the rows the limits allow, newest first, from the
// layout before while the new one fills and from the new one after, the same rows from both.
test("limits alone list the rows they allow, newest first, from either layout", async () => {
  const first = open();
  first.start();
  const a = talk(first.store, "wombat");
  const b = talk(first.store, "numbat");
  first.store.side.flush();
  asV4(first.store);
  first.store.db.close();
  const next = open(first.dir);
  const db = next.store.db;
  initSearchIndex(db);
  keepIndexed(next.store);
  expect(searchTable(db)).toBe("search_idx");
  const commands = () => searchContent(db, { match: null, where: "", args: [], rows: { commands: true }, limit: 100, perSession: false, pid: "NULL" });
  const sessions = (hs: { session_id: string }[]) => hs.map((h) => h.session_id);
  const old = commands();
  // Two calls of a shell tool in each session, the later session's first.
  expect(old.map((h) => h.kind)).toEqual(["tool_use", "tool_use", "tool_use", "tool_use"]);
  expect(sessions(old)).toEqual([b, b, a, a]);
  expect(old[0]!.snippet).toStartWith("Bash grep numbat");
  for (let i = 0; i < 1000 && searchMeta(db)?.fill_below !== null; i++) fillStep(db, 2000);
  expect(searchTable(db)).toBe("search_words");
  const now = commands();
  expect(sessions(now)).toEqual(sessions(old));
  expect(now.map((h) => h.snippet).sort()).toEqual(old.map((h) => h.snippet).sort());
  expect(now.map((h) => h.ref).sort()).toEqual(old.map((h) => h.ref).sort());
  // A time alone: every row since then, one per session when asked so.
  const since = searchContent(db, { match: null, where: "", args: [], rows: { since: 0 }, limit: 100, perSession: true, pid: "NULL" });
  expect(sessions(since).sort()).toEqual([a, b].sort());
  next.store.db.close();
});

// The words are matched by their stem, wherever they stand, and the rows that hold every word come
// first; the ones that hold fewer follow (one word fewer first) and say which words they lack. A
// plain date word is a time limit, said back as read.
test("search words match by stem, the rows with more of them first, and a date word limits the time", async () => {
  const { store, start, hits } = open();
  const get = start();
  const both = store.createSession({ model: "m", workspace: "/", title: "Compression export" });
  store.append(both.id, "user", { text: "the compression export of the archive" });
  const one = store.createSession({ model: "m", workspace: "/" });
  store.append(one.id, "user", { text: "an export of the ledger" });
  const none = store.createSession({ model: "m", workspace: "/" });
  store.append(none.id, "user", { text: "nothing to see" });
  store.side.flush();
  const of = (hs: any[]) => hs.map((h) => [h.session_id, h.missing ?? []]);
  // Other forms of the same words, in another order: the session is found, first.
  for (const q of ["compressed exports", "exports compressed", "compressing exported"]) expect(of(await hits(get, q))).toEqual([[both.id, []], [one.id, [q.split(" ").find((w) => w.startsWith("compress"))]]]);
  // Three words, two held: the rows that hold two come before the rows that hold one, each saying what it lacks.
  expect(of(await hits(get, "compressed exports zebra"))).toEqual([[both.id, ["zebra"]], [one.id, ["compressed", "zebra"]]]);
  // A title is matched by its stems too.
  const titles = (await (await get(new Request(`http://keel/api/search?q=${encodeURIComponent("compressed exports")}`))).json()).hits.filter((h: any) => h.kind === "title");
  expect(titles.map((h: any) => h.session_id)).toEqual([both.id]);
  // A date word: the words are searched on that day, and the limit names the word.
  const today = await (await get(new Request(`http://keel/api/search?q=${encodeURIComponent("compression export today")}&limit=100`))).json();
  expect(today.hits[0]).toMatchObject({ session_id: both.id, kind: "user" });
  expect(today.limits[0]).toMatch(/^today, \d{4}-\d\d-\d\d$/);
  expect(today.dates).toEqual(["today"]);
  const yesterday = await (await get(new Request(`http://keel/api/search?q=${encodeURIComponent("compression export yesterday")}&limit=100`))).json();
  expect(yesterday.hits).toEqual([]);
  // In quotes the word is searched: nothing says "today".
  expect(await hits(get, 'compression "today"')).toMatchObject([{ session_id: both.id, missing: ["today"] }]);
  store.db.close();
});

// A session another harness runs is only shown in Keel (src/core/outside.ts): the phone's search (`outside=0`)
// and a search another machine forwards find nothing of it, by its words or its title; the page's own finds it.
test("a search for the phone or another machine leaves out an outside session", async () => {
  const { store, start } = open();
  const get = start();
  const mine = talk(store, "zebracanary");
  const out = talk(store, "zebracanary");
  store.updateSession(out, { title: "zebracanary elsewhere", outside: { harness: "codex", source_id: "x", state: "done", since: 1, files: 0, failures: 0 } });
  const { innerHeaders } = await import("../../safety/presence.ts");
  const ids = async (req: Request) => [...new Set(((await (await get(req)).json()).hits as any[]).map((h) => h.session_id))].sort();
  const url = "http://keel/api/search?q=zebracanary&limit=100";
  expect(await ids(new Request(url))).toEqual([mine, out].sort());
  expect(await ids(new Request(`${url}&outside=0`))).toEqual([mine]);
  expect(await ids(new Request(url, { headers: innerHeaders({ local: false, enrolled: true, present: null }, "far box") }))).toEqual([mine]);
});

// A session is found by its id (all of it, or six characters or more of it) and by its worktree's branch.
test("a session is found by its id, a part of it of six characters or more, and its worktree branch", async () => {
  const { store, start } = open();
  const get = start();
  const s = store.createSession({ model: "m", workspace: "/work/keel" });
  store.createSession({ model: "m", workspace: "/work/other" });
  store.db.run("CREATE TABLE IF NOT EXISTS worktrees (session_id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL, base_commit TEXT NOT NULL, state TEXT NOT NULL, snapshot_ref TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)");
  store.db.run("INSERT INTO worktrees VALUES (?, '/r', '/w', 'keel/r8-area-a-x1y2z3', 'main', 'c0', 'ready', NULL, 1, 1)", [s.id]);
  const titles = async (q: string): Promise<string[]> =>
    (await (await get(new Request(`http://keel/api/search?q=${encodeURIComponent(q)}&limit=100`))).json()).hits.filter((h: any) => h.kind === "title").map((h: any) => h.session_id);
  expect(await titles("r8-area-a")).toEqual([s.id]);
  expect(await titles("x1y2z3")).toEqual([s.id]);
  expect(await titles(s.id)).toEqual([s.id]);
  expect(await titles(s.id.slice(-9))).toEqual([s.id]);
  expect(await titles(s.id.slice(-5))).toEqual([]);
});
