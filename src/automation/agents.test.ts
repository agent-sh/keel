import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

test("Claude Code agents keep auto, acceptEdits and bypassPermissions distinct", () => {
  const cwd = mkdtempSync(join(tmpdir(), "keel-agent-modes-"));
  const folder = join(cwd, ".claude", "agents");
  mkdirSync(folder, { recursive: true });
  for (const mode of ["auto", "acceptEdits", "bypassPermissions"])
    writeFileSync(join(folder, `fixture-${mode}.md`), `---\npermissionMode: ${mode}\n---\nScratch agent.`);
  const modes = agents.definitions(cwd).filter((d) => d.file?.startsWith(folder)).map((d) => [d.name, d.permissionMode]);
  expect(Object.fromEntries(modes)).toEqual({ "fixture-auto": "auto", "fixture-acceptEdits": "auto-edits", "fixture-bypassPermissions": "full-auto" });
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

test("blocking spawns wake on failed admission and a raised limit, and detach when cancelled", async () => {
  const p = store.createSession({ model: parent.model, workspace: dir, title: "Slots" });
  store.append(p.id, "assistant", { blocks: [] });
  const input = { prompt: "Hold a slot", isolation: "none" } as const;
  agents.setLimit(p.id, 1);
  const failing = agents.spawn(p.id, { ...input, model: "missing" });
  const blocking = () => agents.spawn(p.id, { ...input, background: false });
  const first = blocking();
  await expect(failing).rejects.toThrow("no listed model");
  await settled();
  const [a] = agents.list(p.id);
  expect(a?.status).toBe("running");

  const ctl = new AbortController();
  const cancelled = agents.spawn(p.id, { ...input, background: false }, ctl.signal);
  ctl.abort();
  await expect(cancelled).rejects.toThrow("cancelled");
  const second = blocking();
  agents.setLimit(p.id, 2);
  await settled();
  const [_, b] = agents.list(p.id);
  expect(b?.status).toBe("running");
  end(a!, "end_turn");
  end(b!, "end_turn");
  expect((await Promise.all([first, second])).map((r) => r.status)).toEqual(["completed", "completed"]);
});

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

// Live, no restart: a wait rereads the first report, and before its result is
// stored the child finishes a second task. Storing the old result acks only
// the report it holds: the second stays owed and goes out once.
test("a wait result holding an earlier report does not ack a newer one", async () => {
  busy.add(parent.id);
  const a = await spawn();
  end(a, "end_turn", "report J");
  await settled();
  const first = await tool("wait_agent").run({ targets: [a.id] }, { ...ctx, callId: "wj1" });
  ackStoredWaits(parent.id, [{ tool_use_id: "wj1", content: first.content }]);
  const again = await tool("wait_agent").run({ targets: [a.id] }, { ...ctx, callId: "wj2" }); // still the first report
  await agents.send(a.id, "task two");
  end(a, "end_turn", "report K");
  await settled();
  ackStoredWaits(parent.id, [{ tool_use_id: "wj2", content: again.content }]); // the old result is stored now
  expect(agents.get(a.id)!.handback).toBe(true);
  busy.delete(parent.id);
  sends.length = 0;
  flush(parent.id);
  expect(sends.filter((x) => x.id === parent.id && x.text.includes("report K"))).toHaveLength(1);
});

// The parent is busy with the child's first report queued; the child is sent
// a second task and reports again before the queue goes out. Each report is
// its own: both reach the parent, in order, and sending the first never marks
// the second delivered. Also with the queue flushed before the second task,
// and with the same words twice.
for (const [name, flushFirst, second] of [["a newer report", false, "report M"], ["flushed first", true, "report M"], ["the same words", false, "report L"]] as const) {
  test(`queued reports of two tasks both reach the parent (${name})`, async () => {
    busy.add(parent.id);
    sends.length = 0;
    const a = await spawn();
    end(a, "end_turn", "report L");
    await settled();
    if (flushFirst) { busy.delete(parent.id); flush(parent.id); busy.add(parent.id); }
    await agents.send(a.id, "task two");
    end(a, "end_turn", second);
    await settled();
    busy.delete(parent.id);
    flush(parent.id);
    const got = sends.filter((x) => x.id === parent.id).map((x) => x.text).join("\n").split(`agent_id="${a.id}"`).slice(1).map((t) => t.split("</subagent_result>")[0]!.trim().split("\n").at(-1));
    expect(got).toEqual(["report L", second]);
    expect(agents.get(a.id)!.handback).toBeFalsy();
  });
}

// A report still queued to a busy parent when the child is sent a new task,
// then the daemon dies: the report is owed on disk, so the next start
// delivers it once, and the second task's report later goes out on its own.
test("a queued report survives a new task and a crash", async () => {
  busy.add(parent.id);
  const a = await spawn();
  end(a, "end_turn", "report N");
  await settled();
  await agents.send(a.id, "task two");
  dropPending(parent.id); // the crash: the queue was only in memory
  agents.recover();
  busy.delete(parent.id);
  sends.length = 0;
  flush(parent.id);
  const mine = () => sends.filter((x) => x.id === parent.id && x.text.includes(`agent_id="${a.id}"`)).map((x) => x.text);
  expect(mine().filter((t) => t.includes("report N"))).toHaveLength(1);
  sends.length = 0;
  end(a, "end_turn", "report O");
  await settled();
  flush(parent.id);
  expect(mine().map((t) => [t.includes("report N"), t.includes("report O")])).toEqual([[false, true]]);
  expect(agents.get(a.id)!.handback).toBeFalsy();
  dropPending(parent.id);
  agents.recover(); // nothing is owed any more
  sends.length = 0;
  flush(parent.id);
  expect(mine()).toEqual([]);
});

// The first wait on a report still queued to the busy parent, its result
// stored only after the child finished a second task: the stored result
// settles the report it holds (that queue entry too), and the newer one
// still goes out, once.
test("a wait result settles the report it holds while a newer one is owed", async () => {
  busy.add(parent.id);
  const a = await spawn();
  end(a, "end_turn", "report P");
  await settled();
  const out = await tool("wait_agent").run({ targets: [a.id] }, { ...ctx, callId: "wp" }); // reads the queued report
  await agents.send(a.id, "task two");
  end(a, "end_turn", "report Q");
  await settled();
  ackStoredWaits(parent.id, [{ tool_use_id: "wp", content: out.content }]); // its result is stored now
  busy.delete(parent.id);
  sends.length = 0;
  flush(parent.id);
  const mine = sends.filter((x) => x.id === parent.id && x.text.includes(`agent_id="${a.id}"`)).map((x) => [x.text.includes("report P"), x.text.includes("report Q")]);
  expect(mine).toEqual([[false, true]]);
  dropPending(parent.id);
  agents.recover(); // nothing is owed any more
  sends.length = 0;
  flush(parent.id);
  expect(sends.filter((x) => x.id === parent.id && x.text.includes(`agent_id="${a.id}"`))).toEqual([]);
});

// A message to an agent whose turn just ended, while its report is still
// being settled (a work agent's worktree is checked first): the message
// continues it as a new task, so the agent is running, not "done" while its
// session works, and that task's report reaches the parent too.
test("a message sent while an agent's report settles continues it", async () => {
  const repo = mkdtempSync(join(tmpdir(), "keel-agents-repo-"));
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: repo });
  const p = store.createSession({ model: "m:x", workspace: repo, title: "work parent" });
  store.append(p.id, "assistant", { blocks: [] });
  busy.add(p.id);
  const a = await agents.spawn(p.id, { prompt: "do it", isolation: "worktree", background: true });
  expect(agents.get(a.id)!.worktree).toBeTruthy();
  end(a, "end_turn", "report R"); // settling starts: the worktree is read
  await agents.send(a.id, "one more thing");
  await Bun.sleep(300);
  expect(agents.get(a.id)!.status).toBe("running");
  end(a, "end_turn", "report S");
  await Bun.sleep(300);
  busy.delete(p.id);
  sends.length = 0;
  flush(p.id);
  const to = sends.filter((x) => x.id === p.id).map((x) => x.text).join("\n");
  expect([to.includes("report R"), to.includes("report S")]).toEqual([true, true]);
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
  expect(agents.get(done.id)).toMatchObject({ status: "completed" });
  expect(sends.some((x) => x.id === done.session_id)).toBe(false);
  expect(agents.get(cut.id)).toMatchObject({ status: "running" });
  expect(sends.filter((x) => x.id === cut.session_id).map((x) => x.text).join("")).toContain("Continue your task");
});

