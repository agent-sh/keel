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
