// The fleet pause: one switch that holds every start the owner did not make (the engine's stepHold), a turn
// of the owner's own goes on, a resume frees what waits and every page hears each change once.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "keel-fleet-pause-"));
process.env.KEEL_CONFIG_DIR ??= join(dir, "config"); // before any Keel source is loaded
const { Bus } = await import("../core/bus.ts");
const { Store } = await import("../core/store.ts");
const core = await import("./core.ts");
const fleet = await import("./fleet-pause.ts");

const store = new Store(join(dir, "state"));
const bus = new Bus();
const frames: unknown[] = [];
bus.on((f: any) => { if (f.t === "feature" && f.name === "fleet_pause") frames.push(f.data); });
const running = new Map<string, { parent?: string; owner: boolean }>();
const stopped: [string, string][] = [];
const engine = {
  runningIds: () => [...running.keys()],
  byOwner: (id: string) => running.get(id)!.owner,
  interrupt: async (id: string, by: string) => { stopped.push([id, by]); running.delete(id); },
};
core.setDeps({ store, bus, errors: { capture() {} }, engine, providers: {} } as any);
fleet.listen();
const sess = (parent = false) => ({ id: "s", parent_id: parent ? "p" : null }) as any;

test("paused, a turn the owner did not start waits, the owner's own turn does not, a resume frees the waiting", async () => {
  expect(fleet.hold(sess(), () => false)).toBeUndefined();
  const r = await fleet.pause();
  expect(r.state.paused).toBe(true);
  expect(typeof r.state.since).toBe("number");
  expect(fleet.hold(sess(), () => false)!.wait).toBeDefined();
  // An agent's turn is held even when the owner's words started its work.
  expect(fleet.hold(sess(true), () => true)!.wait).toBeDefined();
  expect(fleet.hold(sess(), () => true)).toBeUndefined();
  const held = fleet.hold(sess(), () => false)!;
  expect(held.why).toBe("the fleet is paused");
  // A wait ends with its signal.
  const stop = new AbortController();
  const aborted = held.wait(stop.signal);
  stop.abort();
  await aborted;
  let freed = false;
  const waits = fleet.hold(sess(), () => false)!.wait(new AbortController().signal).then(() => { freed = true; });
  await Bun.sleep(10);
  expect(freed).toBe(false);
  expect(fleet.resume()).toEqual({ paused: false, since: null });
  await waits;
  expect(freed).toBe(true);
  expect(fleet.hold(sess(), () => false)).toBeUndefined();
  // Each change is one frame; a repeat is none.
  fleet.resume();
  expect(frames).toEqual([{ paused: true, since: expect.any(Number) }, { paused: false, since: null }]);
});

test("pausing with stop_running ends the unattended turns running now and no turn of the owner's", async () => {
  running.set("loop", { owner: false });
  running.set("mine", { owner: true });
  running.set("agent", { parent: "mine", owner: true });
  const sessions = { loop: { id: "loop", parent_id: null }, mine: { id: "mine", parent_id: null }, agent: { id: "agent", parent_id: "mine" } } as Record<string, any>;
  (store as any).session = (id: string) => sessions[id];
  const r = await fleet.pause(true);
  expect(r.stopped.sort()).toEqual(["agent", "loop"]);
  expect(stopped.sort()).toEqual([["agent", "pause"], ["loop", "pause"]]);
  expect([...running.keys()]).toEqual(["mine"]);
  fleet.resume();
});
