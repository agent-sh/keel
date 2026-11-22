// Who stopped a turn, and what follows from it: with the real engine and the
// automation wired as the daemon wires it, since the hold, the goal's pause,
// a loop run's outcome and what wakes a session are decided between them.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "keel-stoppers-"));
process.env.KEEL_CONFIG_DIR ??= join(dir, "config"); // before any Keel source is loaded
const { Bus } = await import("../core/bus.ts");
const { Store } = await import("../core/store.ts");
const { STOPPERS, heldSays, holds, ownerStop, stopSays } = await import("../core/stoppers.ts");
const { allHooks, registerHooks } = await import("../engine/hooks.ts");
const { Engine } = await import("../engine/turn.ts");
const { stopLine } = await import("../admin/daemon-log.ts");
const { outcomeOf } = await import("../admin/outcomes.ts");
const { turnRow } = await import("../admin/timeline-rows.ts");
const core = await import("./core.ts");
const agents = await import("./agents.ts");
const failures = await import("./failures.ts");
const goals = await import("./goals.ts");
const loops = await import("./loops.ts");
const waits = await import("./waits.ts");
const activity = await import("./activity.ts");

const store = new Store(join(dir, "state"));
const bus = new Bus();
const info = { id: "m:x", model: "x", name: "x", family: "gpt", context: 100_000, output: 64, efforts: [], tools: true };
const usage = { input: 1, output: 1, cache_read: 0, cache_write: 0 };
// A request of a session named here hangs until its turn is stopped (a judge's own request: for good).
const hangs = new Set<string>();
// What a session's next request does instead of answering: throw this, or call these tools first.
const throws = new Map<string, () => unknown>();
const calls = new Map<string, { name: string; input: unknown }[]>();
let requests = 0;
const provider = {
  wire: "openai",
  stream: async (req: any) => {
    requests++;
    const id = req.sessionKey as string;
    if (hangs.has(id)) await new Promise((_r, rej) => (req.signal.aborted ? rej(new Error("aborted")) : req.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true })));
    const boom = throws.get(id);
    if (boom) { throws.delete(id); throw boom(); }
    const uses = calls.get(id);
    if (uses) { calls.delete(id); return { blocks: uses.map((u, i) => ({ type: "tool_use", id: `c${i}`, name: u.name, input: u.input })), usage, stop: "tool_use", model: "x" }; }
    return { blocks: [{ type: "text", text: "ok" }], usage, stop: "end_turn", model: "x" };
  },
};
// A tool whose own time limit passes: an abort that is not the turn's.
const slowTool = { name: "Slow", description: "waits on something with a time limit of its own", input_schema: { type: "object", properties: {} },
  run: async () => { await new Promise((_r, rej) => { const s = AbortSignal.timeout(20); s.addEventListener("abort", () => rej(s.reason), { once: true }); }); return { content: "never" }; } };
const captured: string[] = [];
const errors = { capture: (_s: string, e: unknown) => { captured.push(String((e as any)?.message ?? e)); return { id: "e", message: String((e as any)?.message ?? e) }; } };
const providers = { models: async () => [info], current: () => [info], resolve: async () => ({ provider, info }) };
const engine = new Engine(store, bus, providers as any, errors as any, join(dir, "spill"));
// What is set up before a turn's first step (the system prompt's hooks, the tools): `setup` stands in for one that fails.
const setup = new Map<string, () => unknown>();
(engine as any).step = async (s: { id: string }) => {
  const boom = setup.get(s.id);
  if (boom) { setup.delete(s.id); throw boom(); }
  return { provider, info, tools: [slowTool], system: "s", systemSplit: 0, native: false };
};
core.setDeps({ store, bus, errors, engine, providers } as any);
store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT"); // the fleet adds it in the daemon
agents.migrate();
waits.migrate();
activity.migrate();
goals.migrate();
loops.migrate();
failures.init();
const hooksBefore = allHooks().length;
afterAll(() => { allHooks().length = hooksBefore; });
// As src/automation/index.ts wires them.
registerHooks({
  turnStart: (s) => agents.onTurnStart(s.id),
  closingOver: (id) => core.flush(id),
  turnEnd: (s, reason) => {
    core.afterTurn(s.id, () => {
      failures.onTurnEnd(s.id, reason);
      failures.wake(s.id);
      loops.onTurnEnd(s.id, reason);
      agents.onTurnEnd(s.id, reason);
      if (!store.session(s.id)?.parent_id) goals.afterTurn(s.id, reason).catch(() => {});
    });
  },
});
bus.on((f) => { if (f.t === "queue") agents.onQueue(f); });
const rejected: unknown[] = [];
const onRejection = (e: unknown) => void rejected.push(e);
process.on("unhandledRejection", onRejection);
afterAll(() => void process.off("unhandledRejection", onRejection));

