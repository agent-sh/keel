// The store takes no writes (its disk does not answer and its log is at the ceiling:
// src/core/checkpoint.ts). Whatever the store's state, a running turn can be stopped, and a turn whose
// write fails ends in memory, stops what it still ran, and says why once the store takes writes again.
// A stand-in takes the provider's place.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { STOPPED_WHILE } from "../core/stops.ts";
import { Store } from "../core/store.ts";
import { lineage } from "../core/tree.ts";
import { allHooks } from "./hooks.ts";
import { Engine, instructionFilter } from "./turn.ts";

const MODEL = { id: "st:one", provider: "st", model: "one", name: "One", family: "other", context: 200_000, output: 1_000, efforts: [], billing: "per_token", tools: false };
const dirs: string[] = [];
// A line of the file of owed writes: its record, after its mark.
const record = (line: string) => JSON.parse(line.slice(line.indexOf(" ") + 1));
const hooksBefore = allHooks().length;
afterEach(() => {
  allHooks().length = hooksBefore;
  instructionFilter.file = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rig(stream: (req: any, store: Store) => Promise<any>) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "refusal-"));
  dirs.push(dir);
  instructionFilter.file = () => null;
  const store = new Store(dir);
  const failures: string[] = [];
  const provider = { id: "st", wire: "anthropic_messages", available: () => true, list: async () => [], stream: (req: any) => stream(req, store) };
  const providers = { resolve: async () => ({ provider, info: MODEL }), models: async () => [MODEL], current: () => [MODEL] };
  const errors = { capture: (_s: string, e: any) => { failures.push(String(e?.message ?? e)); return { id: "err", message: String(e?.message ?? e) }; } };
  const engine = new Engine(store, new Bus(), providers as any, errors as any, join(dir, "spill"));
  const id = store.createSession({ title: "Fixture", model: MODEL.id, workspace: dir }).id;
  const kinds = () => lineage(store.events(id), store.session(id)!.head).map((e) => (e.kind === "turn_end" ? `turn_end:${e.data.reason}${e.data.stopped_by ? `:${e.data.stopped_by}` : ""}` : e.kind));
  // What the checkpoint thread's owner does when the log is at its ceiling, and when the disk answers again.
  const refuse = (on: boolean) => { store.db.exec(`PRAGMA query_only = ${on ? "ON" : "OFF"}`); store.refuse(on); };
  const until = async (f: () => boolean) => { for (let n = 0; n < 600 && !f(); n++) await Bun.sleep(5); return f(); };
  return { store, engine, id, kinds, refuse, until, failures };
}

test("a running turn is stopped while the store takes no writes, and its end is written when the store takes writes again", async () => {
  let asked: AbortSignal | undefined;
  // A request that answers only when it is aborted: a turn at work.
  const r = rig((req) => new Promise((_, no) => { asked = req.signal; req.signal.addEventListener("abort", () => no(new Error("aborted")), { once: true }); }));
  r.engine.send(r.id, "work");
  expect(await r.until(() => !!asked)).toBe(true);
  r.refuse(true);
  // The stop: in memory, at once, whatever the store says.
  await r.engine.interrupt(r.id, "owner");
  expect(asked!.aborted).toBe(true);
  expect(r.engine.isRunning(r.id)).toBe(false);
  expect(r.kinds().at(-1)).not.toBe("turn_end:interrupted:owner");
  expect(r.store.owes).toBeGreaterThan(0);
  // A second stop of a session with nothing running is nothing, and does not throw.
  await r.engine.interrupt(r.id, "owner");
  // The disk answers: what was owed is written, in order.
  r.refuse(false);
  expect(r.store.owes).toBe(0);
  expect(r.kinds().at(-1)).toBe("turn_end:interrupted:owner");
  expect(r.store.session(r.id)!.phase).toBe("idle");
  expect(r.failures.filter((f) => !/readonly/.test(f))).toEqual([]);
});

