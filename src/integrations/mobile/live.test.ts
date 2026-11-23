import { expect, test } from "bun:test";
import { liveData, liveStatus, LiveTicker, type LiveStatus } from "./live.ts";

test("the status counts what runs and what waits, the longest-running first", () => {
  const s = liveStatus([
    { title: "Docs", running: true, since: 2000, needs: 0 },
    { title: "Fix the build", running: true, since: 1000, needs: 1 },
    { title: "Idle", running: false, needs: 1 },
  ]);
  // Fix the build waits on the owner: it needs them, it does not work.
  expect(s).toEqual({ working: 1, needs: 2, titles: ["Docs"], since: 2000 });
  expect(liveData(s)).toEqual({ w: "1", q: "2", title: "1 session working · 2 need you", body: "Docs", since: "2000" });
  expect(liveData(liveStatus([]))).toEqual({ w: "0", q: "0", title: "", body: "" });
});

test("a change is held and sent once; one that comes and goes inside the hold sends nothing; the end is sent", async () => {
  let now: LiveStatus = { working: 0, needs: 0, titles: [], since: null };
  const sent: LiveStatus[] = [];
  const t = new LiveTicker(() => now, (s) => void sent.push(s), 30);
  // Nothing runs and nothing was told: nothing to say.
  t.poke(); await Bun.sleep(60);
  expect(sent).toEqual([]);
  // A turn starts and ends inside one hold: nothing.
  now = { working: 1, needs: 0, titles: ["A"], since: 1 }; t.poke();
  now = { working: 0, needs: 0, titles: [], since: null }; t.poke();
  await Bun.sleep(60);
  expect(sent).toEqual([]);
  // A turn that runs: one push, however often it is poked.
  now = { working: 1, needs: 0, titles: ["A"], since: 1 };
  for (let i = 0; i < 5; i++) t.poke();
  await Bun.sleep(60);
  t.poke(); await Bun.sleep(60);
  expect(sent.map((s) => s.working)).toEqual([1]);
  // It ends: the push that takes the notification down.
  now = { working: 0, needs: 0, titles: [], since: null }; t.poke(); await Bun.sleep(60);
  expect(sent.map((s) => s.working)).toEqual([1, 0]);
  t.stop();
});
