// A parent the owner stopped, with the real engine and the turn-end hook as
// index.ts wires it: what the hold does to its agents' reports cannot be shown
// with a stand-in engine, since the hold and the turns it lets through are the
// engine's own.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "keel-agents-held-"));
process.env.KEEL_CONFIG_DIR ??= join(dir, "config"); // before any Keel source is loaded
const { Bus } = await import("../core/bus.ts");
const { Store } = await import("../core/store.ts");
const { registerHooks } = await import("../engine/hooks.ts");
const { Engine } = await import("../engine/turn.ts");
const core = await import("./core.ts");
const agents = await import("./agents.ts");
const failures = await import("./failures.ts");
const goals = await import("./goals.ts");
const waits = await import("./waits.ts");
const activity = await import("./activity.ts");
const { handleLine } = await import("../integrations/momentum.ts");
const { Voice } = await import("../integrations/voice.ts");

const store = new Store(join(dir, "state"));
const bus = new Bus();
const info = { id: "m:x", model: "x", name: "x", family: "gpt", context: 100_000, output: 64, efforts: [], tools: true };
const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
// A parent's request named here hangs until its turn is stopped, or waits for the promise given for it;
// an agent's answers at once, or once `gate` opens.
const hangs = new Set<string>();
const pauses = new Map<string, Promise<void>>();
let gate: Promise<void> | undefined;
const provider = {
  wire: "openai",
  stream: async (req: any) => {
    const pause = pauses.get(req.sessionKey);
    if (hangs.delete(req.sessionKey)) await new Promise((_r, rej) => req.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
    else if (pause) { pauses.delete(req.sessionKey); await pause; }
    else if (store.session(req.sessionKey)?.parent_id) await gate;
    return { blocks: [{ type: "text", text: "ok" }], usage, stop: "end_turn", model: "x" };
  },
};
const engine = new Engine(store, bus, { models: async () => [info], current: () => [info], resolve: async () => ({ provider, info }) } as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
(engine as any).step = async () => ({ provider, info, tools: [], system: "s", systemSplit: 0, native: false });
core.setDeps({ store, bus, errors: { capture() {} }, engine, providers: { models: async () => [info], resolve: async () => ({ provider, info }), current: () => [info] } } as any);
store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT"); // the fleet adds it in the daemon
agents.migrate();
waits.migrate();
activity.migrate();
goals.migrate();
failures.init();
registerHooks({
  turnStart: (s) => agents.onTurnStart(s.id),
  turnEnd: (s, reason) => {
    core.afterTurn(s.id, () => {
      failures.onTurnEnd(s.id, reason);
      failures.wake(s.id);
      agents.onTurnEnd(s.id, reason);
      if (!store.session(s.id)?.parent_id) goals.afterTurn(s.id, reason, { judge: false }).catch(() => {});
    });
  },
});
bus.on((f) => { if (f.t === "queue") agents.onQueue(f); });

// The inputs a session got: the kind of each, and the agents whose reports it carried.
const inputs = (id: string) => store.events(id).filter((e) => e.kind === "user").map((e) => {
  const parts = (e.data.parts ?? [e.data]) as { kind?: string; agent_id?: string }[];
  return { kinds: parts.map((p) => p.kind ?? "owner"), reports: parts.filter((p) => p.kind === "subagent").map((p) => p.agent_id), text: String(e.data.text) };
});
const reports = (id: string) => inputs(id).flatMap((i) => i.reports);
const until = async (f: () => boolean, ms = 3000) => { for (let i = 0; i < ms / 10 && !f(); i++) await Bun.sleep(10); return f(); };
// Nothing runs in the session, and nothing lined up for it started a turn since.
const quiet = async (id: string) => { await until(() => !engine.isRunning(id)); await Bun.sleep(450); await until(() => !engine.isRunning(id)); };
const owed = (id: string) => store.db.query("SELECT report_id FROM agent_owed WHERE parent_id = ?").all(id).length;
const lane = async (parentId: string, prompt: string) => {
  const a = await agents.spawn(parentId, { prompt, isolation: "none", background: true });
  return { ...a, ended: () => until(() => agents.isEnded(agents.get(a.id)!)) };
};

// A parent the owner stopped while its first turn hung, with `n` agents whose reports ride.
const heldWith = async (title: string, n: number) => {
  const p = store.createSession({ model: "m:x", workspace: dir, title });
  engine.send(p.id, "owner: warm"); // a first answer, so its agents do not wait for each other's cache
  await quiet(p.id);
  hangs.add(p.id);
  engine.send(p.id, "owner: start");
  await until(() => engine.isRunning(p.id));
  const lanes = [];
  for (let i = 0; i < n; i++) lanes.push(await lane(p.id, `${title} lane ${i}`));
  await engine.interrupt(p.id, "owner");
  for (const l of lanes) await l.ended();
  await quiet(p.id);
  expect([engine.isHeld(p.id), owed(p.id), reports(p.id)]).toEqual([true, n, []]);
  return { p, lanes };
};
const wake = (id: string, n = 1) => core.deliver(id, `<wait_fired id="w${n}" kind="timer" outcome="fired">\ntimer\n</wait_fired>`, { kind: "wait", wait_id: `w${n}`, outcome: "fired" });

// The owner stopped a coordinator's turn once. Its agents finish, and it goes
// on by harness inputs alone (a wait that fires, the goal resumed): it gets
// every report, each once, and none of them starts a turn while it is held.
test("a held parent that goes on by harness inputs gets its agents' reports, each once", async () => {
  const p = store.createSession({ model: "m:x", workspace: dir, title: "coordinator" });
  hangs.add(p.id);
  await goals.set(p.id, { objective: "ship it" }); // its first turn hangs in the model
  await until(() => engine.isRunning(p.id));
  const a = await lane(p.id, "lane one");
  await engine.interrupt(p.id, "owner");
  await a.ended();
  await quiet(p.id);
  expect([engine.isHeld(p.id), goals.get(p.id)!.status]).toEqual([true, "paused"]);
  expect(inputs(p.id).map((i) => i.kinds)).toEqual([["goal"]]); // the report started no turn
  expect(owed(p.id)).toBe(1);

  // A wait of the coordinator fires: the hold stays, and the report comes with the wake.
  core.deliver(p.id, "<wait_fired>timer</wait_fired>", { kind: "wait", wait_id: "w1", outcome: "fired" });
  await quiet(p.id);
  expect(engine.isHeld(p.id)).toBe(true);
  expect(inputs(p.id).at(-1)).toMatchObject({ kinds: ["wait", "subagent"], reports: [a.id] });
  expect(owed(p.id)).toBe(0);

  // The next agent finishes in the held parent: no turn, until the owner resumes the goal.
  const b = await lane(p.id, "lane two");
  await b.ended();
  await quiet(p.id);
  expect(inputs(p.id)).toHaveLength(2);
  await goals.patch(p.id, { status: "pursuing" }); // the owner's own resume: the hold ends
  await quiet(p.id);
  expect(engine.isHeld(p.id)).toBe(false);
  expect(reports(p.id)).toEqual([a.id, b.id]);

  // Not held any more: the next report starts a turn by itself.
  const c = await lane(p.id, "lane three");
  await c.ended();
  await quiet(p.id);
  expect(inputs(p.id).at(-1)).toMatchObject({ kinds: ["subagent"], reports: [c.id] });
  expect(reports(p.id)).toEqual([a.id, b.id, c.id]);
  expect(owed(p.id)).toBe(0);
}, 60_000);

// A hold that ends with no turn (the owner resumes an empty queue, a session
// moved here in the middle of a turn): what was held goes then. The timers the
// parent set while its agents ran are cancelled when the last report is sent
// and says so, not while it is held.
test("a hold released with no turn sends the held report, and the report ends the parent's timers when it is sent", async () => {
  const p = store.createSession({ model: "m:x", workspace: dir, title: "released" });
  hangs.add(p.id);
  engine.send(p.id, "owner: start");
  await until(() => engine.isRunning(p.id));
  let open!: () => void;
  gate = new Promise<void>((r) => (open = r));
  const a = await lane(p.id, "lane");
  const timer = waits.create(p.id, waits.normalize({ kind: "timer", seconds: 600 }, dir)); // set while the agent runs
  await engine.interrupt(p.id, "owner");
  open();
  gate = undefined;
  await a.ended();
  await quiet(p.id);
  expect([engine.isHeld(p.id), owed(p.id), reports(p.id)]).toEqual([true, 1, []]);
  expect(waits.get(timer.id)!.status).toBe("active"); // the held coordinator keeps its timer

  engine.resumeQueue(p.id); // the queue's Resume with nothing queued
  await quiet(p.id);
  expect([engine.isHeld(p.id), owed(p.id), reports(p.id)]).toEqual([false, 0, [a.id]]);
  expect(inputs(p.id).at(-1)!.text).toContain(`The timer wait ${timer.id} you set while your agents ran is cancelled`);
  expect(waits.get(timer.id)!.status).toBe("cancelled");
}, 60_000);

// The owner types while a harness turn runs in the held parent: the words join
// that turn as a steer. They are the owner's own, so the hold ends with them
// as it does for a prompt typed while idle, and reports go on as usual.
test("the owner's steer into a harness turn of a held parent ends the hold", async () => {
  const { p, lanes } = await heldWith("steered", 1);
  let open!: () => void;
  pauses.set(p.id, new Promise<void>((r) => (open = r)));
  wake(p.id);
  await until(() => engine.isRunning(p.id));
  expect(engine.send(p.id, "owner: typed while it runs")).toMatchObject({ steer: true });
  open();
  await quiet(p.id);
  expect(engine.isHeld(p.id)).toBe(false);
  const b = await lane(p.id, "steered lane b");
  await b.ended();
  await quiet(p.id);
  expect(reports(p.id)).toEqual([lanes[0]!.id, b.id]);
  expect(owed(p.id)).toBe(0);
}, 60_000);

// A momentum steer is not the owner's word: it starts a turn in the idle held
// parent and the hold stays, so the reports that ride go with it. The owner's
// speech is the owner's word: the hold ends and the next report arrives.
test("a momentum steer carries a held parent's reports, and the owner's speech ends the hold", async () => {
  const { p, lanes } = await heldWith("spoken", 2);
  let open!: () => void;
  gate = new Promise<void>((r) => (open = r));
  const c = await lane(p.id, "spoken lane c"); // still at work when the steer goes in
  const sent = handleLine(JSON.stringify({ cmd: "supervise_act", session_id: p.id, action: "steer", text: "look at lane 0" }), { store, engine, deliver: core.deliver });
  expect(sent).toMatchObject({ ok: true });
  await quiet(p.id);
  expect(engine.isHeld(p.id)).toBe(true);
  expect(inputs(p.id).at(-1)).toMatchObject({ reports: lanes.map((l) => l.id) });
  expect(inputs(p.id).at(-1)!.text).toStartWith("[momentum] look at lane 0");
  // A held parent is not told a report will wake it: it will not.
  expect(inputs(p.id).at(-1)!.text).toEndWith("1 more of your agents is still running; the owner stopped this session, so its report does not wake you: it comes with your next input.");
  expect(owed(p.id)).toBe(0);

  open();
  gate = undefined;
  await c.ended();
  await quiet(p.id);
  expect(reports(p.id)).toHaveLength(2); // it rides
  const voice = new Voice("parlar", store, engine, bus, { capture() {} } as any);
  (voice as any).deliver(p.id, "spoken words");
  await quiet(p.id);
  await quiet(p.id);
  expect(engine.isHeld(p.id)).toBe(false);
  expect(reports(p.id)).toEqual([...lanes.map((l) => l.id), c.id]);
  expect(owed(p.id)).toBe(0);
}, 60_000);

// Setting a goal is the owner's own act, as resuming one is: the hold a Stop
// left ends, and what rode comes with the goal's first input.
test("a goal set on a held session ends the hold", async () => {
  const { p, lanes } = await heldWith("new goal", 1);
  await goals.set(p.id, { objective: "ship it" });
  await quiet(p.id);
  expect(engine.isHeld(p.id)).toBe(false);
  expect(reports(p.id)).toEqual([lanes[0]!.id]);
  expect(owed(p.id)).toBe(0);
}, 60_000);
