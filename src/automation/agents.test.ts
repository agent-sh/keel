import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { lineage } from "../core/tree.ts";
import { registerHooks } from "../engine/hooks.ts";
import { Engine, toMessages } from "../engine/turn.ts";
import * as activity from "./activity.ts";
import * as agents from "./agents.ts";
import { dropPending, flush, setDeps } from "./core.ts";
import { ackStoredWaits, automationTools, waitAckHooks } from "./tools.ts";
import * as waits from "./waits.ts";

test("an agent in a mode that writes nothing gets no worktree", () => {
  expect(agents.wantsWorktree({}, {}, "ask")).toBe(true);
  expect(agents.wantsWorktree({}, {}, "read-only")).toBe(false);
  expect(agents.wantsWorktree({}, { isolation: "worktree" }, "plan")).toBe(false);
  expect(agents.wantsWorktree({ readOnly: true }, {}, "full-auto")).toBe(false);
  expect(agents.wantsWorktree({}, { isolation: "none" }, "full-auto")).toBe(false);
});

// The parent's side of its agents, with a stand-in engine: a child's turn
// ends when the test says so. Stops, waits, reports and forked context.
const dir = mkdtempSync(join(tmpdir(), "keel-agents-"));
const store = new Store(join(dir, "state"));
const busy = new Set<string>();
const sends: { id: string; text: string }[] = [];
const interrupted: { id: string; by?: string }[] = [];
const engine = {
  isRunning: (id: string) => busy.has(id),
  send: (id: string, text: string, o: any) => (sends.push({ id, text }), { event: store.append(id, "user", { text, ...o?.meta }) }),
  interrupt: async (id: string, by?: string) => { interrupted.push({ id, by }); busy.delete(id); agents.onTurnEnd(id, "interrupted"); },
  lineage: (id: string) => lineage(store.events(id), store.session(id)?.head ?? null),
  idle: async () => {},
};
const bus = new Bus();
setDeps({ store, bus, errors: { capture() {} }, engine, providers: { models: async () => [], resolve: async () => ({ info: {} }), current: () => [] } } as any);
store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT"); // the fleet adds it in the daemon
agents.migrate();
waits.migrate();
activity.migrate();
const parent = store.createSession({ model: "m:x", workspace: dir, title: "parent" });
store.append(parent.id, "assistant", { blocks: [] }); // a warm cache: agents start without the stagger
const spawn = (o: Partial<agents.SpawnInput> = {}) => agents.spawn(parent.id, { prompt: "do it", isolation: "none", background: true, ...o });
const end = (a: agents.AgentRecord, reason: string, text = "report") => {
  store.append(a.session_id, "assistant", { blocks: [{ type: "text", text }] });
  store.append(a.session_id, "turn_end", { reason });
  agents.onTurnEnd(a.session_id, reason);
};
const settled = () => Bun.sleep(5);
const tool = (name: string) => automationTools.find((t) => t.name === name)!;
const ctx = { sessionId: parent.id, cwd: dir, signal: new AbortController().signal, spillDir: dir, seen: new Map() };

test("who stopped an agent is kept, and a second stop does not change it", async () => {
  const a = await spawn();
  agents.stop(a.id, "owner");
  await settled();
  agents.stop(a.id, "parent");
  expect(agents.get(a.id)).toMatchObject({ status: "stopped", stopped_by: "owner" });
  expect(agents.reportBlock(agents.get(a.id)!)).toContain('stopped_by="owner"');
});

test("a running agent the owner stops has its own turn say the owner stopped it", async () => {
  const a = await spawn();
  busy.add(a.session_id);
  agents.stop(a.id, "owner");
  await settled();
  expect(interrupted.filter((x) => x.id === a.session_id).map((x) => x.by)).toEqual(["owner"]);
});

test("a turn that declined or ran out of steps is not a completed agent", async () => {
  const [a, b, c] = [await spawn(), await spawn(), await spawn()];
  end(a, "refusal", "partial");
  end(b, "max_steps", "Running verification.");
  end(c, "end_turn", "all good");
  await settled();
  expect([a, b, c].map((x) => agents.get(x.id)!.status)).toEqual(["incomplete", "incomplete", "completed"]);
  expect(agents.get(b.id)!.result).toContain("step budget");
});

test("wait_agent returns the first final result at once and names a stop as interrupted", async () => {
  const [done, live, stopped] = [await spawn(), await spawn(), await spawn()];
  end(done, "end_turn");
  agents.stop(stopped.id, "parent");
  await settled();
  const t0 = Date.now();
  const r = JSON.parse(String((await tool("wait_agent").run({ targets: [done.id, live.id], timeout_ms: 60_000 }, ctx)).content));
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(r).toMatchObject({ timed_out: false, status: { [done.id]: { completed: "report" }, [live.id]: "running" } });
  const s = JSON.parse(String((await tool("wait_agent").run({ targets: [stopped.id] }, ctx)).content));
  expect(s.status[stopped.id].completed).toBeUndefined();
  expect(s.status[stopped.id].interrupted.by).toBe("parent");
});

