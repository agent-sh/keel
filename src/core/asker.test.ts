// Who asked for a read that holds the loop (src/core/asker.ts): the label the store counts the
// read under and the stall watcher puts in its row. A code path's own name and the names of the
// functions above the read; never a value.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asAsker, asker, askerCell, askerLabels, asking } from "./asker.ts";
import { Store } from "./store.ts";

test("a read on the loop is named by the path that asked: its own name, then the functions above the read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-asker-"));
  try {
    const store = new Store(dir);
    const a = store.createSession({ model: "p:m", workspace: "/" }).id, b = store.createSession({ model: "p:m", workspace: "/" }).id;
    for (const id of [a, b]) for (let i = 0; i < 40; i++) store.append(id, "user", { text: "sk-live-hunter2 is a value" });
    const out = () => { (store as any).forget(a); (store as any).forget(b); };
    // A session in memory is read with nothing counted.
    expect([store.lineage(a).length, store.coldReads().start.n]).toEqual([40, 0]);
    out();
    // Out of memory, read where the caller cannot wait: counted, with who asked. (Before the daemon serves: under `start`.)
    function reportToParent(id: string) { return store.lineage(id).length; }
    reportToParent(a);
    store.serving = true;
    await asAsker("GET /api/sessions/:id/agents", async () => { await Bun.sleep(1); return asAsker("an agent's list", () => store.events(b).length); });
    const c = store.coldReads();
    expect([c.start.n, c.start.rows, c.n, c.rows]).toEqual([1, 40, 1, 40]);
    expect(c.start.by[0]!.who).toStartWith("reportToParent (asker.test)");
    expect(c.by[0]!.who).toStartWith("GET /api/sessions/:id/agents > an agent's list: ");
    // A label is names: no id of a session, nothing of what was stored.
    for (const who of [c.start.by[0]!.who, c.by[0]!.who]) {
      expect(who.length).toBeLessThanOrEqual(120);
      expect([who.includes(a), who.includes(b), who.includes("hunter2")]).toEqual([false, false, false]);
      expect(who).toMatch(/^[\w$.<>() :\/'-]+$/);
    }
    // One that is brought in first (a reader that can wait) is not such a read.
    out();
    await store.warm(a, false);
    expect([store.lineage(a).length, store.coldReads().n]).toEqual([40, 1]);
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the stall watcher is told who asked while the read runs, by a number it has the words for", () => {
  const seen = new Map<number, string>();
  const stop = askerLabels((id, text) => void seen.set(id, text));
  try {
    expect(askerCell[0]).toBe(0);
    let during = 0;
    const who = asAsker("a turn", () => asker());
    asking(who, () => { during = askerCell[0]!; });
    expect([during > 0, askerCell[0], seen.get(during)]).toEqual([true, 0, who]);
    expect(who).toStartWith("a turn");
    // Labels are few: past their number a new one is "another path", never a text without end.
    let other = 0;
    for (let n = 0; n < 600; n++) asking(`a path made up ${n}`, () => { other = askerCell[0]!; });
    expect([seen.size <= 500, other]).toEqual([true, 1]);
  } finally { stop(); }
});
