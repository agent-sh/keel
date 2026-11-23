// The goal's accounting and the shared task list, driven the way the turn
// hooks drive them, with a stand-in engine: what the model's plan tool and the
// judge do in a real turn cannot be made to happen on cue from the page.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { alertHook, dropPending, flush, hasPending, setDeps } from "./core.ts";
import * as activity from "./activity.ts";
import * as agents from "./agents.ts";
import * as goals from "./goals.ts";
import { parseVerdict, verifierSession, WAIT_MS } from "./verify.ts";
import * as waits from "./waits.ts";

// Turn hooks are process-wide: the files after this one run without the ones its tests register.
const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });

let store!: Store;
let running = false;
let draining = false; // the daemon is on its way down
let modelUp = true;
let modelGate: Promise<void> | undefined; // a model listing that takes its time
// The scripted judge: each request waits for its answer; `verdict` answers the newest.
const asked: ((text: string) => void)[] = [];
const askedFor: string[] = []; // the session of each request, in the same order
const asks = (id: string) => askedFor.filter((x) => x === id).length;
let verdict: (text: string) => void = () => {};
// The scripted verifier: its child session's turn runs until `verifierSays` ends it.
const live = new Set<string>();
const engine = {
  isRunning: (id: string) => running || live.has(id),
  isDraining: () => draining,
  isHeld: () => false,
  holdQueue: () => {}, // a stop of an agent with no turn holds its queue (nothing here reads it back)
  ownerResumes: () => {},
  interrupt: async () => {},
  idle: async () => {},
  send: (id: string, text: string, o: any) => {
    if (store.session(id)?.parent_id) live.add(id);
    return { event: store.append(id, "user", { text, ...o?.meta }) };
  },
  ask: (id: string) => new Promise((res) => (askedFor.push(id), asked.push((verdict = (text) => res({ blocks: [{ type: "text", text }], usage: { input: 1, output: 1 }, model_id: "m" }))))),
};
// A daemon on a state folder; called again on the same folder, the daemon after a restart.
function boot(dir: string) {
  store = new Store(dir);
  setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine, providers: { resolve: async (id: string) => { await modelGate; if (!modelUp) throw new Error("the provider is not up"); return { info: { id } }; } } } as any);
  activity.migrate();
  agents.migrate();
  waits.migrate();
  goals.migrate();
}
boot(mkdtempSync(join(tmpdir(), "keel-goals-")));
const session = () => store.createSession({ model: "m", workspace: "/", title: "t" });
const usage = (n: number) => ({ input: n, output: 0, cache_read: 0, cache_write: 0 });
const turn = (id: string, tokens: number) => {
  store.append(id, "turn_start", {});
  store.append(id, "assistant", { blocks: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], usage: usage(tokens) });
  store.append(id, "tool_result", { results: [] });
  store.append(id, "turn_end", { reason: "end_turn", usage: usage(tokens) });
};
const until = async <T>(f: () => T): Promise<NonNullable<T>> => {
  for (let i = 0; i < 500; i++) { const v = f(); if (v) return v; await Bun.sleep(2); }
  throw new Error("it never happened");
};
const verifierSays = (child: string, text: string) => {
  store.append(child, "assistant", { blocks: [{ type: "text", text }], usage: usage(3) });
  live.delete(child);
  for (const h of allHooks()) h.turnEnd?.(store.session(child)!, "end_turn");
};
const said = (id: string, goal: string) => store.events(id).filter((e) => e.kind === "user" && e.data.kind === "goal" && e.data.goal === goal);

test("two plan items of the same text are two rows, and ticking one off saves", () => {
  const s = session();
  goals.fromPlanTool(s.id, "update_plan", { plan: [{ step: "Verify", status: "pending" }, { step: "Verify", status: "pending" }] });
  const [a, b] = goals.tasks(s.id);
  goals.fromPlanTool(s.id, "update_plan", { plan: [{ step: "Verify", status: "completed" }, { step: "Verify", status: "pending" }] });
  expect(goals.tasks(s.id).map((t) => [t.id, t.status])).toEqual([[a!.id, "completed"], [b!.id, "pending"]]);
});

test("an item the owner cancelled mid-turn stays cancelled when the model's older plan lands", () => {
  const s = session();
  goals.fromPlanTool(s.id, "TodoWrite", { todos: [{ content: "Run migration", status: "pending" }, { content: "Docs", status: "pending" }] });
  running = true;
  const t = goals.tasks(s.id)[0]!;
  goals.editTask(s.id, t.id, { status: "cancelled" });
  goals.fromPlanTool(s.id, "TodoWrite", { todos: [{ content: "Run migration", status: "in_progress" }, { content: "Docs", status: "completed" }] });
  running = false;
  expect(goals.tasks(s.id).map((x) => x.status)).toEqual(["cancelled", "completed"]);
  goals.tellModel(s.id);
  goals.tellModel(s.id);
  expect(store.events(s.id).filter((e) => e.kind === "note" && e.data.kind === "tasks")).toHaveLength(1);
});

