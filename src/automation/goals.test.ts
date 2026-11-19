// The goal's accounting and the shared task list, driven the way the turn
// hooks drive them, with a stand-in engine: what the model's plan tool and the
// judge do in a real turn cannot be made to happen on cue from the page.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { setDeps } from "./core.ts";
import * as activity from "./activity.ts";
import * as goals from "./goals.ts";

const store = new Store(mkdtempSync(join(tmpdir(), "keel-goals-")));
let running = false;
let verdict: (text: string) => void = () => {};
const engine = {
  isRunning: () => running,
  send: (id: string, text: string, o: any) => ({ event: store.append(id, "user", { text, ...o?.meta }) }),
  ask: () => new Promise((res) => (verdict = (text) => res({ blocks: [{ type: "text", text }], usage: { input: 1, output: 1 }, model_id: "m" }))),
};
setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine } as any);
activity.migrate();
goals.migrate();
const session = () => store.createSession({ model: "m", workspace: "/", title: "t" });
const usage = (n: number) => ({ input: n, output: 0, cache_read: 0, cache_write: 0 });

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

test("a paused goal is not resumed in an archived session", async () => {
  const s = session();
  await goals.set(s.id, { objective: "ship it" });
  goals.patch(s.id, { status: "paused" });
  store.updateSession(s.id, { archived: true });
  expect(() => goals.patch(s.id, { status: "pursuing" })).toThrow(/archived/);
  expect(goals.get(s.id)!.status).toBe("paused");
});
