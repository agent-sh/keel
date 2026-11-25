// A restart leaves the page answering: the loop is never held for 100 ms by the start's recovery. A
// start wakes every turn a restart cut at the same moment, and the first request of each takes its
// time to prepare (the messages, the hooks, the send): back to back, four of them held the loop for
// the sum. They go one at a time now, the loop served between the parts of a request's preparation.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { rig } from "./delivery.fixture.ts";

const scratch = (name: string) => mkdtempSync(join(process.env.TMPDIR ?? ".", `${name}-`));
const busy = (ms: number) => { const t = performance.now(); while (performance.now() - t < ms) {} };
const HOLD_MS = 100;

test("a start that continues four cut turns holds the loop under 100 ms at every moment", async () => {
  const dir = scratch("start-hold");
  // A store with many sessions: idle ones with a conversation each, and four cut in the middle of a turn.
  const first = rig(dir);
  const cut: string[] = [];
  first.store.db.transaction(() => {
    for (let i = 0; i < 300; i++) {
      const at = Date.now() - 86_400_000 - i * 1000;
      const events = Array.from({ length: 60 }, (_, k) => ({ id: Bun.randomUUIDv7(), kind: (k % 3 === 0 ? "user" : k % 3 === 1 ? "turn_start" : "turn_end") as any, ts: at + k, data: k % 3 === 0 ? { text: `question ${k}` } : k % 3 === 1 ? { model: "scripted:stand-in" } : { reason: "end_turn", usage: {}, ms: 1 } }));
      first.store.createWithEvents({ model: "scripted:stand-in", workspace: dir, title: `idle ${i}` }, events);
    }
    for (let i = 0; i < 4; i++) {
      const s = first.store.createWithEvents({ model: "scripted:stand-in", workspace: dir, title: `cut ${i}` }, [
        { id: Bun.randomUUIDv7(), kind: "user", ts: Date.now() - 5000, data: { text: `work ${i}` } },
        { id: Bun.randomUUIDv7(), kind: "turn_start", ts: Date.now() - 4000, data: { model: "scripted:stand-in" } },
      ]);
      first.store.db.query("UPDATE sessions SET phase = 'working' WHERE id = ?").run(s.id);
      cut.push(s.id);
    }
  })();
  first.store.db.close();

  // Each cut turn's first request costs 30 ms of the loop's own time to build.
  const next = rig(dir, { request: async () => { busy(30); } });
  expect(next.store.bootWorking.length).toBe(4);
  let last = performance.now(), worst = 0;
  const watch = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 1);
  try {
    await next.engine.recover(next.store.bootWorking, async () => {});
    for (const id of cut) await next.engine.idle(id);
  } finally { clearInterval(watch); }
  // All four went on, and none of the loop's holds reached the bound.
  expect(next.requests.length).toBe(4);
  expect(worst).toBeLessThan(HOLD_MS);
}, 30_000);
