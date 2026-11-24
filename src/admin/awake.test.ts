// The keep-awake lock is one process for as long as any session works: the
// count of working sessions changes what is shown, never the lock.
import { expect, test } from "bun:test";
import { Bus } from "../core/bus.ts";
import { Awake, forTurns } from "./awake.ts";

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
  // The reason a hold of turns gives is told apart from any other (the activity list leaves a short one out).
  expect(forTurns(awake.state().reason!)).toBe(true);
  expect(forTurns("loop due within 15 minutes")).toBe(false);
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

// A server reached over ssh has a logind that gives this account no lock: the
// answer comes at once, every time. It is how the machine is, so it is asked
// once and no error is recorded for a turn; a hold the owner asks for asks again.
test("a lock logind refuses at once is not asked again at every turn, and is no error of a turn", async () => {
  const bus = new Bus();
  const captured: string[] = [];
  let asked = 0;
  const refusing = () => {
    asked++;
    return { stdin: { end: () => {} }, stderr: new Response("Failed to inhibit: Access denied\n").body, exitCode: 1, exited: Promise.resolve(1), kill: () => {} } as any;
  };
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  try {
    const awake = new Awake(bus, (e) => void captured.push((e as Error).message), refusing);
    const turn = async (id: string) => {
      bus.emit({ t: "session", session: { id, phase: "working" } } as any);
      await Bun.sleep(20);
      bus.emit({ t: "session", session: { id, phase: "idle" } } as any);
    };
    for (const id of ["s1", "s2", "s3"]) await turn(id);
    expect(asked).toBe(1);
    expect(captured).toEqual([]);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("Failed to inhibit: Access denied");
    // The daemon's state says it, between turns too.
    expect(awake.state()).toMatchObject({ available: false, held: false, refused: "Failed to inhibit: Access denied" });
    // The owner asks for a hold: logind is asked again, and that refusal is theirs to see.
    awake.hold(Date.now() + 60_000);
    await Bun.sleep(20);
    expect(asked).toBe(2);
    expect(captured).toEqual(["keep-awake refused: Failed to inhibit: Access denied"]);
    awake.hold(null);
    awake.stopAll();
  } finally { console.warn = warn; }
});
