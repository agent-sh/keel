import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Memory } from "./memory.ts";

// The free-text list of before moves into keyed records once, at start
// (a daemon with an old state; no e2e starts one).
test("the old remembered list becomes keyed records, and its table goes", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE helper_memory (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, updated INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0)");
  const ins = db.query("INSERT INTO helper_memory VALUES (?, ?, ?, ?, ?, ?, ?)");
  ins.run("a", 1, 2, "preference", "Keep replies short, no hedging", "helper", 3);
  ins.run("b", 2, 2, "person", "Dana is the accountant", "owner", 0);
  ins.run("c", 3, 3, "preference", "Keep replies short and plain", "helper", 0);
  const m = new Memory(db);
  expect(m.list().map((r) => [r.key, r.source, r.used]).sort()).toEqual([
    ["person.dana-accountant", "owner", 0],
    ["preference.keep-replies-short-hedging", "helper", 3],
    ["preference.keep-replies-short-plain", "helper", 0],
  ]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'helper_memory'").all()).toEqual([]);
  // A second start finds the records and nothing to move.
  expect(new Memory(db).index.size).toBe(3);
});
