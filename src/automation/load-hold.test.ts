// The load hold on the real engine: while the machine stays over its thread count a turn nobody at the keyboard
// started waits before its model step, with the load in its status, and goes on when the load falls; the owner's
// own turn is never held.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "keel-load-hold-"));
process.env.KEEL_CONFIG_DIR ??= join(dir, "config"); // before any Keel source is loaded
const { rig } = await import("../engine/delivery.fixture.ts");
const { allHooks, registerHooks } = await import("../engine/hooks.ts");
const core = await import("./core.ts");
const loadHold = await import("./load-hold.ts");
const { machine } = await import("../tools/heavy.ts");
const { SAMPLE_MS, SETTLE_MS } = await import("./load-rules.ts");

const hooksAtStart = allHooks().length;
const readAtStart = machine.read;
afterAll(() => { allHooks().length = hooksAtStart; machine.read = readAtStart; loadHold.reset(); rmSync(dir, { recursive: true, force: true }); });

let load = 36;
machine.read = () => ({ cores: 24, load1: load, mem_available_mb: 32_000 });
// A minute of the pulse's readings, from `from` on.
const minute = (from: number) => { for (let t = from; t <= from + SETTLE_MS; t += SAMPLE_MS) loadHold.tick(t); return from + SETTLE_MS; };

test("an unattended turn waits for the machine with the load in its status, and goes on when the load falls", async () => {
  const { store, bus, engine, requests, session } = rig(join(dir, "state"));
  core.setDeps({ store, bus, engine, errors: { capture() {} }, providers: {} } as any);
  loadHold.reset();
  const statuses: any[] = [];
  bus.on((f: any) => { if (f.t === "status" && f.status.kind === "model" && f.status.limit) statuses.push(f.status.limit); });
  let clock = 1_000_000;
  let first = true;
  const waiting = Promise.withResolvers<void>();
  registerHooks({
    stepHold: (s, byOwner) => {
      // The turn runs now, so its tree is known: a minute over the line holds it.
      if (first) { first = false; clock = minute(clock); }
      const h = loadHold.hold(s, byOwner);
      if (h) waiting.resolve();
      return h;
    },
  });
  const wake = session();
  engine.send(wake.id, "a timer's wake", { meta: { kind: "wake" } });
  await waiting.promise;
  await Bun.sleep(20);
  expect(requests).toHaveLength(0);
  expect(statuses.at(-1)).toEqual({ why: "the machine is busy: load 36 on 24 threads", spend: "load" });
  expect(loadHold.state(clock).held.map((h) => h.key)).toEqual([wake.id]);
  // The owner's own turn in another session goes on while the wake waits.
  const mine = session();
  engine.send(mine.id, "the owner's own words");
  await engine.idle(mine.id);
  expect(requests).toHaveLength(1);
  // The load falls: after the minute that follows the hold the tree is let go and its step is sent.
  load = 4;
  clock = minute(clock);
  await engine.idle(wake.id);
  expect(requests).toHaveLength(2);
  expect(loadHold.state(clock).held).toEqual([]);
  expect(loadHold.state(clock).waited).toHaveLength(1);
  expect(loadHold.healthRows(clock)[0]).toMatchObject({ id: "machine:load", level: "ok", title: "the machine has room: load 4 on 24 threads" });
  store.db.close();
});
