// The read thread, which no page can tell from a read on the loop: the same
// answer from both, the loop free while the thread reads, a failed read told.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { Reads } from "./reads.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("a read on the thread gives what the loop gives, sees what was just written, and leaves the loop free", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-reads-"));
  dirs.push(dir);
  const store = new Store(dir);
  const s = store.createSession({ model: "m", workspace: "/" });
  for (let i = 0; i < 50; i++) store.append(s.id, "user", { text: `prompt ${i}` });
  const thread = new Reads(store, true), loop = new Reads(store, false);
  try {
    const sql = "SELECT seq, kind, json_extract(data, '$.text') AS text FROM events WHERE session_id = ? ORDER BY seq";
    expect(await thread.sql(sql, [s.id])).toEqual(await loop.sql(sql, [s.id]));
    expect([thread.counts, loop.counts]).toEqual([{ thread: 1, loop: 0 }, { thread: 0, loop: 1 }]);
    // Written after the thread opened its connection: read all the same.
    store.append(s.id, "user", { text: "one more" });
    expect((await thread.sql<{ n: number }>("SELECT count(*) AS n FROM events WHERE session_id = ?", [s.id]))[0]!.n).toBe(51);
    // A read that takes long does not hold the loop: timers go on firing meanwhile.
    let ticks = 0;
    const timer = setInterval(() => ticks++, 2);
    const slow = "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3000000) SELECT count(*) AS n FROM c";
    const t0 = performance.now();
    expect(await thread.sql<{ n: number }>(slow)).toEqual([{ n: 3_000_000 }]);
    const took = performance.now() - t0;
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(took / 20);
    // The thread cannot write, and a failed read is a rejection with SQLite's words.
    const said = (p: Promise<unknown>) => p.then(() => "answered", (e: Error) => e.message);
    expect(await said(thread.sql("DELETE FROM events"))).toContain("readonly");
    expect(await said(thread.sql("SELECT x FROM nowhere"))).toContain("no such table");
    expect(await thread.sql("SELECT 1 AS one")).toEqual([{ one: 1 }]);
  } finally {
    thread.close();
  }
  // A thread that never answers (its program is not there): the read is made on the loop, and so is the next.
  const broken = new Reads(store, true, new URL("./no-such-program.ts", import.meta.url).href);
  expect(await broken.sql("SELECT 2 AS two")).toEqual([{ two: 2 }]);
  expect(await broken.sql("SELECT 3 AS three")).toEqual([{ three: 3 }]);
  expect(broken.counts.loop).toBe(2);
});
