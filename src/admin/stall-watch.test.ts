// The watcher's failure: reported once, and from then on a stall says the
// watcher is off instead of waiting for it. (What the watcher sees is tested
// with recorded samples in stall-cause.test.ts, and really, against a
// daemon, in test/e2e/stall.spec.ts.)
import { expect, test } from "bun:test";
import { StallWatch } from "./stall-watch.ts";

const program = (js: string) => URL.createObjectURL(new Blob([js], { type: "application/javascript" }));
const dirs = { state: "/nowhere/state", config: "/nowhere/config" };

test.skipIf(process.platform !== "linux")("a watcher that fails is reported once, stops, and every stall after it says so at once", async () => {
  const errors: string[] = [];
  // A kernel that keeps no schedstat: the thread says so at its start.
  const w = new StallWatch(dirs, (e) => void errors.push((e as Error).message), program("self.onmessage = () => { postMessage({ error: 'no schedstat here' }); postMessage({ error: 'again' }); };"));
  w.start();
  expect(w.running).toBe(true);
  for (let i = 0; i < 100 && w.running; i++) await Bun.sleep(10);
  expect(w.running).toBe(false);
  expect(errors).toEqual(["The stall watcher stopped: no schedstat here"]);
  const t0 = performance.now();
  expect(await w.ask(3000, 3100)).toMatchObject({ kind: "unknown", text: "the watcher is off since it failed (see its own error)" });
  expect(performance.now() - t0).toBeLessThan(100);
  // It is not started again, and not reported again.
  w.start();
  expect(w.running).toBe(false);
  expect(errors.length).toBe(1);
});

test.skipIf(process.platform !== "linux")("a watcher whose thread dies while a stall waits for its word answers that stall and reports the failure", async () => {
  const errors: string[] = [];
  const w = new StallWatch(dirs, (e) => void errors.push((e as Error).message), program("self.onmessage = (ev) => { if (ev.data.ask) throw new Error('lost'); };"));
  w.start();
  const cause = await w.ask(2500, 2600);
  expect(cause.kind).toBe("unknown");
  expect(errors.length).toBe(1);
  expect(w.running).toBe(false);
});