test("owner edits to an idle session's list reach the model as one note at its next request", () => {
  const s = session();
  const notes = () => store.events(s.id).filter((e) => e.kind === "note" && e.data.kind === "tasks");
  const a = goals.addTask(s.id, "Read the spec");
  goals.addTask(s.id, "Write the parser");
  goals.editTask(s.id, a.id, { status: "in_progress" });
  goals.editTask(s.id, a.id, { text: "Read the whole spec" });
  const c = goals.addTask(s.id, "Scratch");
  goals.removeTask(s.id, c.id);
  expect(notes()).toHaveLength(0);
  expect(goals.tellModel(s.id)).toBe(true);
  expect(goals.tellModel(s.id)).toBe(false);
  expect(notes().map((e) => e.data.text)).toEqual([expect.stringContaining("[~] Read the whole spec\n[ ] Write the parser\n")]);
});

test("a message steered into a turn does not hide the turn's tokens from the goal's budget", async () => {
  const s = session();
  await goals.set(s.id, { objective: "make it pass", token_budget: 100 });
  store.append(s.id, "turn_start", {});
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], usage: usage(95) });
  store.append(s.id, "tool_result", { results: [] });
  store.append(s.id, "user", { text: "also check the docs", origin: "steer" });
  store.append(s.id, "assistant", { blocks: [{ type: "text", text: "done" }], usage: usage(8) });
  store.append(s.id, "turn_end", { reason: "end_turn", usage: usage(103) });
  const judged = goals.afterTurn(s.id, "end_turn");
  verdict('{"verdict": "not_met", "reason": "no test run"}');
  await judged;
  expect(goals.get(s.id)).toMatchObject({ status: "budget", idle_turns: 0 });
});

test("a check of a goal that was replaced meanwhile decides nothing about the new one", async () => {
  const s = session();
  await goals.set(s.id, { objective: "Verify A" });
  store.append(s.id, "turn_start", {});
  store.append(s.id, "turn_end", { reason: "end_turn", usage: usage(5) });
  const judged = goals.afterTurn(s.id, "end_turn");
  await goals.set(s.id, { objective: "Verify B", replace: true });
  verdict('{"verdict": "met", "reason": "A passed"}');
  await judged;
  expect(goals.get(s.id)).toMatchObject({ objective: "Verify B", status: "pursuing", tokens_used: 0 });
  expect(goals.get(s.id)!.last_verdict ?? null).toBeNull();
});

test("a goal set after another was cleared gets its own check, never the old goal's verdict", async () => {
  const s = session();
  await goals.set(s.id, { objective: "Verify A" });
  turn(s.id, 5);
  const checkA = goals.afterTurn(s.id, "end_turn");
  const answerA = verdict;
  goals.clear(s.id);
  await goals.set(s.id, { objective: "Verify B" });
  turn(s.id, 7);
  const before = asked.length;
  const checkB = goals.afterTurn(s.id, "end_turn");
  expect(asked.length).toBe(before + 1); // B's turn is judged while A's judge is still out
  verdict('{"verdict": "not_met", "reason": "B has no test run"}');
  await checkB;
  answerA('{"verdict": "met", "reason": "A passed"}');
  await checkA;
  expect(goals.get(s.id)).toMatchObject({ objective: "Verify B", status: "pursuing", turns: 1, tokens_used: 9, last_verdict: "not_met", last_reason: "B has no test run" });
  expect(goals.get(s.id)!.verifying ?? false).toBe(false);
  expect(said(s.id, "continue").map((e) => e.data.text)).toEqual([expect.stringContaining("B has no test run")]);
});

test("a late verifier of a cleared goal leaves the new goal's verification alone", async () => {
  const s = session();
  await goals.set(s.id, { objective: "Verify A" });
  turn(s.id, 5);
  const checkA = goals.afterTurn(s.id, "end_turn");
  verdict('{"verdict": "met", "reason": "A looks done"}');
  const childA = await until(() => goals.get(s.id)?.verifier_session);
  goals.clear(s.id);
  await goals.set(s.id, { objective: "Verify B" });
  turn(s.id, 7);
  const checkB = goals.afterTurn(s.id, "end_turn");
  verdict('{"verdict": "met", "reason": "B looks done"}');
  const childB = await until(() => goals.get(s.id)?.verifier_session);
  expect(childB).not.toBe(childA);
  verifierSays(childA, '{"verdict": "not_met", "reason": "A is not done", "evidence": ["a.txt is missing"]}');
  await checkA;
  expect(goals.get(s.id)).toMatchObject({ objective: "Verify B", status: "pursuing", verifying: true, verifier_session: childB });
  expect(said(s.id, "continue")).toHaveLength(0);
  verifierSays(childB, '{"verdict": "met", "reason": "B holds", "evidence": ["b.txt:1 reads done"]}');
  await checkB;
  expect(goals.get(s.id)).toMatchObject({ objective: "Verify B", status: "achieved", verified: true, verifying: false, evidence: ["b.txt:1 reads done"] });
  expect(said(s.id, "continue")).toHaveLength(0);
});

// A goal whose judge said met, up to its verifier's child session.
async function judgedMet(objective: string) {
  const s = session();
  await goals.set(s.id, { objective });
  turn(s.id, 5);
  const check = goals.afterTurn(s.id, "end_turn");
  verdict('{"verdict": "met", "reason": "it looks done"}');
  const child = await until(() => goals.get(s.id)?.verifier_session);
  await until(() => live.has(child));
  return { id: s.id, child, check };
}

