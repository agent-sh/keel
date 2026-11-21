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
import * as waits from "./waits.ts";

const store = new Store(mkdtempSync(join(tmpdir(), "keel-goals-")));
let running = false;
// The scripted judge: each request waits for its answer; `verdict` answers the newest.
const asked: ((text: string) => void)[] = [];
let verdict: (text: string) => void = () => {};
// The scripted verifier: its child session's turn runs until `verifierSays` ends it.
const live = new Set<string>();
const engine = {
  isRunning: (id: string) => running || live.has(id),
  interrupt: async () => {},
  send: (id: string, text: string, o: any) => {
    if (store.session(id)?.parent_id) live.add(id);
    return { event: store.append(id, "user", { text, ...o?.meta }) };
  },
  ask: () => new Promise((res) => asked.push((verdict = (text) => res({ blocks: [{ type: "text", text }], usage: { input: 1, output: 1 }, model_id: "m" })))),
};
setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine, providers: { resolve: async (id: string) => ({ info: { id } }) } } as any);
activity.migrate();
agents.migrate();
waits.migrate();
goals.migrate();
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

test("a paused goal is not resumed in an archived session", async () => {
  const s = session();
  await goals.set(s.id, { objective: "ship it" });
  await goals.patch(s.id, { status: "paused" });
  store.updateSession(s.id, { archived: true });
  await expect(goals.patch(s.id, { status: "pursuing" })).rejects.toThrow(/archived/);
  expect(goals.get(s.id)!.status).toBe("paused");
});
