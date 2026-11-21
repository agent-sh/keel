// The search index's own bookkeeping, which the e2e cannot see: how an
// event's rows leave the index, and what a start does to an index it finds.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import { searchRoutes } from "./search.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function open(dir?: string) {
  if (!dir) dirs.push((dir = mkdtempSync(join(tmpdir(), "keel-search-"))));
  const store = new Store(dir);
  const start = () => searchRoutes({ store } as any)["/api/search"].GET as (req: Request) => Response;
  const hits = async (get: (req: Request) => Response, q: string): Promise<any[]> =>
    (await get(new Request(`http://keel/api/search?q=${encodeURIComponent(q)}&limit=100`)).json()).hits.filter((h: any) => h.kind !== "title");
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

// The plan of every statement a delete trigger of the index runs.
function deletePlans(store: Store): string[] {
  const out: string[] = [];
  const triggers = store.db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'search_%' AND sql LIKE '% DELETE ON %'").all();
  for (const { sql } of triggers) {
    const body = sql.slice(sql.indexOf("BEGIN") + 5, sql.lastIndexOf("END"));
    for (const st of body.split(";").map((x) => x.trim()).filter(Boolean)) {
      // Finalized: the plan of a DELETE read with all() stays open and holds the next commit.
      const plan = store.db.prepare<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${st.replace(/OLD\.\w+/g, "'x'")}`);
      for (const r of plan.all()) out.push(r.detail);
      plan.finalize();
    }
  }
  return out;
}

test("an event's rows are found by its id and removed by rowid, whatever else is indexed", async () => {
  const { store, start, hits } = open();
  const get = start();
  const plans = deletePlans(store);
  const onIndex = plans.filter((p) => p.includes("search_idx"));
  expect(onIndex.length).toBeGreaterThan(0);
  // "INDEX 0:=" is FTS5's lookup of one rowid; "INDEX 0:" reads every row.
  for (const p of onIndex) expect(p).toMatch(/^SCAN search_idx VIRTUAL TABLE INDEX \d+:=$/);
  expect(plans.filter((p) => !p.includes("search_idx"))).toEqual(["SEARCH search_docs USING PRIMARY KEY (event_id=?)"]);

  // Count what a session's deletion looks up and removes, with 20 and then 200 unrelated rows around it.
  store.db.exec("CREATE TEMP TABLE probe (n INTEGER); INSERT INTO probe VALUES (0); CREATE TEMP TRIGGER probe_del AFTER DELETE ON main.search_docs BEGIN UPDATE probe SET n = n + 1; END;");
  const rows = () => store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_idx").get()!.n;
  const removed: number[][] = [];
  const kept = talk(store, "quokka");
  for (const n of [20, 180]) {
    filler(store, n);
    const gone = talk(store, "quokka");
    const before = rows();
    const order = (await hits(get, "quokka")).filter((h) => h.session_id === kept).map((h) => `${h.kind}:${h.ref ?? ""}`);
    expect(order.length).toBe(6);
    expect((await hits(get, "quokka")).filter((h) => h.session_id === gone).length).toBe(6);
    store.db.run("UPDATE probe SET n = 0");
    store.deleteSession(gone);
    removed.push([store.db.query<{ n: number }, []>("SELECT n FROM probe").get()!.n, before - rows()]);
    // Every row of the deleted session is gone; the other session's hits and their order stay.
    const after = await hits(get, "quokka");
    expect(after.filter((h) => h.session_id === gone)).toEqual([]);
    expect(after.filter((h) => h.session_id === kept).map((h) => `${h.kind}:${h.ref ?? ""}`)).toEqual(order);
  }
  expect(removed).toEqual([[6, 6], [6, 6]]);
  expect(store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_docs").get()!.n).toBe(rows());
});

test("an index from before the map keeps its rows and gets them mapped", async () => {
  const { dir, store, start, hits } = open();
  start();
  // The layout of version 3: rows straight into the index, removed by a scan on the event id.
  store.db.exec(`
    DROP TRIGGER search_idx_ins; DROP TRIGGER search_idx_del; DROP VIEW search_in; DROP TABLE search_docs;
    UPDATE search_meta SET version = 3;
    CREATE TRIGGER search_idx_ins AFTER INSERT ON events WHEN NEW.kind = 'user' BEGIN
      INSERT INTO search_idx (text, event_id, session_id, kind, ts, ref, cut) VALUES (json_extract(NEW.data, '$.text'), NEW.id, NEW.session_id, 'user', NEW.ts, NULL, 0);
    END;
    CREATE TRIGGER search_idx_del AFTER DELETE ON events BEGIN DELETE FROM search_idx WHERE event_id = OLD.id; END;`);
  const old = store.createSession({ model: "m", workspace: "/" });
  for (let i = 0; i < 5; i++) store.append(old.id, "user", { text: `wombat note ${i}` });
  const other = store.createSession({ model: "m", workspace: "/" });
  store.append(other.id, "user", { text: "wombat elsewhere" });
  const indexed = () => store.db.query<{ rowid: number; event_id: string }, []>("SELECT rowid, event_id FROM search_idx ORDER BY rowid").all();
  const was = indexed();
  expect(was.length).toBe(6);
  store.db.close();

  const next = open(dir);
  const get = next.start();
  // The same rows under the same ids (nothing indexed again), each mapped to its event.
  expect(next.store.db.query<{ rowid: number; event_id: string }, []>("SELECT rowid, event_id FROM search_idx ORDER BY rowid").all()).toEqual(was);
  expect(next.store.db.query<{ rowid: number; event_id: string }, []>("SELECT doc AS rowid, event_id FROM search_docs ORDER BY doc").all()).toEqual(was);
  expect((await hits(get, "wombat")).length).toBe(6);
  // A new event is indexed once, and the old rows leave with their session.
  next.store.append(other.id, "user", { text: "wombat again" });
  expect((await hits(get, "wombat")).length).toBe(7);
  next.store.deleteSession(old.id);
  expect((await hits(get, "wombat")).map((h) => h.session_id)).toEqual([other.id, other.id]);
  for (const p of deletePlans(next.store).filter((x) => x.includes("search_idx"))) expect(p).toMatch(/:=$/);
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

test("the first start and a new version index what was stored before", async () => {
  const { dir, store, start, hits } = open();
  const s = talk(store, "numbat");
  expect((await hits(start(), "numbat")).length).toBe(6);
  // An older version of the index is made again from the events; so is the
  // last version's when its fill never ran (it holds nothing).
  let last = store;
  for (const old of [2, 3]) {
    last.db.exec(`DELETE FROM search_docs; UPDATE search_meta SET version = ${old};`);
    expect(last.db.query<{ n: number }, []>("SELECT count(*) AS n FROM search_idx").get()!.n).toBe(0);
    last.db.close();
    const next = open(dir);
    expect((await next.hits(next.start(), "numbat")).map((h) => h.session_id)).toEqual(Array(6).fill(s));
    last = next.store;
  }
  last.db.close();
});

test("a fill that failed records nothing, and the next start fills", async () => {
  const { store, start, hits } = open();
  const s = talk(store, "bilby");
  store.db.run("INSERT INTO events (id, session_id, seq, kind, data, ts) VALUES ('broken', ?, 99, 'user', '{not json', 1)", [s]);
  expect(() => start()).toThrow();
  expect(version(store)).toBeUndefined();
  store.db.run("DELETE FROM events WHERE id = 'broken'");
  expect((await hits(start(), "bilby")).length).toBe(6);
  expect(version(store)).toBeGreaterThan(0);
});

test("a later start reads the recorded version and nothing of the index, even an empty one", async () => {
  const first = open();
  talk(first.store, "dunnart");
  expect((await first.hits(first.start(), "dunnart")).length).toBe(6);
  const done = version(first.store);
  first.store.db.exec("DELETE FROM search_docs");
  first.store.db.close();
  for (let i = 0; i < 2; i++) {
    const next = open(first.dir);
    const seen = record(next.store);
    const get = next.start();
    expect(seen.some((q) => q.includes("search_meta"))).toBe(true);
    expect(seen.filter((q) => /count\s*\(|\bFROM events\b|\bsearch_idx\b|\bsearch_docs\b/i.test(q))).toEqual([]);
    expect(version(next.store)).toBe(done);
    // Emptied on purpose and not filled again: the events are still there, the hits are not.
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
  first.store.db.exec("DROP TRIGGER search_idx_ins; DROP TRIGGER search_idx_del; DROP TABLE search_idx;");
  first.store.db.close();
  const next = open(first.dir);
  expect((await next.hits(next.start(), "quokka")).map((h) => h.session_id)).toEqual(Array(6).fill(s));
  expect(version(next.store)).toBe(done);
  next.store.db.close();
});
