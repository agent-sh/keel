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

// Records written without a key get one made from their first words. Two in
// one list whose first words are the same are two records, not one.
test("keys made within one list do not collide; a key named twice is still one record", () => {
  const keys = (m: Memory) => m.list().map((r) => [r.key, r.value]).sort();
  const a = new Memory(new Database(":memory:"));
  const out = a.put([
    { kind: "preference", value: "Keep replies short, no hedging" },
    { kind: "preference", value: "Keep replies short: hedging is fine in drafts" },
    { kind: "preference", value: "Keep replies short, no hedging" }, // the same fact again: kept once
  ], "helper");
  expect(out.map((r) => r.key)).toEqual(["preference.keep-replies-short-hedging", "preference.keep-replies-short-hedging-2"]);
  expect(keys(a)).toEqual([
    ["preference.keep-replies-short-hedging", "Keep replies short, no hedging"],
    ["preference.keep-replies-short-hedging-2", "Keep replies short: hedging is fine in drafts"],
  ]);
  // The same list again makes no third record of the first fact's key: stored keys are avoided as before.
  expect(a.put([{ kind: "preference", value: "Keep replies short, hedging never" }], "helper")[0]!.key).toBe("preference.keep-replies-short-hedging-3");
  // A made key also keeps clear of a key the list names later.
  const b = new Memory(new Database(":memory:"));
  b.put([{ kind: "preference", value: "Keep replies short, no hedging" }, { key: "preference.keep-replies-short-hedging", value: "named" }], "helper");
  expect(keys(b)).toEqual([["preference.keep-replies-short-hedging", "named"], ["preference.keep-replies-short-hedging-2", "Keep replies short, no hedging"]]);
  // A key named twice is one record, the later entry's.
  const c = new Memory(new Database(":memory:"));
  expect(c.put([{ key: "Pref.Tone", value: "plain" }, { key: "pref.tone", value: "plain and short" }], "helper")).toHaveLength(1);
  expect(keys(c)).toEqual([["pref.tone", "plain and short"]]);
});