test("a verifier's met counts only with evidence it names", async () => {
  expect(parseVerdict('{"verdict": "met", "reason": "all good"}')).toHaveProperty("error");
  expect(parseVerdict('{"verdict": "met", "reason": "all good", "evidence": []}')).toHaveProperty("error");
  expect(parseVerdict('{"verdict": "met", "reason": "all good", "evidence": ["  ", ""]}')).toHaveProperty("error");
  expect(parseVerdict('{"verdict": "met", "reason": "all good", "evidence": [" bun test: 4 pass ", ""]}')).toEqual({ verdict: "met", reason: "all good", evidence: ["bun test: 4 pass"] });
  expect(parseVerdict('{"verdict": "not_met", "reason": "no test was run, so there is nothing to cite"}')).toEqual({ verdict: "not_met", reason: "no test was run, so there is nothing to cite", evidence: [] });

  // A bare met is asked for its evidence once, in the verifier's own context; still bare, the goal is not
  // achieved: it pauses, and the owner is told (an alert and an activity row).
  const alerts: string[][] = [];
  alertHook.raise = (kind, id, title, body) => void alerts.push([kind, id ?? "", title, body]);
  for (const bare of ['{"verdict": "met", "reason": "all good"}', '{"verdict": "met", "reason": "all good", "evidence": []}', '{"verdict": "met", "reason": "all good", "evidence": ["   "]}']) {
    const g = await judgedMet("ship it");
    verifierSays(g.child, bare);
    await until(() => live.has(g.child));
    verifierSays(g.child, bare);
    await g.check;
    expect(goals.get(g.id)).toMatchObject({ status: "paused", status_reason: expect.stringContaining("no evidence"), verifying: false });
    expect(goals.get(g.id)!.verified ?? false).toBe(false);
    expect(alerts.filter((a) => a[1] === g.id)).toEqual([["failed", g.id, expect.stringContaining("Goal paused"), expect.stringContaining("no evidence")]]);
    const rows = store.db.query<{ text: string }, [string]>("SELECT text FROM activity WHERE session_id = ? AND text LIKE 'Goal paused%'").all(g.id);
    expect(rows.map((r) => r.text)).toEqual([expect.stringContaining("no evidence")]);
  }
  alertHook.raise = undefined;
  expect(alerts).toHaveLength(3);

  const second = await judgedMet("ship it");
  verifierSays(second.child, '{"verdict": "met", "reason": "all good"}');
  await until(() => live.has(second.child));
  verifierSays(second.child, '{"verdict": "met", "reason": "the suite passes", "evidence": ["bun test: 4 pass, 0 fail"]}');
  await second.check;
  expect(goals.get(second.id)).toMatchObject({ status: "achieved", verified: true, evidence: ["bun test: 4 pass, 0 fail"] });

  const missing = await judgedMet("ship it");
  verifierSays(missing.child, '{"verdict": "not_met", "reason": "no test was run, so there is nothing to cite"}');
  await missing.check;
  expect(goals.get(missing.id)).toMatchObject({ status: "pursuing", last_verdict: "not_met" });
  expect(said(missing.id, "continue").map((e) => e.data.text)).toEqual([expect.stringContaining("nothing to cite")]);
});

test("a goal cleared while its verifier's model resolves gets no verifier session", async () => {
  const s = session();
  await goals.set(s.id, { objective: "Verify A" });
  turn(s.id, 5);
  let open!: () => void;
  modelGate = new Promise((r) => (open = r));
  const check = goals.afterTurn(s.id, "end_turn");
  verdict('{"verdict": "met", "reason": "A looks done"}');
  await until(() => goals.get(s.id)?.verifying);
  goals.clear(s.id);
  modelGate = undefined;
  open();
  await check;
  expect(store.sessions().filter((x) => x.parent_id === s.id)).toHaveLength(0);
  expect(goals.get(s.id)).toBeUndefined();
});

test("a paused goal is not resumed in an archived session", async () => {
  const s = session();
  await goals.set(s.id, { objective: "ship it" });
  await goals.patch(s.id, { status: "paused" });
  store.updateSession(s.id, { archived: true });
  await expect(goals.patch(s.id, { status: "pursuing" })).rejects.toThrow(/archived/);
  expect(goals.get(s.id)!.status).toBe("paused");
});

// The restart cases reopen the same state folder: what the next daemon reads is what was saved.
test("a goal whose turn ended as the daemon went down gets its verdict after the restart, the turn counted once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-goals-restart-"));
  boot(dir);
  const judged = session(), unseen = session();
  await goals.set(judged.id, { objective: "make it pass" });
  await goals.set(unseen.id, { objective: "make it build" });
  turn(judged.id, 40);
  void goals.afterTurn(judged.id, "end_turn"); // the judge is asked, and the daemon stops before it answers
  turn(unseen.id, 30); // the daemon stops before the turn-end hook runs
  store.db.close();

  boot(dir);
  let before = asked.length;
  goals.recover();
  await until(() => asked.length === before + 2);
  for (const answer of asked.slice(before)) answer('{"verdict": "not_met", "reason": "no test run yet"}');
  await until(() => said(judged.id, "continue").length && said(unseen.id, "continue").length);
  expect(goals.get(judged.id)).toMatchObject({ status: "pursuing", turns: 1, tokens_used: 42, last_verdict: "not_met" });
  expect(goals.get(unseen.id)).toMatchObject({ status: "pursuing", turns: 1, tokens_used: 32, last_verdict: "not_met" });
  store.db.close();

  // Restarted again with the continuation sent: nothing is asked, sent or counted again.
  boot(dir);
  before = asked.length;
  goals.recover();
  await Bun.sleep(20);
  expect(asked.length).toBe(before);
  for (const id of [judged.id, unseen.id]) {
    expect(said(id, "start")).toHaveLength(1);
    expect(said(id, "continue")).toHaveLength(1);
    expect(goals.get(id)!.turns).toBe(1);
  }
});