test("a report a wait returned is not delivered to the parent again", async () => {
  busy.add(parent.id);
  const [a, b] = [await spawn(), await spawn()];
  end(a, "end_turn", "report A");
  end(b, "end_turn", "report B");
  await settled();
  const out = await tool("wait_agent").run({ targets: [a.id] }, { ...ctx, callId: "w1" });
  ackStoredWaits(parent.id, [{ tool_use_id: "w1", content: out.content }]); // the engine stored the result
  busy.delete(parent.id);
  sends.length = 0;
  flush(parent.id);
  const to = sends.filter((x) => x.id === parent.id).map((x) => x.text).join("\n");
  expect(to).toContain("report B");
  expect(to).not.toContain("report A");
});

test("a report a wait returned stays owed when the turn was stopped before its result was stored", async () => {
  busy.add(parent.id);
  const a = await spawn();
  end(a, "end_turn", "report C");
  await settled();
  await tool("wait_agent").run({ targets: [a.id] }, { ...ctx, callId: "w2" });
  ackStoredWaits(parent.id, [{ tool_use_id: "w2", content: "Interrupted by the user while this tool ran." }]);
  busy.delete(parent.id);
  sends.length = 0;
  flush(parent.id);
  expect(sends.filter((x) => x.id === parent.id).map((x) => x.text).join("\n")).toContain("report C");
});

// The real turn loop: a wait's result is stored while another call of the
// same step still runs, then the daemon dies. The report it holds was
// delivered with that result: the next daemon does not deliver it again.
test("a report a wait returned is delivered once when the daemon dies mid-step", async () => {
  const a = await spawn();
  end(a, "end_turn", "report D");
  await settled();
  registerHooks(waitAckHooks);
  let release!: () => void;
  const held = new Promise<any>((r) => (release = () => r({ content: "held read done" })));
  const tools = [tool("wait_agent"), { name: "held_read", description: "", input_schema: { type: "object" }, readOnly: true, run: () => held } as any];
  const info = { id: "m:x", model: "x", name: "x", family: "gpt", context: 16_000, output: 64, efforts: [], tools: true };
  let asked = 0;
  const provider = { stream: async () => (++asked === 1
    ? { blocks: [{ type: "tool_use", id: "wd", name: "wait_agent", input: { targets: [a.id] } }, { type: "tool_use", id: "hd", name: "held_read", input: {} }], usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, stop: "tool_use", model: "x" }
    : { blocks: [{ type: "text", text: "done" }], usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, stop: "end_turn", model: "x" }) };
  const runner = new Engine(store, bus, { models: async () => [info], current: () => [info], resolve: async () => ({ provider, info }) } as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }) } as any, join(dir, "spill"));
  (runner as any).step = async () => ({ provider, info, tools, system: "s", systemSplit: 0, native: false });
  busy.add(parent.id);
  const stored = () => store.events(parent.id).some((e) => e.kind === "tool_result" && JSON.stringify(e.data).includes("report D"));
  runner.send(parent.id, "wait for it");
  for (let i = 0; i < 200 && !stored(); i++) await Bun.sleep(10);
  expect(stored()).toBe(true);
  // The crash: the held read never settled, the step never ended, nothing in memory survives.
  dropPending(parent.id);
  agents.recover();
  busy.delete(parent.id);
  sends.length = 0;
  flush(parent.id);
  expect(sends.filter((x) => x.id === parent.id && x.text.includes("report D"))).toEqual([]);
  expect(agents.get(a.id)!.handback).toBeFalsy();
  busy.add(parent.id);
  release();
  await runner.idle(parent.id);
  busy.delete(parent.id);
});

// State written before acks went with the result: the wait's result holding
// a report is stored, the child still marked owed. The next start sees the
// report in the parent's history and does not send it again; a wait whose
// result was cut keeps its report owed.
test("at start, a report a stored wait result holds is not delivered again", async () => {
  busy.add(parent.id);
  const [a, b] = [await spawn(), await spawn()];
  end(a, "end_turn", "report E");
  end(b, "end_turn", "report F");
  await settled();
  const out = await tool("wait_agent").run({ targets: [a.id] }, { ...ctx, callId: "we" });
  await tool("wait_agent").run({ targets: [b.id] }, { ...ctx, callId: "wf" });
  store.append(parent.id, "assistant", { blocks: [
    { type: "tool_use", id: "we", name: "wait_agent", input: { targets: [a.id] } },
    { type: "tool_use", id: "wf", name: "wait_agent", input: { targets: [b.id] } },
  ], stop: "tool_use" });
  store.append(parent.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "we", content: out.content }] });
  store.append(parent.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "wf", content: "Interrupted by a daemon restart while this tool ran.", is_error: true }] });
  expect([agents.get(a.id)!.handback, agents.get(b.id)!.handback]).toEqual([true, true]);
  dropPending(parent.id); // a new process
  agents.recover();
  busy.delete(parent.id);
  sends.length = 0;
  flush(parent.id);
  const to = sends.filter((x) => x.id === parent.id).map((x) => x.text).join("\n");
  expect(to).not.toContain("report E");
  expect(to).toContain("report F");
  expect(agents.get(a.id)!.handback).toBeFalsy();
});

