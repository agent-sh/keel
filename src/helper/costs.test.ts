// The helper's spend by session is a sum over the telemetry ledger: it goes through the read thread, never the loop's connection.
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { tempTree } from "../../test/env.ts";
import { Store } from "../core/store.ts";
import { readsOf } from "../server/reads.ts";
import { costs } from "./tools.ts";

const dir = tempTree("helper-costs-");
const store = new Store(join(dir, "state"));
afterAll(() => store.db.close());
store.migrate(`CREATE TABLE IF NOT EXISTS telemetry_calls (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, model TEXT NOT NULL DEFAULT 'm', input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, cost REAL, unpriced INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL DEFAULT 'ok', purpose TEXT)`);

test("spend by session since a time is read through the read path and summed per session", async () => {
  const s = store.createSession({ model: "m", workspace: "/" });
  const put = store.db.query("INSERT INTO telemetry_calls (session_id, ts, input, output, cache_read, cache_write, cost) VALUES (?, ?, ?, ?, ?, ?, ?)");
  put.run(s.id, 2_000, 10, 5, 100, 0, 0.5);
  put.run(s.id, 3_000, 1, 1, 1, 1, 0.25);
  put.run(s.id, 500, 9, 9, 9, 9, 9);
  const reads = readsOf(store);
  const before = reads.counts.thread + reads.counts.loop;
  const got = await costs(store, 1_000);
  expect(reads.counts.thread + reads.counts.loop).toBe(before + 1);
  expect(got.get(s.id)).toEqual({ cost: 0.75, tokens: 119, calls: 2 });
});