test("a turn parked for a restart is not judged: its continuation is", async () => {
  const s = session();
  await goals.set(s.id, { objective: "make it pass" });
  store.append(s.id, "turn_start", {});
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }], usage: usage(10) });
  store.append(s.id, "turn_end", { reason: "restart", usage: usage(10) });
  const before = asked.length;
  await goals.afterTurn(s.id, "restart");
  expect(asked.length).toBe(before);
  expect(goals.get(s.id)).toMatchObject({ status: "pursuing", turns: 0, tokens_used: 10 });
  store.db.close();

  boot(store.stateDir);
  goals.recover(); // the engine continues the cut turn: no check is owed for it
  await Bun.sleep(20);
  expect(asked.length).toBe(before);
  store.append(s.id, "user", { text: "continue", origin: "restart" });
  turn(s.id, 5);
  const check = goals.afterTurn(s.id, "end_turn");
  verdict('{"verdict": "not_met", "reason": "one test fails"}');
  await check;
  expect(goals.get(s.id)).toMatchObject({ status: "pursuing", turns: 1, tokens_used: 17 });
});

// The next daemon on the same folder: what the last one held in memory is gone.
const restart = (...sessions: string[]) => {
  for (const id of sessions) dropPending(id);
  live.clear();
  draining = false;
  const dir = store.stateDir;
  store.db.close();
  boot(dir);
  agents.recover();
  goals.recover();
};
const quiet = () => Bun.sleep(30);

test("a cut turn the engine holds leaves the goal pursuing: the next turn in the session is judged", async () => {
  const s = session();
  await goals.set(s.id, { objective: "ship it" });
  store.append(s.id, "turn_start", {});
  store.append(s.id, "turn_end", { reason: "restart", usage: usage(0) });
  await goals.afterTurn(s.id, "restart");
  restart(s.id);
  // The engine holds the turn (continued three times with no step done): a note, no turn.
  store.append(s.id, "note", { kind: "restart", text: "This turn was not resumed again." });
  await quiet();
  expect(asks(s.id)).toBe(0);
  expect(goals.get(s.id)).toMatchObject({ status: "pursuing" });
  // A loop's turn ends in the session afterwards: it is judged, and the goal goes on.
  store.append(s.id, "user", { text: "tick", kind: "loop" });
  turn(s.id, 5);
  const check = goals.afterTurn(s.id, "end_turn");
  expect(asks(s.id)).toBe(1);
  verdict('{"verdict": "not_met", "reason": "one test fails"}');
  await check;
  expect(goals.get(s.id)).toMatchObject({ status: "pursuing", turns: 1, last_verdict: "not_met" });
  expect(said(s.id, "continue")).toHaveLength(1);
});

// The verifier's turn as a daemon stop leaves it (parked, or closed as cut by the next start).
const cutVerifier = (child: string) => {
  store.append(child, "turn_end", { reason: "restart", usage: usage(0) });
  live.delete(child);
  for (const h of allHooks()) h.turnEnd?.(store.session(child)!, "restart");
};
// The engine continues the cut turn in the same session.
const continued = (child: string) => {
  store.append(child, "user", { text: "[harness] The daemon restarted during your previous turn.", origin: "restart" });
  store.append(child, "turn_start", {});
  live.add(child);
};
const verifiersOf = (id: string) => store.sessions().filter((x) => x.parent_id === id).map((x) => x.id);
const MET = '{"verdict": "met", "reason": "the suite passes", "evidence": ["bun test: 4 pass, 0 fail"]}';

test("a verification longer than the gap between restarts ends with one verifier, one judge call and one verdict", async () => {
  const g = await judgedMet("ship it");
  for (let n = 0; n < 3; n++) {
    draining = true;
    cutVerifier(g.child);
    await quiet();
    expect(goals.get(g.id)).toMatchObject({ status: "pursuing", verifying: true, verifier_session: g.child });
    restart(g.id);
    await quiet();
    // The same verifier is still the goal's, live for its parent, with no prompt of its own from the start.
    expect(goals.get(g.id)).toMatchObject({ status: "pursuing", verifying: true, verifier_session: g.child });
    expect(agents.byChild(g.child)!.status).toBe("running");
    expect(store.events(g.child).filter((e) => e.kind === "user" && e.data.origin !== "restart")).toHaveLength(1);
    continued(g.child);
  }
  expect(asks(g.id)).toBe(1);
  // A turn of the working session that ends meanwhile is counted, not judged a second time.
  turn(g.id, 5);
  await goals.afterTurn(g.id, "end_turn");
  expect(asks(g.id)).toBe(1);
  verifierSays(g.child, MET);
  await until(() => goals.get(g.id)?.status === "achieved");
  expect(goals.get(g.id)).toMatchObject({ verified: true, verifying: false, turns: 2, verifier_session: g.child, evidence: ["bun test: 4 pass, 0 fail"] });
  expect(verifiersOf(g.id)).toEqual([g.child]);
  expect(asks(g.id)).toBe(1);
  const rows = store.db.query<{ text: string }, [string]>("SELECT text FROM activity WHERE session_id = ? AND text LIKE 'Goal verification%'").all(g.id);
  expect(rows).toHaveLength(1);
});