const open = (title: string) => store.createSession({ model: "m:x", workspace: dir, title }).id;
const until = async (f: () => boolean, ms = 3000) => { for (let i = 0; i < ms / 10 && !f(); i++) await Bun.sleep(10); return f(); };
const ends = (id: string) => store.events(id).filter((e) => e.kind === "turn_end").map((e) => [e.data.reason, e.data.stopped_by] as [string, string | undefined]);
const inputs = (id: string) => store.events(id).filter((e) => e.kind === "user").map((e) => (e.data.parts ?? [e.data]).map((p: any) => p.kind ?? p.origin ?? "owner").join("+"));
const stop = (id: string, by: string) => engine.interrupt(id, by);
const settle = async (id: string) => { await engine.idle(id); await Bun.sleep(60); };

test("every stopper has its sentence, and only the owner's is said of the owner", () => {
  for (const [by, s] of Object.entries(STOPPERS)) {
    expect(stopLine(by)).toBe(`[turn] ${s.says}`);
    // The owner is named where the owner did it: their Stop, and the message of theirs that took the turn's place.
    expect(s.says.includes("the owner")).toBe(!!s.owner || !!s.replaces);
    expect(outcomeOf("interrupted", by)).toBe(s.owner ? "stopped_by_owner" : s.parent ? "stopped_by_parent" : "stopped");
  }
  // A stop nobody named (an end from before every stop was named) is a stop, and nobody's. It read "stopped by the owner".
  expect([stopLine(undefined), stopSays(null), outcomeOf("interrupted", undefined), outcomeOf("interrupted", null)]).toEqual(["[turn] stopped", "stopped", "stopped", "stopped"]);
  const row = (by?: string) => turnRow({ start: { id: "t", ts: 1 }, opener: { origin: "restart" }, end: { reason: "interrupted", stopped_by: by }, steps: 0, tools: 0, failed_tools: 0 } as any).text;
  expect(row()).toBe("Resumed after a daemon restart, stopped before its first step");
  expect(row("owner")).toBe("Resumed after a daemon restart, stopped by the owner before its first step");
  expect(row("send_now")).toBe("Resumed after a daemon restart, ended when the owner sent a new message before its first step");
  expect(row("supervisor")).toBe("Resumed after a daemon restart, stopped by the supervisor before its first step");
  // A hold nobody named is from before stops were named, when only the owner's Stop left one.
  expect([heldSays(null), heldSays("owner"), heldSays("handoff")]).toEqual(["the owner stopped this session", "the owner stopped this session", "this session is being moved"]);
});

// One case per stopper: the word is stored on the turn's end, and what follows is the owner's Stop's
// alone. Each has a session with a goal, one whose turn is a loop's run, and one with an agent out.
for (const by of ["owner", "phone", "supervisor", "hook", "api", "review", "handoff", "archive"]) {
  test(`a turn stopped by "${by}" keeps that word, and ${ownerStop(by) ? "the owner's Stop holds the queue, pauses the goal and keeps reports from waking the session" : "nothing else of the session is stopped"}`, async () => {
    const mine = ownerStop(by);
    // A move and an archive keep the queue waiting for their own time, and say so.
    const waits = holds(by);
    // --- a goal
    const g = open(`goal ${by}`);
    hangs.add(g);
    await goals.set(g, { objective: "ship it" });
    expect(await until(() => engine.isRunning(g))).toBe(true);
    await stop(g, by);
    await settle(g);
    expect(ends(g)[0]).toEqual(["interrupted", by]);
    expect(engine.isHeld(g)).toBe(waits);
    expect(engine.heldBy(g)).toBe(waits ? by : undefined);
    // The owner's Stop pauses it; a stop that keeps the queue waiting does for its own time, and says which.
    // Anything else leaves it on. It was paused by all of them, as "the turn was stopped".
    expect([goals.get(g)!.status, goals.get(g)!.status_reason ?? null]).toEqual(mine ? ["paused", "the owner stopped the turn"] : waits ? ["paused", `the turn was ${stopSays(by)}`] : ["pursuing", null]);

    // --- a loop's run
    const l = open(`loop ${by}`);
    hangs.add(l);
    const { loop } = loops.create({ session_id: l, schedule: "1h", prompt: "tick" });
    loops.runNow(loop.id);
    expect(await until(() => engine.isRunning(l))).toBe(true);
    await stop(l, by);
    await settle(l);
    // Stopped, with who stopped it. Its detail read "interrupted", and its outcome was documented as the owner's stop.
    expect(loops.runs(loop.id).filter((r) => r.started_ms).map((r) => [r.outcome, r.detail])).toEqual([["stopped", stopSays(by)]]);
    expect(loops.get(loop.id)!.fails).toBe(0);

    // --- an agent's report
    const p = open(`parent ${by}`);
    engine.send(p, "owner: warm");
    await settle(p);
    hangs.add(p);
    engine.send(p, "owner: start");
    expect(await until(() => engine.isRunning(p))).toBe(true);
    const a = await agents.spawn(p, { prompt: `lane of ${by}`, isolation: "none", background: true });
    await stop(p, by);
    expect(await until(() => agents.isEnded(agents.get(a.id)!))).toBe(true);
    await Bun.sleep(500);
    const owed = store.db.query("SELECT report_id FROM agent_owed WHERE parent_id = ?").all(p).length;
    if (waits) {
      // Nothing starts in a held session: the report rides with its next input. Who made the hold is said, and the owner only for theirs.
      expect([inputs(p), owed, engine.isRunning(p)]).toEqual([["owner", "owner"], 1, false]);
      expect(core.stillRunning(1, core.heldWhy(p))).toContain(`${heldSays(by)}, so its report does not wake you`);
      expect(heldSays(by).includes("the owner")).toBe(mine);
    } else {
      // The report wakes the session as ever. (It rode, and the session was told "the owner stopped this session".)
      expect([inputs(p), owed]).toEqual([["owner", "owner", "subagent"], 0]);
      expect(core.heldWhy(p)).toBeUndefined();
      expect(core.stillRunning(1, core.heldWhy(p))).toContain("its report wakes you when ready");
    }
    for (const id of [g, l, p]) { hangs.delete(id); await engine.interrupt(id, "owner"); }
  }, 20_000);
}