test("a turn whose write fails ends in memory, stops what it still ran, and says why once it can", async () => {
  let asked: AbortSignal | undefined;
  // The store stops taking writes while the model answers: the turn's next write is the one that fails.
  const r = rig(async (req, store) => {
    asked = req.signal;
    store.db.exec("PRAGMA query_only = ON");
    return { model: req.model, blocks: [{ type: "text", text: "done" }], stop: "end_turn", usage: { input: 1, cache_read: 0, cache_write: 0, output: 1 } };
  });
  r.engine.send(r.id, "work");
  expect(await r.until(() => !!asked && !r.engine.isRunning(r.id))).toBe(true);
  // Not stopped by anyone, and over: its signal is aborted, so a command it still ran is stopped with it.
  expect(asked!.aborted).toBe(true);
  expect(r.failures.some((f) => /readonly/.test(f))).toBe(true);
  expect(r.store.owes).toBeGreaterThan(0);
  expect(r.kinds().includes("error")).toBe(false);
  // Nothing is left half done in memory: the session takes a stop, and a new prompt once the store takes writes.
  await r.engine.interrupt(r.id, "owner");
  r.store.refuse(true);
  r.refuse(false);
  expect(r.store.owes).toBe(0);
  const said = lineage(r.store.events(r.id), r.store.session(r.id)!.head).find((e) => e.kind === "error");
  expect(String(said?.data.message)).toContain("the daemon's store took no writes (its disk did not answer, or was full: see Errors)");
  expect(r.kinds().some((k) => k.startsWith("turn_end:"))).toBe(true);
  expect(r.store.session(r.id)!.phase).toBe("idle");
});

// The general case: a turn that ends by failing, for whatever reason, leaves nothing running without it.
// What it started with its signal (a command in the foreground, a wait) is stopped when the turn is over.
test("a turn that fails for any reason stops what it still ran", async () => {
  let asked: AbortSignal | undefined;
  const r = rig(async (req) => { asked = req.signal; throw Object.assign(new Error("the provider said no"), { status: 400, kind: "invalid" }); });
  r.engine.send(r.id, "work");
  expect(await r.until(() => !!asked && !r.engine.isRunning(r.id))).toBe(true);
  expect(asked!.aborted).toBe(true);
  // The failure is in the session as before, and the session is idle.
  expect(r.kinds().includes("error")).toBe(true);
  expect(r.store.session(r.id)!.phase).toBe("idle");
});

// A step with two calls, run by a stand-in for the tools: `Alpha` returns at once, `Beta` runs until its
// signal is aborted and then says it was stopped (what a command in the foreground does).
const twoCalls = (alpha: (store: Store) => unknown) => {
  const seen: { beta?: AbortSignal } = {};
  const r = rig(async (req) => (req.messages.some((m: any) => m.content.some((b: any) => b.type === "tool_result"))
    ? { model: req.model, blocks: [{ type: "text", text: "done" }], stop: "end_turn", usage: { input: 1, cache_read: 0, cache_write: 0, output: 1 } }
    : { model: req.model, blocks: [{ type: "tool_use", id: "call-a", name: "Alpha", input: { command: "echo one" } }, { type: "tool_use", id: "call-b", name: "Beta", input: { command: "sleep 900" } }], stop: "tool_use", usage: { input: 1, cache_read: 0, cache_write: 0, output: 1 } }));
  (r.engine as any).runTool = async (_s: unknown, _t: unknown, u: { id: string; name: string }, ctx: { signal: AbortSignal }) => {
    if (u.name === "Alpha") return { type: "tool_result", tool_use_id: u.id, content: alpha(r.store) };
    seen.beta = ctx.signal;
    await new Promise<void>((ok) => ctx.signal.addEventListener("abort", () => ok(), { once: true }));
    return { type: "tool_result", tool_use_id: u.id, content: STOPPED_WHILE, is_error: true };
  };
  const line = () => lineage(r.store.events(r.id), r.store.session(r.id)!.head);
  const order = () => line().map((e) => (e.kind === "tool_result" ? `result:${e.data.results[0].tool_use_id}` : e.kind === "turn_end" ? `turn_end:${e.data.reason}` : e.kind));
  return { ...r, seen, line, order };
};