test("a verifier that answered as the daemon went down is read at the next start, and a bare met is asked once more there", async () => {
  // Its turn ended (the end is stored) and the daemon went down before the goal read it.
  const done = await judgedMet("ship it");
  store.append(done.child, "assistant", { blocks: [{ type: "text", text: '{"verdict": "not_met", "reason": "one test fails", "evidence": ["bun test: 1 fail"]}' }], usage: usage(3) });
  store.append(done.child, "turn_end", { reason: "end_turn", usage: usage(3) });
  const bare = await judgedMet("ship it");
  store.append(bare.child, "assistant", { blocks: [{ type: "text", text: '{"verdict": "met", "reason": "all good"}' }], usage: usage(3) });
  store.append(bare.child, "turn_end", { reason: "end_turn", usage: usage(3) });
  restart(done.id, bare.id);
  await until(() => said(done.id, "continue").length);
  expect(goals.get(done.id)).toMatchObject({ status: "pursuing", verifying: false, last_verdict: "not_met", verifier_session: done.child });
  expect(said(done.id, "continue")[0]!.data.text).toContain("bun test: 1 fail");
  await until(() => live.has(bare.child));
  expect(store.events(bare.child).filter((e) => e.kind === "user").map((e) => e.data.kind)).toEqual(["verify_goal", "verify_goal"]);
  verifierSays(bare.child, MET);
  await until(() => goals.get(bare.id)?.status === "achieved");
  for (const x of [done, bare]) {
    expect(asks(x.id)).toBe(1);
    expect(verifiersOf(x.id)).toEqual([x.child]);
  }
});

test("a goal whose verifier had no session or no task yet when the daemon went down gets them at the next start, the judge not asked again", async () => {
  // Down while the verifier's model resolved: the judge's met is saved, no session yet.
  const none = session();
  await goals.set(none.id, { objective: "ship it" });
  turn(none.id, 5);
  modelGate = new Promise(() => {}); // never answers: that daemon goes down first
  void goals.afterTurn(none.id, "end_turn");
  verdict('{"verdict": "met", "reason": "it looks done"}');
  await until(() => goals.get(none.id)?.verifying);
  // Down between the verifier's session and its task.
  const bare = session();
  await goals.set(bare.id, { objective: "ship it" });
  turn(bare.id, 5);
  const child = store.createSession({ model: "m", workspace: "/", title: "Verify goal" }).id;
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(bare.id, child);
  agents.adopt(bare.id, child, { title: "Verify goal", type: "verifier", model: "m" });
  store.db.query("UPDATE goals SET data = json_set(data, '$.verifying', json('true'), '$.verifier_session', ?, '$.last_verdict', 'met', '$.last_reason', 'it looks done') WHERE session_id = ?").run(child, bare.id);
  const before = asked.length;
  modelGate = undefined;
  restart(none.id, bare.id);
  const made = await until(() => goals.get(none.id)?.verifier_session);
  await until(() => live.has(made) && live.has(child));
  for (const c of [made, child]) {
    const prompts = store.events(c).filter((e) => e.kind === "user");
    expect(prompts.map((e) => e.data.kind)).toEqual(["verify_goal"]);
    expect(prompts[0]!.data.text).toContain("Why the judge said met:\nit looks done");
    verifierSays(c, MET);
  }
  await until(() => goals.get(none.id)?.status === "achieved" && goals.get(bare.id)?.status === "achieved");
  expect(asked.length).toBe(before);
  expect(verifiersOf(bare.id)).toEqual([child]);
});

test("a verifier the engine does not continue pauses the goal and tells the owner", async () => {
  const alerts: string[][] = [];
  alertHook.raise = (kind, id, title, body) => void alerts.push([kind, id ?? "", title, body]);
  const g = await judgedMet("ship it");
  draining = true;
  cutVerifier(g.child);
  restart(g.id);
  // The engine holds the cut turn (continued three times with no step done): its note, then the hook.
  store.append(g.child, "note", { kind: "restart", text: "This turn was not resumed again." });
  for (const h of allHooks()) h.cutTurnHeld?.(store.session(g.child)!, "This turn was not resumed again.");
  await until(() => goals.get(g.id)?.status === "paused");
  alertHook.raise = undefined;
  expect(goals.get(g.id)).toMatchObject({ verifying: false, status_reason: expect.stringContaining("was not resumed") });
  expect(alerts).toEqual([["failed", g.id, expect.stringContaining("Goal paused"), expect.stringContaining("was not resumed")]]);
  expect(asks(g.id)).toBe(1);
  // A start after that finds a paused goal and nothing to wait for.
  restart(g.id);
  await quiet();
  expect(goals.get(g.id)).toMatchObject({ status: "paused", verifying: false });
  expect(verifiersOf(g.id)).toEqual([g.child]);
});

// A verification always ends. Its limit is counted from its start, kept in the
// goal's row, so restarts do not start the count again; and a verifier whose
// session is archived, deleted or gone ends it at once. Each ends as a paused
// goal with the reason and an alert, the verifier's record ended, no judge
// call and no second verifier.
const row = (id: string, patch: Record<string, unknown>) =>
  store.db.query("UPDATE goals SET data = json_patch(data, ?) WHERE session_id = ?").run(JSON.stringify(patch), id);