test("a blocking spawn cancelled before its task is sent owes its stopped parent no report", async () => {
  const p = store.createSession({ model: parent.model, workspace: dir, title: "cold" }); // no reply yet: the second agent waits behind the first
  await agents.spawn(p.id, { prompt: "lead", isolation: "none", background: true });
  const ctl = new AbortController();
  const blocked = agents.spawn(p.id, { prompt: "second", isolation: "none", background: false }, ctl.signal);
  await settled();
  const b = agents.list(p.id).find((a) => !sends.some((s) => s.id === a.session_id))!;
  busy.add(p.id); // the parent's stopped turn is still ending
  ctl.abort();
  expect((await blocked).status).toBe("stopped");
  await settled();
  expect(agents.get(b.id)).toMatchObject({ status: "stopped", stopped_by: "parent_turn", handback: false });
  expect(store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM agent_owed WHERE agent_id = ?").get(b.id)!.n).toBe(0);
  busy.delete(p.id);
});

// What a signal still holds of the calls it was given to.
function listenersOf(signal: AbortSignal) {
  const held = new Set<unknown>();
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, fn: any, o: any) => (held.add(fn), add(type, fn, o))) as any;
  signal.removeEventListener = ((type: string, fn: any, o: any) => (held.delete(fn), remove(type, fn, o))) as any;
  return held;
}

