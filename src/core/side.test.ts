// Side writes wait for the next commit: what a reader sees, what an event's
// commit carries, and what a kill can lose. No page shows any of this.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SIDE_MAX } from "./side.ts";
import { Store } from "./store.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// A store with one side table (the activity list's shape), and a second connection that sees only what is committed.
function open() {
  const dir = mkdtempSync(join(tmpdir(), "keel-side-"));
  dirs.push(dir);
  const store = new Store(dir);
  store.migrate("CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, text TEXT NOT NULL UNIQUE); CREATE TABLE IF NOT EXISTS plain (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
  const failures: string[] = [];
  store.sideFailed = (_e, what) => failures.push(what);
  const other = new Database(join(dir, "keel.db"), { readonly: true });
  const committed = () => other.query<{ text: string }, []>("SELECT text FROM activity ORDER BY id").all().map((r) => r.text);
  const add = (text: string) => store.side.later(`row ${text}`, () => void store.db.query("INSERT INTO activity (text) VALUES (?)").run(text));
  // The log's size in pages, as written so far.
  const frames = () => Math.max(0, Math.floor((Bun.file(join(dir, "keel.db-wal")).size - 32) / (4096 + 24)));
  return { dir, store, other, committed, add, failures, frames };
}

test("a side write waits for the others, and no reader of its table misses it", async () => {
  const w = open();
  const s = w.store.createSession({ model: "m", workspace: "/" });
  w.add("one");
  w.add("two");
  // Asked for, not written: nothing is committed, and nothing was written to the log for it.
  expect(w.store.side.pending).toBe(2);
  expect(w.committed()).toEqual([]);
  // A statement of the daemon's connection that names the table has them written first, in order.
  expect(w.store.db.query<{ text: string }, []>("SELECT text FROM activity ORDER BY id").all().map((r) => r.text)).toEqual(["one", "two"]);
  expect(w.store.side.pending).toBe(0);
  expect(w.committed()).toEqual(["one", "two"]);
  // A statement that names no side table leaves them waiting.
  w.add("three");
  w.store.db.query("INSERT INTO plain (text) VALUES (?)").run("x");
  expect(w.store.db.query("SELECT COUNT(*) AS n FROM plain").get()).toEqual({ n: 1 });
  expect(w.store.side.pending).toBe(1);
  // So does an event's commit: its pages are the event's, not every side table's.
  w.store.append(s.id, "user", { text: "hello" });
  expect(w.store.side.pending).toBe(1);
  expect(w.committed()).toEqual(["one", "two"]);
  // They are written together a moment later, as one commit.
  w.add("four");
  const commits = w.store.side.counts.commits;
  for (let i = 0; i < 200 && w.store.side.pending; i++) await Bun.sleep(20);
  expect(w.store.side.counts.commits).toBe(commits + 1);
  expect(w.committed()).toEqual(["one", "two", "three", "four"]);
  // A write on the table that was not asked for through the queue comes after the ones that wait.
  w.add("five");
  w.store.db.run("INSERT INTO activity (text) VALUES ('six')");
  expect(w.committed()).toEqual(["one", "two", "three", "four", "five", "six"]);
  w.other.close();
  w.store.db.close();
});

test("a side write that fails is dropped and said, and neither the others nor the event with it are lost", () => {
  const w = open();
  const s = w.store.createSession({ model: "m", workspace: "/" });
  w.add("one");
  w.add("one"); // refused by the table: the text is there already
  w.store.side.later("a write that throws", () => { throw new Error("no"); });
  w.add("two");
  const e = w.store.append(s.id, "user", { text: "kept" });
  w.store.side.flush();
  expect(w.committed()).toEqual(["one", "two"]);
  expect(w.failures).toEqual(["row one", "a write that throws"]);
  expect(new Store(w.dir).events(s.id).map((x) => x.id)).toEqual([e.id]);
  // More than may wait: written at once, so what waits is bounded.
  for (let i = 0; i < SIDE_MAX + 10; i++) w.add(`n${i}`);
  expect(w.store.side.pending).toBeLessThan(SIDE_MAX);
  expect(w.committed().length).toBeGreaterThanOrEqual(SIDE_MAX);
  w.other.close();
  w.store.db.close();
});

test("a kill loses the side rows that waited and nothing else; rows that share a commit share its pages", () => {
  const w = open();
  const s = w.store.createSession({ model: "m", workspace: "/" });
  const first = w.store.append(s.id, "user", { text: "before" });
  w.add("written before the kill");
  w.store.side.flush();
  const second = w.store.append(s.id, "assistant", { blocks: [] });
  w.add("still waiting when the daemon is killed");
  // The daemon is gone without a word: what another process finds is what was committed.
  const after = new Database(join(w.dir, "keel.db"), { readonly: true });
  expect(after.query<{ id: string }, [string]>("SELECT id FROM events WHERE session_id = ? ORDER BY seq").all(s.id).map((r) => r.id)).toEqual([first.id, second.id]);
  expect(after.query<{ text: string }, []>("SELECT text FROM activity").all().map((r) => r.text)).toEqual(["written before the kill"]);
  after.close();
  // Twenty rows asked for one after another: written by themselves they are twenty commits of the
  // table's page; waiting, they are one.
  w.store.side.flush();
  const alone = w.frames();
  for (let i = 0; i < 20; i++) w.store.db.query("INSERT INTO plain (text) VALUES (?)").run(`p${i}`);
  const each = w.frames() - alone;
  for (let i = 0; i < 20; i++) w.add(`b${i}`);
  w.store.side.flush();
  const together = w.frames() - alone - each;
  expect(each).toBeGreaterThanOrEqual(20);
  expect(together).toBeLessThanOrEqual(4);
  w.other.close();
  w.store.db.close();
});