const children = (id: string) => store.db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE parent_id = ? ORDER BY created, id").all(id).map((r) => r.id);
const alerted = async (f: () => Promise<void>) => {
  const alerts: string[][] = [];
  alertHook.raise = (kind, id, title, body) => void alerts.push([kind, id ?? "", title, body]);
  try { await f(); } finally { alertHook.raise = undefined; }
  return alerts;
};

test("a verification's limit is counted from its start in the goal's row, not from each daemon start", async () => {
  const over = await judgedMet("ship it");
  const near = await judgedMet("ship it");
  expect(goals.get(over.id)!.verify_started_ms).toBeGreaterThan(Date.now() - 5_000);
  const alerts = await alerted(async () => {
    draining = true;
    cutVerifier(over.child);
    cutVerifier(near.child);
    // The limit passed while the daemon was down; for the other it has 800 ms left
    // (the first is paused well inside that, on a loaded machine too: 150 ms was not enough).
    row(over.id, { verify_started_ms: Date.now() - WAIT_MS - 1 });
    row(near.id, { verify_started_ms: Date.now() - WAIT_MS + 800 });
    restart(over.id, near.id);
    await until(() => goals.get(over.id)?.status === "paused");
    expect(goals.get(near.id)).toMatchObject({ status: "pursuing", verifying: true });
    // The engine continues the other's turn; it is stopped when its time is up, though this daemon started just now.
    continued(near.child);
    live.delete(near.child);
    await until(() => goals.get(near.id)?.status === "paused");
  });
  for (const g of [over, near]) {
    expect(goals.get(g.id)).toMatchObject({ verifying: false, verifier_session: g.child, status_reason: "the judge said met; the verifier ran past 15 minutes. Resume to try again." });
    expect(agents.byChild(g.child)).toMatchObject({ status: "stopped", stopped_by: "time_limit" });
    expect(asks(g.id)).toBe(1);
    expect(children(g.id)).toEqual([g.child]);
  }
  expect(alerts.map((a) => [a[0], a[1], a[3]])).toEqual([over, near].map((g) => ["failed", g.id, expect.stringContaining("ran past 15 minutes")]));
  // One more start: a paused goal, nothing waited for.
  restart(over.id, near.id);
  await quiet();
  expect(goals.get(over.id)).toMatchObject({ status: "paused", verifying: false });
});

test("a verifier whose session is archived, deleted or gone ends the verification at once", async () => {
  const byStart = { archived: await judgedMet("ship it"), deleted: await judgedMet("ship it") };
  const byEvent = { archived: await judgedMet("ship it"), deleted: await judgedMet("ship it") };
  const all = [...Object.values(byStart), ...Object.values(byEvent)];
  const alerts = await alerted(async () => {
    draining = true;
    for (const g of all) cutVerifier(g.child);
    // Archived and deleted while the daemon was down, or before the engine got to their cut turns.
    store.updateSession(byStart.archived.child, { archived: true });
    store.deleteSession(byStart.deleted.child);
    restart(...all.map((g) => g.id));
    await until(() => goals.get(byStart.archived.id)?.status === "paused" && goals.get(byStart.deleted.id)?.status === "paused");
    // The other two wait for their cut turns; the owner archives one and deletes the other (the session frames).
    await quiet();
    for (const g of Object.values(byEvent)) expect(goals.get(g.id)).toMatchObject({ status: "pursuing", verifying: true });
    verifierSession(store.updateSession(byEvent.archived.child, { archived: true }), false);
    const gone = store.session(byEvent.deleted.child)!;
    store.deleteSession(gone.id);
    verifierSession({ ...gone, archived: true }, true);
    await until(() => goals.get(byEvent.archived.id)?.status === "paused" && goals.get(byEvent.deleted.id)?.status === "paused");
  });
  for (const set of [byStart, byEvent]) {
    expect(goals.get(set.archived.id)).toMatchObject({ verifying: false, status_reason: "the judge said met; the verifier's session was archived. Resume to try again." });
    expect(goals.get(set.deleted.id)).toMatchObject({ verifying: false, status_reason: "the judge said met; the verifier's session was deleted. Resume to try again." });
    expect(agents.byChild(set.archived.child)!.status).toBe("stopped");
  }
  expect(alerts).toHaveLength(4);
  expect(alerts.map((a) => a[1]).sort()).toEqual(all.map((g) => g.id).sort());
  for (const g of all) {
    expect(asks(g.id)).toBe(1);
    // No second verifier was made for it.
    expect(children(g.id).filter((c) => c !== g.child)).toEqual([]);
  }
  // A start after that waits for nothing.
  restart(...all.map((g) => g.id));
  await quiet();
  for (const g of all) expect(goals.get(g.id)).toMatchObject({ status: "paused", verifying: false });
});