// A wait took the child's first report; the child is sent a second task and
// ends with the same words while the parent is busy, then the daemon dies.
// The second report is its own: the next start delivers it once. Also for a
// wait result stored before reports had ids (`legacy`).
for (const legacy of [false, true]) test(`a later report with the same words is delivered after a restart${legacy ? " (a wait result without report ids)" : ""}`, async () => {
  busy.add(parent.id);
  const a = await spawn();
  end(a, "end_turn", "report I");
  await settled();
  const call = legacy ? "wl" : "wn";
  const out = await tool("wait_agent").run({ targets: [a.id] }, { ...ctx, callId: call });
  const content = legacy ? JSON.stringify({ ...JSON.parse(String(out.content)), status: { [a.id]: { completed: "report I" } } }) : out.content;
  store.append(parent.id, "assistant", { blocks: [{ type: "tool_use", id: call, name: "wait_agent", input: { targets: [a.id] } }], stop: "tool_use" });
  store.append(parent.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: call, content }] });
  ackStoredWaits(parent.id, [{ tool_use_id: call, content: out.content }]); // the daemon that stored it acked it
  expect(agents.get(a.id)!.handback).toBeFalsy();
  await agents.send(a.id, "task two");
  end(a, "end_turn", "report I");
  await settled();
  expect(agents.get(a.id)!.handback).toBe(true);
  dropPending(parent.id); // a new process
  agents.recover();
  busy.delete(parent.id);
  sends.length = 0;
  flush(parent.id);
  expect(sends.filter((x) => x.id === parent.id && x.text.includes(`agent_id="${a.id}"`))).toHaveLength(1);
  expect(agents.get(a.id)!.handback).toBeFalsy();
});

// Call ids are unique only within a session: two parents whose waits share
// one each get their own report marked delivered.
test("waits with the same call id in two sessions each mark their own report delivered", async () => {
  const other = store.createSession({ model: "m:x", workspace: dir, title: "other parent" });
  store.append(other.id, "assistant", { blocks: [] });
  busy.add(parent.id);
  busy.add(other.id);
  const a = await spawn();
  const b = await agents.spawn(other.id, { prompt: "do it", isolation: "none", background: true });
  end(a, "end_turn", "report G");
  end(b, "end_turn", "report H");
  await settled();
  const outA = await tool("wait_agent").run({ targets: [a.id] }, { ...ctx, callId: "same" });
  const outB = await tool("wait_agent").run({ targets: [b.id] }, { ...ctx, sessionId: other.id, callId: "same" });
  ackStoredWaits(parent.id, [{ tool_use_id: "same", content: outA.content }]);
  ackStoredWaits(other.id, [{ tool_use_id: "same", content: outB.content }]);
  busy.delete(parent.id);
  busy.delete(other.id);
  sends.length = 0;
  flush(parent.id);
  flush(other.id);
  const to = sends.map((x) => x.text).join("\n");
  expect(to).not.toContain("report G");
  expect(to).not.toContain("report H");
});

test("forked context is the parent's selected branch as its next request reads it", async () => {
  const p = store.createSession({ model: "m:x", workspace: dir, title: "fork" });
  const u1 = store.append(p.id, "user", { text: "old question" });
  store.append(p.id, "assistant", { blocks: [{ type: "text", text: "old answer" }] });
  store.append(p.id, "compaction", { mode: "clear", covered: store.events(p.id).at(-1)!.id });
  const q = store.append(p.id, "user", { text: "Question" });
  store.append(p.id, "assistant", { blocks: [{ type: "text", text: "Discarded" }] }, q.id); // an alternative reply
  store.append(p.id, "assistant", { blocks: [{ type: "text", text: "Selected" }] }, q.id);
  const call = store.append(p.id, "assistant", { blocks: [{ type: "tool_use", id: "call-1", name: "spawn_agent", input: {} }] });
  void u1; void call;
  const a = await agents.spawn(p.id, { prompt: "go on", fork: true, isolation: "none", background: true, call_id: "call-1" });
  const text = JSON.stringify(toMessages(lineage(store.events(a.session_id), store.session(a.session_id)!.head)));
  expect(text).toContain("Question");
  expect(text).toContain("Selected");
  expect(text).not.toContain("Discarded");
  expect(text).not.toContain("old question");
});

test("recovery settles a child whose turn had ended before the daemon went down, and continues one that was cut", async () => {
  const [done, cut] = [await spawn(), await spawn()];
  // done: its reply and end are stored, the end hook never ran.
  store.append(done.session_id, "assistant", { blocks: [{ type: "text", text: "report D" }] });
  store.append(done.session_id, "turn_end", { reason: "end_turn" });
  sends.length = 0;
  agents.recover();
  await settled();
  expect(agents.get(done.id)).toMatchObject({ status: "completed", restarts: 0 });
  expect(sends.some((x) => x.id === done.session_id)).toBe(false);
  expect(agents.get(cut.id)).toMatchObject({ status: "running", restarts: 1 });
  expect(sends.filter((x) => x.id === cut.session_id).map((x) => x.text).join("")).toContain("Continue your task");
});