test("a call's result that cannot be written is owed, in order before the turn's end, and the turn says which calls ran", async () => {
  // The store stops taking writes while the calls run.
  const r = twoCalls((store) => { store.db.exec("PRAGMA query_only = ON"); store.refuse(true); return "one"; });
  r.engine.send(r.id, "work");
  expect(await r.until(() => !!r.seen.beta && !r.engine.isRunning(r.id))).toBe(true);
  // The call that still ran was stopped; nothing of the step is in the store yet, and all of it is owed.
  expect(r.seen.beta!.aborted).toBe(true);
  expect(r.order().slice(-2)).toEqual(["turn_start", "assistant"]);
  // (Read as not working, though the phase's write is owed.)
  expect(r.store.session(r.id)!.phase).toBe("idle");
  expect(r.store.sessions().find((s) => s.id === r.id)!.phase).toBe("idle");
  await Bun.sleep(400);
  r.refuse(false);
  expect(r.store.owes).toBe(0);
  // Both results, then the turn's end, then why: the order they happened in.
  expect(r.order().slice(-5)).toEqual(["assistant", "result:call-a", "result:call-b", "turn_end:error", "error"]);
  const said = String(r.line().at(-1)!.data.message);
  expect(said).toContain("These ran before the store stopped taking writes, and their results are kept: Alpha (echo one).");
  expect(said).toContain("What else it was running was stopped.");
  expect(said).not.toContain("Send the prompt again");
  // The turn took as long as it ran, not as long as the store was away; its events carry the time they happened.
  const end = r.line().at(-2)!;
  expect(end.data.code).toBe("store_refusing");
  expect(end.data.ms).toBeLessThan(350);
  expect(Date.now() - end.ts).toBeGreaterThan(350);
});

// The store stops taking writes because its write lock is held for seconds while the log is started
// again on a slow disk (Store.pacing says so). A turn does not end for that: its call's result is owed
// at once, the turn waits off the loop, and when the lock is given up the result is made and the turn
// goes on to its end.
test("a turn waits out a hold of the store's write lock: its result is owed at once, made when the hold ends, and the turn goes on", async () => {
  let held = false;
  const r = twoCalls((store) => { held = true; store.db.exec("PRAGMA query_only = ON"); store.refuse(true); return "one"; });
  r.store.pacing = () => held;
  // (Beta ends by itself here, a little later: a second call of the step, still running when the hold begins.)
  const real = (r.engine as any).runTool;
  (r.engine as any).runTool = async (s: unknown, t: unknown, u: { id: string; name: string }, ctx: { signal: AbortSignal }) => {
    if (u.name === "Alpha") return real(s, t, u, ctx);
    r.seen.beta = ctx.signal;
    await Bun.sleep(150);
    return { type: "tool_result", tool_use_id: u.id, content: "two" };
  };
  r.engine.send(r.id, "work");
  expect(await r.until(() => r.store.owes >= 2)).toBe(true);
  await Bun.sleep(300);
  // Both results are owed (in the file, for a restart or a kill), nothing is stored, and the turn still runs: no call was stopped.
  expect([r.engine.isRunning(r.id), r.seen.beta!.aborted, r.store.owes]).toEqual([true, false, 2]);
  expect(r.order().slice(-2)).toEqual(["turn_start", "assistant"]);
  // The hold ends: what was owed is made in its order, and the turn goes on from there.
  held = false;
  r.store.db.exec("PRAGMA query_only = OFF");
  r.refuse(false);
  expect(await r.until(() => !r.engine.isRunning(r.id))).toBe(true);
  expect(r.order().slice(-5)).toEqual(["assistant", "result:call-a", "result:call-b", "assistant", "turn_end:end_turn"]);
  expect(r.store.owes).toBe(0);
  // And a stop during such a wait ends the turn at once, as any stop.
  held = false;
  const again = twoCalls((store) => { held = true; store.db.exec("PRAGMA query_only = ON"); store.refuse(true); return "one"; });
  again.store.pacing = () => held;
  again.engine.send(again.id, "work");
  expect(await again.until(() => again.store.owes >= 1)).toBe(true);
  const t = performance.now();
  void again.engine.interrupt(again.id, "owner");
  expect(await again.until(() => !again.engine.isRunning(again.id))).toBe(true);
  expect(performance.now() - t).toBeLessThan(1_500);
  // Its end, owed until the store takes writes, says who stopped it.
  held = false;
  again.refuse(false);
  const end = again.line().findLast((e) => e.kind === "turn_end")!;
  expect([end.data.reason, end.data.stopped_by]).toEqual(["interrupted", "owner"]);
});