test("a row of the build before: a verifier left from the check before is not this check's, and the limit starts now", async () => {
  // The check before ended not met with its verifier's session in the row; the worker went on, the judge said
  // met again, and that build (which did not clear the session then) went down before it made the new verifier.
  const g = await judgedMet("ship it");
  verifierSays(g.child, '{"verdict": "not_met", "reason": "one test fails"}');
  await g.check;
  await Bun.sleep(5);
  turn(g.id, 5);
  const ended = store.events(g.id).findLast((e) => e.kind === "turn_end")!;
  row(g.id, { verifying: true, verifier_session: g.child, verify_started_ms: null, counted: ended.id, turns: 2, last_verdict: "met", last_reason: "it looks done now" });
  const before = asks(g.id);
  restart(g.id);
  const fresh = await until(() => { const c = goals.get(g.id)?.verifier_session; return c && c !== g.child ? c : undefined; });
  await until(() => live.has(fresh));
  // The old verifier's not met was not taken for this check's verdict.
  expect(goals.get(g.id)).toMatchObject({ status: "pursuing", verifying: true });
  expect(goals.get(g.id)!.verify_started_ms).toBeGreaterThan(Date.now() - 5_000);
  expect(store.events(fresh).filter((e) => e.kind === "user")[0]!.data.text).toContain("Why the judge said met:\nit looks done now");
  verifierSays(fresh, MET);
  await until(() => goals.get(g.id)?.status === "achieved");
  expect(asks(g.id)).toBe(before);
  expect(children(g.id)).toEqual([g.child, fresh]);

  // The same row with this check's own verifier (made after the turn ended) keeps it.
  const own = await judgedMet("ship it");
  draining = true;
  cutVerifier(own.child);
  row(own.id, { verify_started_ms: null });
  restart(own.id);
  await quiet();
  expect(goals.get(own.id)).toMatchObject({ verifying: true, verifier_session: own.child });
  expect(goals.get(own.id)!.verify_started_ms).toBeGreaterThan(Date.now() - 5_000);
  continued(own.child);
  verifierSays(own.child, MET);
  await until(() => goals.get(own.id)?.status === "achieved");
  expect(children(own.id)).toEqual([own.child]);
});

test("a verification that cannot go on at a start pauses the goal and tells the owner", async () => {
  // Down while the verifier's model resolved; at the next start that model does not come up.
  const s = session();
  await goals.set(s.id, { objective: "ship it" });
  turn(s.id, 5);
  modelGate = new Promise(() => {});
  void goals.afterTurn(s.id, "end_turn");
  verdict('{"verdict": "met", "reason": "it looks done"}');
  await until(() => goals.get(s.id)?.verifying);
  modelGate = undefined;
  process.env.KEEL_GOAL_READY_GAP_MS = "1";
  modelUp = false;
  const alerts = await alerted(async () => {
    try {
      restart(s.id);
      await until(() => goals.get(s.id)?.status === "paused");
    } finally {
      modelUp = true;
      delete process.env.KEEL_GOAL_READY_GAP_MS;
    }
  });
  const why = "its verification could not go on: the provider is not up. Resume to try again.";
  expect(goals.get(s.id)).toMatchObject({ verifying: false, status_reason: why });
  expect(alerts).toEqual([["failed", s.id, expect.stringContaining("Goal paused"), why]]);
  expect(store.db.query<{ text: string }, [string]>("SELECT text FROM activity WHERE session_id = ? AND text LIKE 'Goal paused%'").all(s.id).map((r) => r.text)).toEqual([`Goal paused: ${why}`]);
});

test("a continuation lined up behind a turn the owner stops is dropped, and the resume carries the verifier's findings", async () => {
  const g = await judgedMet("ship it");
  // The owner writes in the session while the verifier works: the verdict's continuation waits for that turn.
  running = true;
  store.append(g.id, "user", { text: "also update the docs" });
  store.append(g.id, "turn_start", {});
  verifierSays(g.child, '{"verdict": "not_met", "reason": "one test fails", "evidence": ["bun test: 1 fail in parse.test.ts"]}');
  await g.check;
  expect(hasPending(g.id)).toBe(true);
  // The owner stops the turn: its end pauses the goal, and what was lined up does not start a turn.
  store.append(g.id, "turn_end", { reason: "interrupted", stopped_by: "owner", usage: usage(2) });
  running = false;
  await goals.afterTurn(g.id, "interrupted");
  flush(g.id);
  expect(goals.get(g.id)).toMatchObject({ status: "paused", status_reason: "the owner stopped the turn" });
  expect(said(g.id, "continue")).toHaveLength(0);
  expect(hasPending(g.id)).toBe(false);
  // Resumed: the prompt says what the verifier found.
  await goals.patch(g.id, { status: "pursuing" });
  const text = said(g.id, "resume").map((e) => e.data.text as string);
  expect(text).toHaveLength(1);
  expect(text[0]).toContain("ship it");
  expect(text[0]).toContain("an independent check of the work");
  expect(text[0]).toContain("one test fails\n- bun test: 1 fail in parse.test.ts");

  // A turn that ends by itself still gets what was lined up behind it.
  const h = await judgedMet("ship it");
  running = true;
  store.append(h.id, "user", { text: "also update the docs" });
  verifierSays(h.child, '{"verdict": "not_met", "reason": "one test fails"}');
  await h.check;
  turn(h.id, 3);
  running = false;
  await goals.afterTurn(h.id, "end_turn", { judge: false });
  flush(h.id);
  expect(said(h.id, "continue")).toHaveLength(1);
  // A goal with no check behind it resumes with its objective alone.
  const plain = session();
  await goals.set(plain.id, { objective: "ship it" });
  await goals.patch(plain.id, { status: "paused" });
  await goals.patch(plain.id, { status: "pursuing" });
  expect(said(plain.id, "resume").map((e) => e.data.text)).toEqual(["[harness] The goal is back on. Continue toward it:\nship it"]);
});

