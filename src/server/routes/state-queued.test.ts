import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import { queuedFor } from "./state.ts";

for (const existing of [false, true]) test(`count queues from the covering index (${existing ? "existing" : "fresh"} database)`, () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-queued-"));
  let store = new Store(dir);
  try {
    const mk = () => store.createSession({ model: "test", workspace: dir, title: "Queue" }).id;
    const a = mk(), b = mk(), c = mk();
    store.enqueue(a, "one", false);
    store.enqueue(a, "two", true);
    const out = store.enqueue(b, "on its way out", false);
    store.enqueue(c, "kept", false);
    const going = store.enqueue(c, "also on its way out", false);
    if (existing) {
      // The x5 daemon used this name for a narrower index. Keep the queued rows across the upgrade.
      store.db.exec("DROP INDEX queue_session; CREATE INDEX queue_session ON queue(session_id)");
      store.db.close();
      store = new Store(dir);
    }
    expect(Object.fromEntries(store.queueCounts())).toEqual({ [a]: 2, [b]: 1, [c]: 2 });
    expect(Object.fromEntries(store.queueCounts([out.id, going.id, "no-such-row"]))).toEqual({ [a]: 2, [c]: 1 });
    const plan = store.db.query<{ detail: string }, []>("EXPLAIN QUERY PLAN SELECT session_id, count(*) AS n FROM queue GROUP BY session_id").all().map((r) => r.detail).join(" ");
    expect(plan).toContain("COVERING INDEX queue_session");
    const order = store.db.query<{ detail: string }, [string]>("EXPLAIN QUERY PLAN SELECT * FROM queue WHERE session_id = ? ORDER BY steer DESC, pos").all(a).map((r) => r.detail).join(" ");
    expect(order).toContain("queue_session");
    expect(order).not.toContain("TEMP B-TREE");
    expect(store.queue(a).map((q) => q.text)).toEqual(["two", "one"]);
  } finally {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the snapshot omits archived queues and can say there are none", () => {
  const states = { a: { watch: "work" }, b: { watch: "idle" } };
  expect(queuedFor(states, new Map([["a", 2], ["archived", 4]]))).toEqual({ a: 2 });
  expect(queuedFor(states, new Map())).toEqual({});
});
