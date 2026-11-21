// The goal's accounting and the shared task list, driven the way the turn
// hooks drive them, with a stand-in engine: what the model's plan tool and the
// judge do in a real turn cannot be made to happen on cue from the page.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { setDeps } from "./core.ts";
import * as activity from "./activity.ts";
import * as agents from "./agents.ts";
import * as goals from "./goals.ts";
import { parseVerdict } from "./verify.ts";
import * as waits from "./waits.ts";

let store!: Store;
let running = false;
// The scripted judge: each request waits for its answer; `verdict` answers the newest.
const asked: ((text: string) => void)[] = [];
let verdict: (text: string) => void = () => {};
// The scripted verifier: its child session's turn runs until `verifierSays` ends it.
const live = new Set<string>();
const engine = {
  isRunning: (id: string) => running || live.has(id),
  interrupt: async () => {},
  idle: async () => {},
  send: (id: string, text: string, o: any) => {
    if (store.session(id)?.parent_id) live.add(id);
    return { event: store.append(id, "user", { text, ...o?.meta }) };
  },
  ask: () => new Promise((res) => asked.push((verdict = (text) => res({ blocks: [{ type: "text", text }], usage: { input: 1, output: 1 }, model_id: "m" })))),
};
// A daemon on a state folder; called again on the same folder, the daemon after a restart.
function boot(dir: string) {
  store = new Store(dir);
  setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine, providers: { resolve: async (id: string) => ({ info: { id } }) } } as any);
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

  // A bare met is asked for its evidence once, in the verifier's own context; still bare, the goal is not achieved.
  for (const bare of ['{"verdict": "met", "reason": "all good"}', '{"verdict": "met", "reason": "all good", "evidence": []}', '{"verdict": "met", "reason": "all good", "evidence": ["   "]}']) {
    const g = await judgedMet("ship it");
    verifierSays(g.child, bare);
    await until(() => live.has(g.child));
    verifierSays(g.child, bare);
    await g.check;
    expect(goals.get(g.id)).toMatchObject({ status: "paused", status_reason: expect.stringContaining("no evidence"), verifying: false });
    expect(goals.get(g.id)!.verified ?? false).toBe(false);
  }

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

test("a turn parked for a restart is not judged: its continuation is, and a held one pauses the goal", async () => {
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

  const held = session();
  await goals.set(held.id, { objective: "ship it" });
  goals.onCutTurnHeld(held.id);
  expect(goals.get(held.id)).toMatchObject({ status: "paused", status_reason: expect.stringContaining("restart") });
});