test("a wait that ends without a result leaves nothing registered on its agent", async () => {
  const a = await spawn();
  // A signal aborted before the wait: back at once, not at the timeout.
  const off = new AbortController();
  off.abort();
  const t0 = performance.now();
  const early = await Promise.race([agents.waitAll(parent.id, [a.id], 10_000, off.signal), Bun.sleep(1000).then(() => undefined)]);
  expect(early?.map((r) => r.status)).toEqual(["running"]);
  expect(performance.now() - t0).toBeLessThan(1000);
  // Waits that time out, one after another, on an agent still running.
  const ctl = new AbortController();
  const held = listenersOf(ctl.signal);
  for (let i = 0; i < 5; i++) expect((await agents.waitAll(parent.id, [a.id], 5, ctl.signal))[0]!.status).toBe("running");
  expect(agents.waitersOn(a.id)).toBe(0);
  expect(held.size).toBe(0);
  // A wait after them still gets the final report.
  const last = agents.waitAll(parent.id, [a.id], 10_000, ctl.signal);
  expect(agents.waitersOn(a.id)).toBe(1);
  end(a, "end_turn", "the final report");
  expect((await last)[0]).toMatchObject({ status: "completed", result: "the final report" });
  expect(agents.waitersOn(a.id)).toBe(0);
  expect(held.size).toBe(0);
});

test("a blocking spawn leaves no listener on its caller's signal, and a parent turn stopped under it is owed no report", async () => {
  const done = new AbortController();
  const held = listenersOf(done.signal);
  const first = agents.spawn(parent.id, { prompt: "do it", isolation: "none", background: false }, done.signal);
  await settled();
  const a = agents.list(parent.id).at(-1)!;
  expect(agents.waitersOn(a.id)).toBe(1);
  end(a, "end_turn");
  expect((await first).status).toBe("completed");
  expect(agents.waitersOn(a.id)).toBe(0);
  expect(held.size).toBe(0);

  // The parent's turn stops while the agent's own turn runs: the agent ends a
  // moment later, after the call that held it has returned.
  const ctl = new AbortController();
  const second = agents.spawn(parent.id, { prompt: "do it", isolation: "none", background: false }, ctl.signal);
  await settled();
  const b = agents.list(parent.id).at(-1)!;
  busy.add(b.session_id);
  const interrupt = engine.interrupt;
  engine.interrupt = async (id, by) => { await Bun.sleep(1); await interrupt(id, by); };
  try {
    ctl.abort();
    await second;
    expect(agents.waitersOn(b.id)).toBe(0);
    await settled();
  } finally {
    engine.interrupt = interrupt;
  }
  expect(agents.get(b.id)).toMatchObject({ status: "stopped", stopped_by: "parent_turn", handback: false });
  expect(store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM agent_owed WHERE agent_id = ?").get(b.id)!.n).toBe(0);
});

test("a blocking agent another actor stopped first owes its stopped parent no report either", async () => {
  const ctl = new AbortController();
  const call = agents.spawn(parent.id, { prompt: "do it", isolation: "none", background: false }, ctl.signal);
  await settled();
  const b = agents.list(parent.id).at(-1)!;
  busy.add(b.session_id);
  const interrupt = engine.interrupt;
  engine.interrupt = async (id, by) => { await Bun.sleep(1); await interrupt(id, by); };
  try {
    agents.stop(b.id, "owner"); // the owner stops the agent: its turn is still ending
    ctl.abort(); // and then the parent's turn
    await call;
    await settled();
  } finally {
    engine.interrupt = interrupt;
  }
  expect(agents.get(b.id)).toMatchObject({ status: "stopped", stopped_by: "owner", handback: false });
  expect(store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM agent_owed WHERE agent_id = ?").get(b.id)!.n).toBe(0);
});