// A write of a step that is not a call's result (the session's usage after a reply, a note) can land on
// such a hold too, when the loop reaches it later than the hold's notice allows for. Nothing of the step
// is stored then: the turn waits for the lock to be given up and takes the step again. It does not end.
test("a step whose own write is refused during a hold of the write lock is taken again when the hold ends", async () => {
  let held = false, asked = 0;
  const r = rig(async (req) => {
    // The store stops taking writes while the model answers the first time: the step's writes after the reply are refused.
    if (++asked === 1) { held = true; r.refuse(true); setTimeout(() => { held = false; r.refuse(false); }, 250); }
    return { model: req.model, blocks: [{ type: "text", text: `reply ${asked}` }], stop: "end_turn", usage: { input: 1, cache_read: 0, cache_write: 0, output: 1 } };
  });
  // (The hold's notice comes after the step looked for it: its first look during the hold sees none.)
  let looks = 0;
  r.store.pacing = () => held && ++looks > 1;
  r.engine.send(r.id, "work");
  expect(await r.until(() => !r.engine.isRunning(r.id))).toBe(true);
  const line = lineage(r.store.events(r.id), r.store.session(r.id)!.head);
  expect(line.map((e) => (e.kind === "turn_end" ? `turn_end:${e.data.reason}` : e.kind)).slice(-4)).toEqual(["user", "turn_start", "assistant", "turn_end:end_turn"]);
  expect([asked, JSON.stringify(line.at(-2)!.data.blocks)]).toEqual([2, '[{"type":"text","text":"reply 2"}]']);
  expect(r.store.owes).toBe(0);
});

