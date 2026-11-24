// A tool that acts is not declared a read. Each reader of the declaration is held to it with the real tool
// definitions: the gate's modes, the Auto judge, the checkpoints, the stored-call marks and the wakeup's own
// target. `readOnly` means nothing changes outside the call's result; `kind: "own"` acts on what Keel keeps
// for the session and runs in every mode; a tool that acts beyond the turn (a schedule) asks.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import { setDeps } from "../automation/core.ts";
import * as loops from "../automation/loops.ts";
import { automationTools } from "../automation/tools.ts";
import { memoryTools } from "../helper/memtools.ts";
import { claudeTools } from "../tools/claude.ts";
import { geminiTools } from "../tools/gemini.ts";
import { gptTools } from "../tools/gpt.ts";
import type { Tool } from "../tools/types.ts";
import { changesNoFiles } from "./checkpoints.ts";
import { Gate } from "./gate.ts";
import { classOf, type MarkTool } from "./marks.ts";
import { classify, decide, type Facts, type Mode } from "./policy.ts";

const all: Tool[] = [...automationTools, ...claudeTools, ...geminiTools, ...gptTools, ...memoryTools(() => ({}) as any)];
const tool = (name: string) => all.find((t) => t.name === name)!;
const facts = (mode: Mode, name: string): Facts => ({ mode, workspace: "/w/repo", sandboxed: false, rules: [], tool: name });
const ruling = (name: string, mode: Mode, input: unknown = {}) => {
  const d = decide(classify(tool(name), input, "/w/repo"), facts(mode, name));
  return "allow" in d ? "allow" : "deny" in d ? "deny" : "ask";
};
const MODES: Mode[] = ["read-only", "plan", "ask", "auto-edits", "auto", "full-auto"];

// Starts an agent, messages one, sets or cancels a wait or a wakeup, keeps a todo, a plan step or a memory record,
// alerts the owner: acts only on what Keel keeps, so it runs in every mode.
const OWN = ["Agent", "spawn_agent", "SendMessage", "send_input", "close_agent", "WaitFor", "wait_for", "cancel_wait", "ScheduleWakeup", "schedule_wakeup", "CronDelete", "schedule_delete", "PushNotification", "notify", "TodoWrite", "write_todos", "update_plan", "helper__memory_put", "helper__memory_delete", "helper__memory_import"];
// Leaves a prompt that runs by itself for 30 days: asks, is judged in Auto, refused in Read only and Plan.
const SCHEDULES = ["CronCreate", "schedule_create"];
// Only reads.
const READS = ["CronList", "schedule_list", "wait_agent", "keel__agents_now"];

test("no tool that acts is declared a read, and the declaration says which kind of act", () => {
  for (const n of OWN) expect([n, tool(n).readOnly, tool(n).kind]).toEqual([n, false, "own"]);
  for (const n of SCHEDULES) expect([n, tool(n).readOnly, tool(n).kind]).toEqual([n, false, undefined]);
  for (const n of READS) expect([n, tool(n).readOnly]).toEqual([n, true]);
});

test("the permission modes: a schedule is not a read, an act on the session's own records is not asked", () => {
  for (const n of SCHEDULES) {
    expect([n, ...MODES.map((m) => ruling(n, m, { cron: "10m", prompt: "p" }))]).toEqual([n, "deny", "deny", "ask", "ask", "ask", "allow"]);
  }
  for (const n of OWN) for (const m of MODES) expect([n, m, ruling(n, m)]).toEqual([n, m, "allow"]);
  for (const n of READS) for (const m of MODES) expect([n, m, ruling(n, m)]).toEqual([n, m, "allow"]);
  // Why a schedule is refused in Plan: the model is told the way on.
  const d = decide(classify(tool("CronCreate"), { cron: "10m", prompt: "p" }, "/w/repo"), facts("plan", "CronCreate"));
  expect(d).toMatchObject({ deny: expect.stringContaining("plan mode") });
});

// The real gate: what a call does, with a judge that counts its reviews.
function scratch() {
  const g = new Gate(new Store(mkdtempSync(join(tmpdir(), "keel-acts-"))), new Bus(), () => true);
  g.setSandboxCheck(() => false);
  const session = { id: "s1", workspace: mkdtempSync(join(tmpdir(), "keel-acts-ws-")) } as Session;
  const reviewed: string[] = [];
  g.judge = async (r) => (reviewed.push(r.summary), { allow: true, risk: "low", reason: "fixture", model: "m" });
  const call = (t: Tool, input: unknown, stop = new AbortController()): ToolCall =>
    ({ id: crypto.randomUUID(), tool: t, input, ctx: { sessionId: "s1", cwd: session.workspace, signal: stop.signal, spillDir: session.workspace, seen: new Map() } });
  return { g, session, reviewed, call };
}