test("a draining daemon asks no judge and starts no verifier: the check is the next start's", async () => {
  // The turn ends inside the drain.
  const late = session();
  await goals.set(late.id, { objective: "ship it" });
  turn(late.id, 5);
  // The judge is asked before the drain and answers met inside it.
  const met = session();
  await goals.set(met.id, { objective: "ship it" });
  turn(met.id, 5);
  const check = goals.afterTurn(met.id, "end_turn");
  const answer = verdict;
  draining = true;
  await goals.afterTurn(late.id, "end_turn");
  expect(asks(late.id)).toBe(0);
  answer('{"verdict": "met", "reason": "it looks done"}');
  await check;
  for (const id of [late.id, met.id]) {
    expect(goals.get(id)).toMatchObject({ status: "pursuing", turns: 1 });
    expect(goals.get(id)!.verifying ?? false).toBe(false);
    expect(goals.get(id)!.verifier_session ?? null).toBeNull();
  }
  expect(goals.get(met.id)!.tokens_used).toBe(7); // the judge's request was paid for

  const before = asked.length;
  restart(late.id, met.id);
  await until(() => asks(late.id) === 1 && asks(met.id) === 2);
  for (const answer of asked.slice(before)) answer('{"verdict": "not_met", "reason": "no test run yet"}');
  await until(() => said(late.id, "continue").length && said(met.id, "continue").length);
  expect(goals.get(late.id)).toMatchObject({ status: "pursuing", turns: 1, tokens_used: 7 });
  expect(goals.get(met.id)).toMatchObject({ status: "pursuing", turns: 1, tokens_used: 9 });
});

test("a goal from before turn ends were marked is not woken by a start: it goes on at its next turn end", async () => {
  const s = session();
  // The row as the build before wrote it: no id, no marks, its continuation lost.
  const now = Date.now();
  store.db.query("INSERT INTO goals (session_id, data) VALUES (?, ?)").run(s.id, JSON.stringify({
    session_id: s.id, objective: "ship it", status: "pursuing", token_budget: null, max_turns: null, tokens_used: 100, turns: 3, idle_turns: 0,
    started_ms: now - 60_000, updated_ms: now, judge_model: null, verifier_model: null, rev: 1,
  }));
  store.append(s.id, "user", { text: "go" });
  turn(s.id, 10);
  restart(s.id);
  await quiet();
  expect(asks(s.id)).toBe(0);
  expect(store.events(s.id).filter((e) => e.kind === "user")).toHaveLength(1);
  expect(goals.get(s.id)).toMatchObject({ status: "pursuing", turns: 3, tokens_used: 100 });
  // Its session's next turn (a loop's, the owner's) ends: counted and judged as any turn.
  store.append(s.id, "user", { text: "tick", kind: "loop" });
  turn(s.id, 5);
  const check = goals.afterTurn(s.id, "end_turn");
  verdict('{"verdict": "not_met", "reason": "more to do"}');
  await check;
  expect(goals.get(s.id)).toMatchObject({ status: "pursuing", turns: 4, tokens_used: 107 });
  expect(said(s.id, "continue")).toHaveLength(1);
});

test("a judge whose model does not come up at a start is not asked, and the goal stays pursuing", async () => {
  const s = session();
  await goals.set(s.id, { objective: "ship it" });
  turn(s.id, 5);
  draining = true;
  await goals.afterTurn(s.id, "end_turn"); // counted, its check owed to the next start
  process.env.KEEL_GOAL_READY_GAP_MS = "1";
  modelUp = false;
  try {
    restart(s.id);
    await Bun.sleep(80); // every try made
  } finally {
    modelUp = true;
    delete process.env.KEEL_GOAL_READY_GAP_MS;
  }
  expect(asks(s.id)).toBe(0);
  expect(goals.get(s.id)).toMatchObject({ status: "pursuing", turns: 1 });
});

test("a resume whose prompt was lost in a drain is sent at the next start, the stopped turn not paused again", async () => {
  const s = session();
  await goals.set(s.id, { objective: "ship it" });
  store.append(s.id, "turn_start", {});
  store.append(s.id, "turn_end", { reason: "interrupted", stopped_by: "owner", usage: usage(5) });
  await goals.afterTurn(s.id, "interrupted");
  expect(goals.get(s.id)).toMatchObject({ status: "paused", status_reason: "the owner stopped the turn" });
  draining = true;
  await goals.patch(s.id, { status: "pursuing" }); // its prompt waits in a daemon that is going down
  expect(said(s.id, "resume")).toHaveLength(0);
  restart(s.id);
  await until(() => said(s.id, "resume").length);
  await quiet();
  expect(asks(s.id)).toBe(0);
  expect(said(s.id, "resume")).toHaveLength(1);
  expect(goals.get(s.id)).toMatchObject({ status: "pursuing", turns: 1 });
});

test("a restart that is called off checks the goal turn its drain put off", async () => {
  const s = session();
  await goals.set(s.id, { objective: "ship it" });
  turn(s.id, 5);
  draining = true;
  await goals.afterTurn(s.id, "end_turn");
  expect(asks(s.id)).toBe(0);
  // The backup before the restart failed: the same daemon goes on.
  draining = false;
  const before = asked.length;
  goals.recheckOwed();
  await until(() => asks(s.id) === 1);
  asked.slice(before)[0]!('{"verdict": "not_met", "reason": "no test run yet"}');
  await until(() => said(s.id, "continue").length);
  expect(goals.get(s.id)).toMatchObject({ status: "pursuing", turns: 1 });
});
