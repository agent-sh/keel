// The keep-awake lock is one process for as long as any session works: the
// count of working sessions changes what is shown, never the lock.
import { expect, test } from "bun:test";
import { Bus } from "../core/bus.ts";
import { Awake } from "./awake.ts";

test("one inhibitor is held while any session works, whatever their count", async () => {
  const bus = new Bus();
  const locks: { ended: boolean; end: () => void }[] = [];
  const lock = () => {
    let done = (_code: number) => {};
    const l = { ended: false, end: () => { l.ended = true; done(0); } };
    locks.push(l);
    return { stdin: { end: () => {} }, stderr: undefined, exitCode: null, exited: new Promise<number>((r) => { done = r; }), kill: () => l.end() } as any;
  };
  const awake = new Awake(bus, () => {}, lock);
  const reasons: (string | undefined)[] = [];
  bus.on((f) => { if (f.t === "feature" && f.name === "awake") reasons.push((f.data as any).reason); });
  const phase = (id: string, phase: "working" | "idle") => bus.emit({ t: "session", session: { id, phase } } as any);
  const held = () => locks.filter((l) => !l.ended).length;

  // Twelve sessions start and end turns in every order: one lock, taken once.
  for (let n = 0; n < 12; n++) phase(`s${n}`, "working");
  for (let round = 0; round < 20; round++) {
    for (let n = 0; n < 12; n++) { phase(`s${n}`, "idle"); phase(`s${(n + 5) % 12}`, "working"); phase(`s${n}`, "working"); }
  }
  expect(locks).toHaveLength(1);
  expect(held()).toBe(1);
  expect(awake.state()).toMatchObject({ held: true, reason: "12 turns running" });
  // What is shown follows the count.
  phase("s0", "idle");
  expect(awake.state().reason).toBe("11 turns running");
  expect(reasons.at(-1)).toBe("11 turns running");
  expect(locks).toHaveLength(1);
  // The last turn ends: the lock is given back. The next turn takes a new one.
  for (let n = 1; n < 12; n++) phase(`s${n}`, "idle");
  expect(held()).toBe(0);
  expect(awake.state().held).toBe(false);
  phase("s3", "working");
  expect(locks).toHaveLength(2);
  expect(held()).toBe(1);
  // A hold by the owner while a turn runs, and its end, keep the same lock.
  awake.hold(Date.now() + 60_000);
  awake.hold(null);
  expect(locks).toHaveLength(2);
  expect(held()).toBe(1);
  awake.stopAll();
  expect(held()).toBe(0);
});
