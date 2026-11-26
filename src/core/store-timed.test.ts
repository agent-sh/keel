// A stall made by a read of bodies on the loop is named by what it was: the daemon sets `timed`, and the
// store runs the read inside it, with who asked (the table's part is the statement's, the parse is not).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-store-timed-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a run of bodies read on the loop is a timed section that says who asked", () => {
  const first = new Store(dir);
  const s = first.createSession({ model: "m", workspace: "/" });
  for (let i = 1; i <= 200; i++) first.append(s.id, "user", { text: `prompt ${i}` });
  first.db.close();
  const store = new Store(dir);
  const labels: string[] = [];
  store.timed = (label, f) => { labels.push(label()); return f(); };
  store.events(s.id);
  expect(labels).toEqual([]);
  void store.lineage(s.id)[10]!.data;
  expect(labels).toHaveLength(1);
  expect(labels[0]).toStartWith("reading and parsing a run of a session's event bodies on the loop (asked by ");
  // The same run again is in memory: nothing is read.
  void store.lineage(s.id)[11]!.data;
  expect(labels).toHaveLength(1);
});

// Bodies read off the loop are parsed on it: each one is a timed section, and the loop is let go between
// them once a slice of time is used, so a run of large tool results does not hold it whole.
test("a run of bodies read off the loop is parsed a body at a time, each a timed section", async () => {
  const d = mkdtempSync(join(dir, "off-"));
  const first = new Store(d);
  const s = first.createSession({ model: "m", workspace: "/" });
  for (let i = 1; i <= 64; i++) first.append(s.id, "user", { text: `prompt ${i} ${"x".repeat(20_000)}` });
  first.db.close();
  const store = new Store(d);
  store.readOff = async (sql, params) => store.db.query(sql).all(...(params as any[]));
  const labels: string[] = [];
  store.timed = (label, f) => { labels.push(label()); return f(); };
  await store.warmBodies(s.id, 0);
  const parsed = labels.filter((l) => l.startsWith("parsing an event body read off the loop"));
  expect(parsed).toHaveLength(64);
  expect(parsed[0]).toContain("20 KB");
  // In memory now: a read on the loop reads nothing.
  void store.lineage(s.id)[10]!.data;
  expect(labels.filter((l) => l.startsWith("reading and parsing"))).toEqual([]);
});

// A run the read thread could not give is read on the loop, and the loop is let go after it as after a run
// that came from the thread: a dead read thread made every run of a long session one hold of the loop.
test("a run read on the loop because the read thread failed gives the loop back before the next", async () => {
  const d = mkdtempSync(join(dir, "dead-"));
  const first = new Store(d);
  const s = first.createSession({ model: "m", workspace: "/" });
  for (let i = 1; i <= 64 * 4; i++) first.append(s.id, "user", { text: `prompt ${i}` });
  first.db.close();
  const store = new Store(d);
  store.readOff = async () => { throw new Error("the read thread is gone"); };
  let ticks = 0, done = false;
  const beat = () => { ticks++; if (!done) setImmediate(beat); };
  setImmediate(beat);
  const at: number[] = [];
  // Each read takes a slice of time, as a run of real bodies does.
  store.timed = (label, f) => { if (label().startsWith("reading and parsing")) { at.push(ticks); const t = performance.now() + 6; while (performance.now() < t); } return f(); };
  await store.warmBodies(s.id, 0);
  done = true;
  expect(at.length).toBeGreaterThanOrEqual(4);
  for (let i = 1; i < at.length; i++) expect(at[i]!).toBeGreaterThan(at[i - 1]!);
});