test("what is owed outlives the daemon: the next start makes it once, before anything else", async () => {
  const r = twoCalls((store) => { store.db.exec("PRAGMA query_only = ON"); store.refuse(true); return "one"; });
  r.engine.send(r.id, "work");
  expect(await r.until(() => !!r.seen.beta && !r.engine.isRunning(r.id))).toBe(true);
  const dir = r.store.stateDir;
  r.store.noteNext("No backup was made before the restart.");
  // The daemon stops with the store still taking no writes: what it owes is in its file.
  expect(await r.store.closeOwed()).toEqual({ made: 0, owed: 4, synced: true, lost: [] });
  const file = join(dir, "owed-writes.jsonl");
  const text = readFileSync(file, "utf8");
  // (A line is its mark and its record.)
  expect(text.trim().split("\n").map(record).map((l) => l.what ?? l.op)).toEqual(["a tool's result", "a tool's result", "a turn's end", "an event (error)", "note"]);
  expect(text.trim().split("\n").every((l) => /^[0-9a-f]{64} \{/.test(l))).toBe(true);
  r.store.db.close();
  // The next start, and one after a kill that came before the file was removed (the same file again, with a line cut).
  for (const again of [false, true]) {
    if (again) writeFileSync(file, `${text}${text.split("\n")[0]!.slice(0, 90)}`);
    const next = new Store(dir);
    expect(existsSync(file)).toBe(false);
    // (The second time its lines are the ones of the file made before: none is made or said again.)
    expect(next.owedAtStart).toEqual({ made: again ? 0 : 4, failed: again ? ["1 line of the file of owed writes was cut or not a record, and was passed over"] : [], notes: again ? [] : [{ text: "No backup was made before the restart.", at: expect.any(Number) }] });
    const line = lineage(next.events(r.id), next.session(r.id)!.head);
    expect(line.map((e) => e.kind).slice(-5)).toEqual(["assistant", "tool_result", "tool_result", "turn_end", "error"]);
    expect(next.events(r.id).filter((e) => e.kind === "turn_end").length).toBe(1);
    next.db.close();
  }
});

test("a stopping daemon tries what it owes for a bounded time, and says exactly what it could not keep", async () => {
  const r = twoCalls((store) => { store.db.exec("PRAGMA query_only = ON"); store.refuse(true); return "one"; });
  r.engine.send(r.id, "work");
  expect(await r.until(() => !!r.seen.beta && !r.engine.isRunning(r.id))).toBe(true);
  // The write lock is held by someone who does not let go (the thread inside a call that does not return).
  const holder = new Database(join(r.store.stateDir, "keel.db"));
  holder.exec("BEGIN IMMEDIATE");
  r.store.db.exec("PRAGMA query_only = OFF");
  const t = performance.now();
  r.store.refuse(false, () => {}, 1_000);
  expect(performance.now() - t).toBeLessThan(2_500);
  expect(r.store.owes).toBe(5);
  // The lock is still held: for what is left of the stop a write fails at once and is owed, with no wait on the loop.
  const t1 = performance.now();
  expect(r.store.refusing).toBe(true);
  expect(() => r.store.append(r.id, "note", { text: "late" })).toThrow(/readonly/);
  expect(r.store.appendOrLater(r.id, "turn_end", { reason: "restart" })).toBe(false);
  expect(performance.now() - t1).toBeLessThan(100);
  expect(r.store.owes).toBe(6);
  expect((await r.store.closeOwed()).owed).toBe(5);
  expect(existsSync(join(r.store.stateDir, "owed-writes.jsonl"))).toBe(true);
  holder.exec("ROLLBACK");
  holder.close();
});

test("when the file of owed writes cannot be written either, what is lost is named", async () => {
  const r = twoCalls((store) => {
    // (The file's place is taken by a folder: an append to it fails.)
    mkdirSync(join(store.stateDir, "owed-writes.jsonl"));
    store.db.exec("PRAGMA query_only = ON");
    store.refuse(true);
    return "one";
  });
  r.engine.send(r.id, "work");
  expect(await r.until(() => !!r.seen.beta && !r.engine.isRunning(r.id))).toBe(true);
  expect(await r.store.closeOwed()).toEqual({ made: 0, owed: 4, synced: false, lost: ["a tool's result", "a tool's result", "a turn's end", "an event (error)"] });
});

test("a step that fails with a call still running: the stopped call's result comes before the turn's end", async () => {
  // A result that cannot be written as JSON (the store takes writes).
  const r = twoCalls(() => 10n);
  r.engine.send(r.id, "work");
  expect(await r.until(() => !!r.seen.beta && !r.engine.isRunning(r.id))).toBe(true);
  expect(r.seen.beta!.aborted).toBe(true);
  expect(r.order().slice(-4)).toEqual(["assistant", "result:call-b", "turn_end:error", "error"]);
  expect(r.store.owes).toBe(0);
});

test("a word for the next start stays in the file when everything owed was made", async () => {
  const r = twoCalls((store) => { store.db.exec("PRAGMA query_only = ON"); store.refuse(true); return "one"; });
  r.engine.send(r.id, "work");
  expect(await r.until(() => !!r.seen.beta && !r.engine.isRunning(r.id))).toBe(true);
  r.store.noteNext("No backup was made before the restart.");
  // The daemon stops and the store takes its writes after all: only the word is left for the next start.
  r.store.db.exec("PRAGMA query_only = OFF");
  r.store.refuse(false, () => {}, 3_000);
  expect(await r.store.closeOwed()).toEqual({ made: 4, owed: 0, synced: true, lost: [] });
  expect(readFileSync(join(r.store.stateDir, "owed-writes.jsonl"), "utf8").trim().split("\n").map(record).map((l) => l.op)).toEqual(["note"]);
  r.store.db.close();
  const next = new Store(r.store.stateDir);
  expect(next.owedAtStart).toEqual({ made: 0, failed: [], notes: [{ text: "No backup was made before the restart.", at: expect.any(Number) }] });
  expect(next.events(r.id).filter((e) => e.kind === "turn_end").length).toBe(1);
  next.db.close();
});