// The owner's own message takes a running turn's place: a queued prompt they send now, a prompt they edit.
// That is their act and not a Stop. (The schedule of the report: a turn continued after a restart is still
// being set up; a peer's message waits in the queue; a wait has fired and an agent has reported.)
test("a queued prompt sent now ends the running turn as that, and the session goes on: no hold, the goal on, the wakes after it", async () => {
  const s = open("send now");
  hangs.add(s);
  await goals.set(s, { objective: "ship it" });
  expect(await until(() => engine.isRunning(s))).toBe(true);
  // A message of another session waits in the queue, and a wake is lined up behind the running turn.
  const queued = engine.send(s, "<external_input>from a peer</external_input>", { mode: "queue", meta: { kind: "peer" } }).queued!;
  core.deliver(s, "<wait_fired>timer</wait_fired>", { kind: "wait", wait_id: "w1", outcome: "fired" });
  const before = requests;
  hangs.delete(s);
  const sending = engine.sendNow(s, queued.id);
  expect(engine.startsNext(s)).toBe(true);
  await sending;
  await settle(s);
  await until(() => inputs(s).length === 3 && !engine.isRunning(s));
  // The stopped turn says what ended it, the owner's message is the next turn, and the wake comes after it:
  // it started a turn of its own between the two, which the same click then stopped as well.
  expect(ends(s).slice(0, 2)).toEqual([["interrupted", "send_now"], ["end_turn", undefined]]);
  expect(inputs(s).slice(0, 3)).toEqual(["goal", "peer", "wait"]);
  expect(stopLine(ends(s)[0]![1])).toBe("[turn] ended when the owner sent a new message");
  // Not a Stop: nothing is held, and the goal is on. (The queue was held as the owner's and the goal paused.)
  expect(engine.isHeld(s)).toBe(false);
  expect(goals.get(s)!.status).not.toBe("paused");
  expect(requests).toBeGreaterThan(before);
  await goals.patch(s, { status: "paused" }).catch(() => {});
  await engine.interrupt(s, "owner");
});

test("a prompt the owner edits ends the running turn as that, with the same: no hold, the goal on, nothing started in between", async () => {
  const s = open("edit");
  const first = engine.send(s, "owner: first").event!;
  await settle(s);
  hangs.add(s);
  await goals.set(s, { objective: "ship it" });
  expect(await until(() => engine.isRunning(s))).toBe(true);
  core.deliver(s, "<wait_fired>timer</wait_fired>", { kind: "wait", wait_id: "w2", outcome: "fired" });
  hangs.delete(s);
  await engine.edit(s, first.id, "owner: first, said better");
  await settle(s);
  await until(() => !engine.isRunning(s) && inputs(s).includes("wait"));
  expect(ends(s).find(([r]) => r === "interrupted")).toEqual(["interrupted", "edit"]);
  // One turn at a time: the edited prompt's, then the wake's (never two in the session at once).
  const kinds = store.lineage(s).filter((e) => e.kind === "turn_start" || e.kind === "turn_end").map((e) => e.kind);
  expect(kinds.join(" ")).toMatch(/^(turn_start turn_end ?)+$/);
  expect(engine.isHeld(s)).toBe(false);
  expect(goals.get(s)!.status).not.toBe("paused");
  await goals.patch(s, { status: "paused" }).catch(() => {});
});

