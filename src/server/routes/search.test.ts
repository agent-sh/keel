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
