// The read thread, which no page can tell from a read on the loop: the same
// answer from both, the loop free while the thread reads, a failed read told.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("a thread that ends or stops answering fails the reads that wait on it, and the next read starts another", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-reads-"));
  dirs.push(dir);
  const store = new Store(dir);
  // Thread programs that answer their first read and then go wrong, each in its way.
  const program = (name: string, then: string) => {
    const path = join(dir, name);
    writeFileSync(path, `let n = 0;\nself.onmessage = (ev) => { const m = ev.data; if ("open" in m) return; if (++n === 1) postMessage({ id: m.id, value: [n] }); else { ${then} } };\n`);
    return "file://" + path;
  };
  const said = (p: Promise<unknown>) => p.then((v) => v, (e: Error) => e.message);
  for (const [name, then, why, deadline] of [
    ["ends.ts", "process.exit(0);", "it ended", 60_000],
    ["silent.ts", "", "no answer in 150 ms", 150],
  ] as const) {
    const reads = new Reads(store, true, program(name, then), deadline);
    try {
      expect(await said(reads.sql("SELECT 1"))).toEqual([1]);
      // Two reads wait when it goes: both are told, neither hangs.
      const waiting = [said(reads.sql("SELECT 2")), said(reads.sql("SELECT 3"))];
      expect(await Promise.all(waiting)).toEqual([`the read thread failed: ${why}`, `the read thread failed: ${why}`]);
      // The next read is answered by a new thread (its first read again).
      expect(await said(reads.sql("SELECT 4"))).toEqual([1]);
      expect(reads.counts).toEqual({ thread: 4, loop: 0 });
    } finally {
      reads.close();
    }
  }
});

// A backup takes its snapshot with the write-ahead log empty, which a read
// in flight prevents: it holds the reads. The hold waits for the read that
// runs, a read asked meanwhile waits for the hold to be let go, and a read
// that outlasts the hold's patience does not keep it.
test("a hold waits for the read in flight and keeps the next one back until it is let go", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-reads-"));
  dirs.push(dir);
  const store = new Store(dir);
  const reads = new Reads(store, true);
  try {
    const slow = "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3000000) SELECT count(*) AS n FROM c";
    const order: string[] = [];
    const first = reads.sql(slow).then(() => void order.push("the read in flight"));
    const release = await reads.hold(30_000);
    order.push("held");
    const next = reads.sql("SELECT 1 AS one").then((r) => (order.push("the read asked meanwhile"), r));
    await new Promise((ok) => setTimeout(ok, 50));
    expect(order).toEqual(["the read in flight", "held"]);
    release();
    expect(await next).toEqual([{ one: 1 }]);
    await first;
    expect(order).toEqual(["the read in flight", "held", "the read asked meanwhile"]);
    // Nothing in flight: held at once. A read longer than the hold waits: the hold is given anyway.
    (await reads.hold(30_000))();
    const long = reads.sql(slow);
    const t0 = performance.now();
    (await reads.hold(5))();
    expect(performance.now() - t0).toBeLessThan(200);
    await long;
  } finally {
    reads.close();
  }
});

// A read made ahead of the loop's own (a session's pages, before the loop brings the session into
// memory) is worth a wait only when the thread can take it now. Behind a long report it would keep a
// first prompt waiting for the whole report; where no thread runs, the loop would read the pages twice.
test("a read made ahead runs when the thread is free, and is skipped behind other work or with no thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-reads-"));
  dirs.push(dir);
  const store = new Store(dir);
  const s = store.createSession({ model: "m", workspace: "/" });
  for (let i = 0; i < 20; i++) store.append(s.id, "user", { text: `prompt ${i}` });
  const ahead = "SELECT COUNT(*) AS n FROM events WHERE session_id = ?";
  const reads = new Reads(store, true);
  try {
    // Free: made on the thread, and waited for.
    await reads.readAhead(ahead, [s.id]);
    expect(reads.counts).toEqual({ thread: 1, loop: 0 });
    // Several at once (every session is cold after a start) take their turns: none is skipped for the others.
    await Promise.all([reads.readAhead(ahead, [s.id]), reads.readAhead(ahead, [s.id]), reads.readAhead(ahead, [s.id])]);
    expect(reads.counts).toEqual({ thread: 4, loop: 0 });
    // Behind another read like it that takes long (a session of tens of thousands of events): made all the
    // same, and waited for a few hundred milliseconds at most.
    {
      const long = "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 12000000) SELECT count(*) AS n FROM c";
      const before = reads.counts.thread;
      const big = reads.readAhead(long, [], 30_000);
      const t = performance.now();
      await reads.readAhead(ahead, [s.id]);
      const waited = performance.now() - t;
      let bigDone = false;
      void big.then(() => (bigDone = true));
      await new Promise((ok) => setTimeout(ok, 0));
      expect([waited >= 250 || bigDone, waited < 1_000 || bigDone]).toEqual([true, true]);
      await big;
      expect(reads.counts.thread - before).toBe(2);
    }
    // Behind a report of seconds: skipped, and the caller goes on at once.
    const slow = "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 12000000) SELECT count(*) AS n FROM c";
    const report = reads.sql(slow);
    const t0 = performance.now();
    await reads.readAhead(ahead, [s.id]);
    const waited = performance.now() - t0;
    expect(reads.counts).toEqual({ thread: 7, loop: 0 });
    let done = false;
    void report.then(() => (done = true));
    await new Promise((ok) => setTimeout(ok, 0));
    expect(done).toBe(false);
    expect(waited).toBeLessThan(100);
    // A read ahead that takes longer than its caller will wait: the caller goes on, the read finishes behind it.
    await report;
    const t1 = performance.now();
    const whole = reads.sql(slow).then(() => performance.now() - t1);
    await whole;
    const t2 = performance.now();
    await reads.readAhead(slow, [], 30);
    expect(performance.now() - t2).toBeLessThan((await whole) / 2);
    expect(reads.counts.thread).toBe(9);
    // While reads are held back for a backup: skipped.
    await reads.sql("SELECT 1");
    const release = await reads.hold(30_000);
    await reads.readAhead(ahead, [s.id]);
    release();
    expect(reads.counts).toEqual({ thread: 10, loop: 0 });
  } finally {
    reads.close();
  }
  // No thread (it cannot run here): nothing is read ahead at all, on the loop either.
  const none = new Reads(store, false);
  await none.readAhead(ahead, [s.id]);
  expect(none.counts).toEqual({ thread: 0, loop: 0 });
  const broken = new Reads(store, true, new URL("./no-such-program.ts", import.meta.url).href);
  await broken.sql("SELECT 1");
  await broken.readAhead(ahead, [s.id]);
  expect(broken.counts).toEqual({ thread: 1, loop: 1 });
});