// An abort that is not a stop of the turn: something of the turn gave up on its own time limit, or a
// connection was cut. The turn's end is "interrupted" only through Engine.interrupt.
test("an abort that is not the turn's own stop never ends the turn as stopped: it fails as what failed, or the turn goes on", async () => {
  const abort = () => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
  const timeout = () => new DOMException("The operation timed out.", "TimeoutError");
  // A provider whose request is aborted by a time limit of its own, or by a socket that closed.
  for (const [name, boom] of [["a provider's own time limit", timeout], ["a provider's request aborted", abort]] as const) {
    const s = open(name);
    throws.set(s, boom);
    engine.send(s, "go");
    await settle(s);
    expect(ends(s)).toEqual([["error", undefined]]);
    expect(store.events(s).some((e) => e.kind === "error")).toBe(true);
    expect(engine.isHeld(s)).toBe(false);
  }
  // What is set up before the first step (a hook of the system prompt, a server of tools) gives up the same way.
  for (const [name, boom] of [["a hook's time limit before the first step", timeout], ["a tool server's connect aborted", abort]] as const) {
    const s = open(name);
    setup.set(s, boom);
    engine.send(s, "go");
    await settle(s);
    expect(ends(s).filter(([r]) => r === "interrupted")).toEqual([]);
    expect(store.events(s).some((e) => e.kind === "error")).toBe(true);
    expect(engine.isHeld(s)).toBe(false);
    // And the session goes on with the next prompt.
    engine.send(s, "again");
    await settle(s);
    expect(ends(s).at(-1)).toEqual(["end_turn", undefined]);
  }
  // A tool whose own time limit passes: its call fails, and the turn goes on to its end.
  const t = open("a tool's own time limit");
  calls.set(t, [{ name: "Slow", input: {} }]);
  engine.send(t, "go");
  await settle(t);
  const results = store.events(t).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results as any[]);
  expect(results.map((r) => [r.is_error, String(r.content).includes("timed out")])).toEqual([[true, true]]);
  expect(ends(t)).toEqual([["end_turn", undefined]]);
  expect(rejected).toEqual([]);
});

// At a start: what arrives while a continued turn is being set up joins it or waits behind it.
test("an input that arrives while a continued turn is set up joins it or queues behind it, and never ends it", async () => {
  const s = open("continued");
  engine.send(s, "owner: go");
  await settle(s);
  // The turn a restart cut, and its continuation, whose setup takes a while (a memory store slow at a start).
  store.append(s, "user", { text: "owner: work" });
  store.append(s, "turn_start", { model: "m:x" });
  store.append(s, "turn_end", { reason: "restart", usage, ms: 5 });
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const step = (engine as any).step;
  (engine as any).step = async (x: { id: string }) => { if (x.id === s) await slow; return step(x); };
  try {
    engine.resume(s);
    expect(engine.isRunning(s)).toBe(true);
    // A wake, an agent's report, a peer's message and the owner's own words, all in that time.
    core.deliver(s, "<wait_fired>timer</wait_fired>", { kind: "wait", wait_id: "w3", outcome: "fired" });
    core.deliver(s, "<subagent_result>done</subagent_result>", { kind: "subagent", agent_id: "a1" });
    engine.send(s, "<external_input>from a peer</external_input>", { mode: "queue", meta: { kind: "peer" } });
    engine.send(s, "owner: one more thing");
    await Bun.sleep(50);
    expect(engine.isRunning(s)).toBe(true);
    release();
    await settle(s);
    await until(() => !engine.isRunning(s) && inputs(s).length >= 6);
  } finally { (engine as any).step = step; }
  // The continuation ran to its end, with the owner's words in it; the rest came after, each in a turn that ended by itself.
  const after = ends(s).slice(2);
  expect(after.map(([r]) => r)).toEqual(after.map(() => "end_turn"));
  expect(after.length).toBeGreaterThanOrEqual(2);
  expect(inputs(s).slice(2)).toEqual(expect.arrayContaining(["restart", "steer", "wait+subagent", "peer"]));
  expect(engine.isHeld(s)).toBe(false);
});
