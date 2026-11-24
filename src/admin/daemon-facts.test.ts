import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { daemonFacts, keepStall, stallsPerStart } from "./daemon-facts.ts";

const start = (db: Database, pid: number, up: number, before?: { pid: number; down_ms: number }) => {
  const data = { id: `${pid}-${up}`, up_ms: up, pid, ...(before ? { before: { ...before, started_ms: up - 10_000, how: "restart" } } : {}), turns: [] };
  db.query("INSERT INTO daemon_starts (id, up_ms, data) VALUES (?, ?, ?)").run(data.id, up, JSON.stringify(data));
};

test("the stalls of each start are counted from 0.3 s up, with how many reached the Errors bar, and only those are told by name", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE daemon_starts (id TEXT PRIMARY KEY, up_ms INTEGER NOT NULL, data TEXT NOT NULL)");
  start(db, 10, 1_000);
  start(db, 11, 100_000, { pid: 10, down_ms: 99_000 });
  for (const [ts, ms] of [[2_000, 400], [3_000, 900], [50_000, 3_000], [98_000, 350], [101_000, 700]] as const) keepStall(db, { ts_ms: ts, ms, what: "x", kind: "compute" });
  expect(stallsPerStart(db, 200_000).map((s) => [s.pid, s.stalls, s.over_bar, s.longest_ms, s.total_ms])).toEqual([[11, 1, 0, 700, 700], [10, 4, 1, 3_000, 4_650]]);
  expect(stallsPerStart(db, 200_000)[1]).toMatchObject({ up_ms: 1_000, end_ms: 99_000 });
  // The digest names the stall that made a row, not the shorter ones.
  expect(daemonFacts(db, [{ from: 0, to: 200_000 }]).stalls.map((s) => s.ms)).toEqual([3_000]);
});