test("the gate in Read only and Plan refuses a schedule and lets an agent be started", async () => {
  const { g, session, call } = scratch();
  for (const mode of ["read-only", "plan"] as const) {
    g.setPerm("s1", { mode, sandbox: "off" });
    expect(await g.check(session, call(tool("schedule_create"), { cron: "10m", prompt: "p" }))).toHaveProperty("deny");
    expect(await g.check(session, call(tool("CronCreate"), { cron: "10m", prompt: "p" }))).toHaveProperty("deny");
    expect(await g.check(session, call(tool("spawn_agent"), { message: "look", isolation: "none" }))).not.toHaveProperty("deny");
    expect(await g.check(session, call(tool("notify"), { text: "done" }))).not.toHaveProperty("deny");
  }
});

test("the gate in Ask opens a card for a schedule and none for the session's own acts", async () => {
  const { g, session, call } = scratch();
  g.setPerm("s1", { mode: "ask", sandbox: "off" });
  expect(await g.check(session, call(tool("spawn_agent"), { message: "look", isolation: "none" }))).not.toHaveProperty("deny");
  expect(g.approvals({ pending: true })).toEqual([]);
  const stop = new AbortController();
  const held = g.check(session, call(tool("CronCreate"), { cron: "10m", prompt: "p" }, stop));
  for (let n = 0; n < 200 && !g.approvals({ pending: true }).length; n++) await Bun.sleep(5);
  expect(g.approvals({ pending: true })).toHaveLength(1);
  stop.abort();
  await held;
});

test("Auto's judge reviews a schedule and never the session's own acts or a read", async () => {
  const { g, session, reviewed, call } = scratch();
  g.setPerm("s1", { mode: "auto", sandbox: "off" });
  for (const [n, input] of [["spawn_agent", { message: "look", isolation: "none" }], ["send_input", { target: "a", message: "m" }], ["notify", { text: "x" }], ["write_todos", { todos: [] }], ["schedule_list", {}]] as const)
    expect(await g.check(session, call(tool(n), input))).not.toHaveProperty("deny");
  expect(reviewed).toEqual([]);
  expect(await g.check(session, call(tool("schedule_create"), { cron: "10m", prompt: "p" }))).not.toHaveProperty("deny");
  expect(reviewed).toHaveLength(1);
});

test("a wakeup that starts a loop is judged as a schedule; one that paces a run is the session's own", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "keel-wake-")));
  if (!store.columnExists("sessions", "machine")) store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
  setDeps({ store, bus: new Bus(), errors: { capture() {} } } as any);
  loops.migrate();
  const s = store.createSession({ model: "m", workspace: "/", title: "t" });
  const wake = tool("ScheduleWakeup");
  expect(await wake.target!({ delaySeconds: 120, prompt: "p" }, s.id)).toMatchObject({ readOnly: false, cls: { kind: "other" } });
  expect(await wake.target!({ delaySeconds: 120 }, s.id)).toBeNull(); // no prompt: nothing is started
  expect(await wake.target!({ stop: true, prompt: "p" }, s.id)).toBeNull(); // a stop starts nothing
  // Inside a self-paced run a wakeup only paces it, even with a prompt.
  const { loop } = loops.create({ session_id: s.id, schedule: "auto", prompt: "tick" });
  store.db.query("INSERT INTO loop_runs (id, loop_id, session_id, due_ms, started_ms) VALUES ('r1', ?, ?, ?, ?)").run(loop.id, s.id, Date.now(), Date.now());
  expect(loops.runOpenIn(s.id)).toBe(true);
  expect(await wake.target!({ delaySeconds: 120, prompt: "p" }, s.id)).toBeNull();
});

test("the checkpoints take no snapshot for the session's own acts, and still do for a schedule", () => {
  const c = (n: string) => classify(tool(n), { cron: "10m", prompt: "p", message: "m", text: "t" }, "/w/repo");
  for (const n of OWN) expect([n, changesNoFiles(c(n))]).toEqual([n, true]);
  for (const n of READS) expect([n, changesNoFiles(c(n))]).toEqual([n, true]);
  for (const n of SCHEDULES) expect([n, changesNoFiles(c(n))]).toEqual([n, false]);
  expect(changesNoFiles({ kind: "control" })).toBe(false); // input to a process: it may change files
});

test("a stored call is marked as the gate would judge it: a schedule is a change, the session's own act is not", () => {
  const marks = new Map<string, MarkTool>(all.map((t) => [t.name, { name: t.name, readOnly: t.readOnly, kind: t.kind, props: Object.keys((t.input_schema as any)?.properties ?? {}) }]));
  const args = { workspace: "/w/repo", mcp: [], runCode: "run_code", mcpCall: "mcp_call", shell: "bash" };
  const cls = (name: string) => classOf({ id: "c", name, input: { cron: "10m", prompt: "p" } }, args, marks, new Map()).cls.kind;
  expect(cls("CronCreate")).toBe("other");
  expect(cls("schedule_create")).toBe("other");
  expect(cls("spawn_agent")).toBe("control");
  expect(cls("notify")).toBe("control");
  expect(cls("schedule_list")).toBe("read");
});
