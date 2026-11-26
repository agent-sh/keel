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
const tools = await import("./tools.ts");

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

// An agent the owner's word reaches is not held: one his turn started (its task carries `owned`), one an owner's
// turn waits on, one whose tools run on another machine; and his message to a held agent frees it.
test("an agent the owner's word reaches goes on; his message to a held agent frees it", async () => {
  const { store, bus, engine, requests, session } = rig(join(dir, "state2"));
  core.setDeps({ store, bus, engine, errors: { capture() {} }, providers: {} } as any);
  loadHold.reset();
  load = 36;
  let clock = 5_000_000;
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id) ON DELETE CASCADE");
  const top = session();
  const agent = () => { const a = session(); store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(top.id, a.id); return store.session(a.id)!; };
  const owned = agent();
  const loose = agent();
  let armed = true;
  const waiting = Promise.withResolvers<void>();
  registerHooks({
    stepHold: (s, byOwner) => {
      if (s.id !== loose.id) return undefined;
      if (armed) { armed = false; clock = minute(clock); }
      const h = loadHold.hold(s, byOwner);
      if (h) waiting.resolve();
      return h;
    },
  });
  // The agent no owner's word reached is held, with the wait's shape for its cache plan.
  engine.send(loose.id, "a task from a loop", { meta: { kind: "task" } });
  await waiting.promise;
  expect(loadHold.state(clock).held.map((h) => h.key)).toEqual([loose.id]);
  expect(loadHold.hold(loose, () => false)?.shape).toMatchObject({ kind: "load", deadline: expect.any(Number) });
  // In the same tree's machine, an agent the owner's turn started goes on.
  engine.send(owned.id, "a task from the owner's turn", { meta: { kind: "task", owned: true } });
  await engine.idle(owned.id);
  expect(requests).toHaveLength(1);
  expect(loadHold.hold(owned, () => engine.byOwner(owned.id))).toBeUndefined();
  // An agent an owner's turn waits on (the parent blocks on its agents), and one whose tools run elsewhere, go on.
  expect(loadHold.exempt(loose, (id) => id === top.id)).toBe(false);
  const free = Promise.withResolvers<void>();
  const blocked = tools.blocks({ sessionId: top.id, callId: "w1" }, () => free.promise);
  expect(loadHold.exempt(loose, (id) => id === top.id)).toBe(true);
  free.resolve();
  await blocked;
  expect(loadHold.exempt(loose, (id) => id === top.id)).toBe(false);
  expect(loadHold.exempt({ ...loose, machine: "build-box" }, () => false)).toBe(true);
  // The owner writes to the held agent from its card: its step goes at the next look, the load still high.
  engine.send(loose.id, "go on now", { mode: "steer" });
  await engine.idle(loose.id);
  expect(requests).toHaveLength(2);
  store.db.close();
}, 15_000);

// A tree held past the cap goes on, and its parent is told once.
test("a tree held past the cap goes on and its parent hears it once", async () => {
  const { store, bus, engine, requests, session } = rig(join(dir, "state3"));
  core.setDeps({ store, bus, engine, errors: { capture() {} }, providers: {} } as any);
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id) ON DELETE CASCADE");
  const failures = await import("./failures.ts");
  failures.migrate();
  const { MAX_WAIT_MS } = await import("./load-rules.ts");
  loadHold.reset();
  load = 36;
  let clock = 9_000_000;
  const top = session();
  const a = session();
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(top.id, a.id);
  let armed = true;
  const waiting = Promise.withResolvers<void>();
  registerHooks({
    stepHold: (s, byOwner) => {
      if (s.id !== a.id) return undefined;
      if (armed) { armed = false; clock = minute(clock); }
      const h = loadHold.hold(s, byOwner);
      if (h) waiting.resolve();
      return h;
    },
  });
  engine.send(a.id, "a task from a loop", { meta: { kind: "task" } });
  await waiting.promise;
  const before = requests.length;
  // Ten minutes on, the machine still over: the cap lets it go.
  for (let t = clock; t <= clock + MAX_WAIT_MS; t += SAMPLE_MS) loadHold.tick(t);
  await engine.idle(a.id);
  expect(requests.length).toBe(before + 1);
  const told = failures.recordOf(store, top.id);
  expect(told).toHaveLength(1);
  expect(JSON.stringify(told)).toContain("waited 10 min for the machine");
  store.db.close();
});

// The day's account outlives a restart: Health's "over the line N min in the last day" said only what the
// daemon had seen since it started, and a busy day restarts it several times an hour.
test("the day's time over the line and the trees that waited are kept across a restart", () => {
  const { store, bus, engine } = rig(join(dir, "state4"));
  core.setDeps({ store, bus, engine, errors: { capture() {} }, providers: {} } as any);
  loadHold.reset();
  load = 36;
  const clock = minute(20_000_000);
  load = 2;
  loadHold.tick(clock + 61_000);
  const day = loadHold.state(clock + 61_000).over_min_day;
  expect(day).toBeGreaterThanOrEqual(1);
  // A restart: the module's memory is gone, the store is the same.
  loadHold.reset();
  loadHold.tick(clock + 70_000);
  expect(loadHold.state(clock + 70_000).over_min_day).toBe(day);
  store.db.close();
});
