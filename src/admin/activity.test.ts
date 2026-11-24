// The work the daemon names when its memory steps or its loop is held: spans of routes, reads and tasks.
import { afterEach, expect, test } from "bun:test";
import { begin, during, duringSync, ongoing, ran, ranWords, reset } from "./activity.ts";

afterEach(reset);

test("a span that ran in the window is named with its count and time", async () => {
  const from = Date.now() - 5;
  const end = begin("read", "read on the thread: session.whole");
  await Bun.sleep(20);
  end();
  await during("task", () => Bun.sleep(15), "a compaction");
  // Too short to name: nothing of a millisecond holds memory worth a line.
  duringSync("route", "GET /api/quick", () => 1);
  const got = ran(from, Date.now());
  expect(got.map((r) => r.label).sort()).toEqual(["a compaction", "read on the thread: session.whole"]);
  const read = got.find((r) => r.kind === "read")!;
  expect(read.n).toBe(1);
  expect(read.longest_ms).toBeGreaterThanOrEqual(15);
  // (How much resident memory grew is the machine's: it is a number, not a figure to pin.)
  expect(Number.isFinite(read.grew_bytes)).toBe(true);
  expect(ranWords(got)).toContain("read on the thread: session.whole (");
});

test("a span still open is named, one that ended before the window is not, and a label is made only when it is needed", async () => {
  let made = 0;
  const done = begin("route", () => (made++, "GET /api/old"));
  await Bun.sleep(15);
  done();
  expect(made).toBe(1);
  const since = Date.now() + 1;
  const open = begin("route", () => (made++, "GET /api/slow/:id"));
  const quick = begin("route", () => (made++, "GET /api/never-told"));
  quick();
  await Bun.sleep(5);
  const got = ran(since, Date.now() + 5);
  expect(got).toHaveLength(1);
  expect(got[0]).toMatchObject({ label: "GET /api/slow/:id", open: 1, n: 1 });
  expect(ongoing()).toEqual({ route: 1 });
  // (The label of the quick one was never asked for.)
  expect(made).toBe(2);
  open();
  open();
  expect(ongoing()).toEqual({});
});
