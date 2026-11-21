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

test.skipIf(process.platform !== "linux")("a watcher whose thread ends without a word is noticed and reported", async () => {
  const errors: string[] = [];
  const w = new StallWatch(dirs, (e) => void errors.push((e as Error).message), program("self.onmessage = () => { process.exit(0); };"));
  w.start();
  for (let i = 0; i < 200 && w.running; i++) await Bun.sleep(10);
  expect(w.running).toBe(false);
  expect(errors).toEqual(["The stall watcher stopped: its thread ended"]);
  expect((await w.ask(2500, 2600)).text).toBe("the watcher is off since it failed (see its own error)");
});

test.skipIf(process.platform !== "linux")("a watcher that goes silent is given up after two stalls it did not answer, and no row waits for it after that", async () => {
  const errors: string[] = [];
  const w = new StallWatch(dirs, (e) => void errors.push((e as Error).message), program("self.onmessage = () => {};"), 40);
  w.start();
  expect((await w.ask(2500, 2600)).text).toBe("the watcher did not answer in time");
  expect([w.running, errors.length]).toEqual([true, 0]);
  expect((await w.ask(2500, 2600)).text).toBe("the watcher did not answer in time");
  expect(w.running).toBe(false);
  expect(errors).toEqual(["The stall watcher stopped: it did not answer 2 stalls in a row"]);
  const t0 = performance.now();
  expect((await w.ask(2500, 2600)).kind).toBe("unknown");
  expect(performance.now() - t0).toBeLessThan(30);
});

test.skipIf(process.platform !== "linux")("a watcher that was stopped is not reported for ending, and drops only its own beat", async () => {
  const errors: string[] = [];
  const w = new StallWatch(dirs, (e) => void errors.push((e as Error).message), program("self.onmessage = () => {};"));
  w.start();
  w.stop();
  await Bun.sleep(100);
  expect(errors).toEqual([]);
  w.start();
  expect(w.running).toBe(false);
});

test.skipIf(process.platform !== "linux")("a pause that ends with a SIGCONT is a signal's, whatever else the watcher could say of it", async () => {
  const cause = { kind: "stopped", key: "stopped", sampled_ms: 3000, text: "3.0 s not running: stopped, or waiting for memory (the memory stall grew 0.4 s meanwhile)", shares: [{ kind: "stopped", key: "stopped", what: "not running: stopped, or waiting for memory (the memory stall grew 0.4 s meanwhile)", ms: 3000 }] };
  const w = new StallWatch(dirs, () => {}, program(`self.onmessage = (ev) => { if (ev.data.ask) postMessage({ id: ev.data.ask, cause: ${JSON.stringify(cause)} }); };`));
  w.start();
  try {
    // No signal: the watcher's words stand.
    expect((await w.ask(3000, 3100)).text).toBe(cause.text);
    process.kill(process.pid, "SIGCONT");
    for (let i = 0; i < 50 && !(w as unknown as { continued: number }).continued; i++) await Bun.sleep(5);
    const c = await w.ask(3000, 3100);
    expect(c).toMatchObject({ cont: true, text: "3.0 s stopped by a signal (continued by SIGCONT)", shares: [{ kind: "stopped", what: "stopped by a signal (continued by SIGCONT)", ms: 3000 }] });
  } finally {
    w.stop();
  }
});
