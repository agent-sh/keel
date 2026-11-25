import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tempTree } from "../../test/env.ts";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { lineage } from "../core/tree.ts";
import { allHooks, registerHooks } from "../engine/hooks.ts";
import { Engine, toMessages } from "../engine/turn.ts";
import * as activity from "./activity.ts";
import * as agents from "./agents.ts";
import * as failures from "./failures.ts";
import * as leftovers from "./leftovers.ts";
import { deliver, dropPending, flush, isPending, setDeps } from "./core.ts";
import { ackStoredWaits, automationTools, messageHooks, waitAckHooks } from "./tools.ts";
import { dropChoice, holdChoice } from "../tools/skill-turn.ts";
import * as waits from "./waits.ts";
import { bindBefore, latest } from "../checks/before-run.ts";
import { bindLedger } from "../checks/ledger.ts";
import { Worktrees } from "../worktree/manager.ts";
import * as writeAsks from "./write-asks.ts";
import { scopes } from "../safety/write-scope.ts";

// Agents get git worktrees here, several git commands each, and on a busy disk one git
// command takes half a second: the 5 s default was passed in whole-suite runs.
setDefaultTimeout(20_000);

// Turn hooks are process-wide: the files after this one run without the ones its tests register.
const hooksAtStart = allHooks().length;
afterAll(() => { allHooks().length = hooksAtStart; });

test("an agent in a mode that writes nothing gets no worktree", () => {
  expect(agents.wantsWorktree({}, {}, "ask")).toBe(true);
  expect(agents.wantsWorktree({}, {}, "read-only")).toBe(false);
  expect(agents.wantsWorktree({}, { isolation: "worktree" }, "plan")).toBe(false);
  expect(agents.wantsWorktree({ readOnly: true }, {}, "full-auto")).toBe(false);
  expect(agents.wantsWorktree({}, { isolation: "none" }, "full-auto")).toBe(false);
});

test("Claude Code agents keep auto, acceptEdits and bypassPermissions distinct", () => {
  const cwd = tempTree("keel-agent-modes-");
  const folder = join(cwd, ".claude", "agents");
  mkdirSync(folder, { recursive: true });
  for (const mode of ["auto", "acceptEdits", "bypassPermissions"])
    writeFileSync(join(folder, `fixture-${mode}.md`), `---\npermissionMode: ${mode}\n---\nScratch agent.`);
  const modes = agents.definitions(cwd).filter((d) => d.file?.startsWith(folder)).map((d) => [d.name, d.permissionMode]);
  expect(Object.fromEntries(modes)).toEqual({ "fixture-auto": "auto", "fixture-acceptEdits": "auto-edits", "fixture-bypassPermissions": "full-auto" });
});

// The parent's side of its agents, with a stand-in engine: a child's turn
// ends when the test says so. Stops, waits, reports and forked context.
const dir = tempTree("keel-agents-");
const store = new Store(join(dir, "state"));
const busy = new Set<string>();
const sends: { id: string; text: string }[] = [];
const interrupted: { id: string; by?: string }[] = [];
const held = new Set<string>(); // sessions whose queue is held
const heldWho = new Map<string, string>(); // who made a hold, as the engine keeps it (none said: the owner)
const parking = new Set<string>(); // sessions whose turn the stopping daemon parks
const engine = {
  isRunning: (id: string) => busy.has(id),
  isParking: (id: string) => parking.has(id),
  isHeld: (id: string) => held.has(id),
  send: (id: string, text: string, o: any) => (sends.push({ id, text }), { event: store.append(id, "user", { text, ...o?.meta }) }),
  // A parent's message to its agent: stored as the agent's prompt (the engine keeps one for a working agent in its queue).
  message: (id: string, text: string, meta: any) => (sends.push({ id, text }), { event: store.append(id, "user", { text, ...meta }) }),
  heldBy: (id: string) => (held.has(id) ? heldWho.get(id) ?? "owner" : undefined),
  holdQueue: (id: string, by?: string) => { held.add(id); heldWho.set(id, by ?? "owner"); },
  // The hold goes when one of `makers` made it, as in the engine.
  releaseHold: (id: string, makers: readonly string[] = []) => {
    if (!held.has(id)) return true;
    if (!makers.includes(heldWho.get(id) ?? "owner")) return false;
    held.delete(id); heldWho.delete(id);
    return true;
  },
  hasInput: () => false,
  interrupt: async (id: string, by?: string) => { interrupted.push({ id, by }); busy.delete(id); agents.onTurnEnd(id, "interrupted"); },
  lineage: (id: string) => lineage(store.events(id), store.session(id)?.head ?? null),
  idle: async () => {},
  // Where a finished agent's follow-up starts: what the decision was given, and the plan a test sets.
  followUp: async (_id: string, o: any) => (followUps.push(o), nextPlan),
  // A declined brief is not restated here: the successor gets it as it was.
  reword: async () => undefined,
};
const followUps: any[] = [];
let nextPlan: any;
const bus = new Bus();
// (The providers whose outage is open: src/providers/outage.ts.)
const outageOpen = new Set<string>();
const baseDeps = { store, bus, errors: { capture() {} }, engine, providers: { models: async () => [], resolve: async () => ({ info: {} }), current: () => [], namedDefault: async () => undefined, routeOf: (m: string) => m, shut: () => undefined, outages: { active: (id: string) => outageOpen.has(id) } } } as any;
setDeps(baseDeps);
store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT"); // the fleet adds it in the daemon
agents.migrate();
waits.migrate();
activity.migrate();
failures.migrate();
const parent = store.createSession({ model: "m:x", workspace: dir, title: "parent" });
store.append(parent.id, "assistant", { blocks: [] }); // a warm cache: agents start without the stagger
const spawn = (o: Partial<agents.SpawnInput> = {}) => agents.spawn(parent.id, { prompt: "do it", isolation: "none", background: true, ...o });
const end = (a: agents.AgentRecord, reason: string, text = "report") => {
  store.append(a.session_id, "assistant", { blocks: [{ type: "text", text }] });
  store.append(a.session_id, "turn_end", { reason });
  agents.onTurnEnd(a.session_id, reason);
};
const settled = () => Bun.sleep(5);
// Both successors of the agent's task were started already: a lost context ends it as before.
const spendSuccessors = (a: agents.AgentRecord) =>
  store.db.query("UPDATE agents SET lost = ? WHERE id = ?").run(JSON.stringify([1, 2].map((n) => ({ kind: "refusal", model: "m:x", family: "other", session: `lost-${n}`, at: n }))), a.id);
const tool = (name: string) => automationTools.find((t) => t.name === name)!;
const ctx = { sessionId: parent.id, cwd: dir, signal: new AbortController().signal, spillDir: dir, seen: new Map() };

test("an agent that messages the session that started it is told that its report is what goes there", async () => {
  const a = await spawn();
  const r = await tool("SendMessage").run({ to: parent.id, message: "a word" }, { ...ctx, sessionId: a.session_id });
  expect(r.is_error).toBe(true);
  expect(String(r.content)).toContain("is the session that started you, not an agent of this tree");
  const other = await tool("SendMessage").run({ to: "no-such-agent", message: "a word" }, { ...ctx, sessionId: a.session_id });
  expect(String(other.content)).toContain("no agent \"no-such-agent\" in this session's tree");
  end(a, "end_turn");
  await settled();
});

// A program (run_code) that messages several agents at once: each message is a call no reply holds. Looking
// for the reply of such a call walked the sender's branch to its start, which on a long session read and
// parsed every reply of its history on the loop, once a message: the daemon answered nothing meanwhile.
test("a message a program sends, or one for a call no reply holds, reads nothing of a long session's history", async () => {
  // A long session as another run of the daemon stored it: none of its events' bodies is in memory here.
  const seed = new Store(join(dir, "state"));
  const long = seed.createSession({ model: "m:x", workspace: dir, title: "long" });
  const RUNS = 20; // the store reads bodies in runs of 64 events
  seed.db.transaction(() => {
    for (let i = 0; i < RUNS * 32; i++) {
      seed.append(long.id, "assistant", { blocks: [{ type: "tool_use", id: `c${i}`, name: "Bash", input: { command: "true" } }] });
      seed.append(long.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: `c${i}`, content: "ok" }] });
    }
  })();
  seed.db.close();
  const kids = [await agents.spawn(long.id, { prompt: "do it", isolation: "none", background: true }), await agents.spawn(long.id, { prompt: "do it", isolation: "none", background: true })];
  const runs = () => { const b = store.bodyReads(); return b.n + b.start.n; };
  const before = runs();
  const top = `c${RUNS * 32 - 1}`;
  const sent = await Promise.all(kids.flatMap((k) => [1, 2, 3].map((n) => tool("SendMessage").run({ to: k.id, message: `main moved (${n})` }, { ...ctx, sessionId: long.id, callId: `${top}~${k.id}${n}`, nestedIn: top }))));
  expect(sent.map((r) => r.is_error ?? false)).toEqual(Array(6).fill(false));
  expect(sends.filter((x) => x.text.includes("main moved")).length).toBe(6);
  expect(runs() - before).toBe(0);
  // A call the newest replies do not hold (asked of every unanswered call when a restart cut a turn) is looked for in them alone.
  expect(messageHooks.callOutcome!(long.id, "no-such-call")).toBeUndefined();
  expect(runs() - before).toBeLessThanOrEqual(1);
  // The call of the reply the turn is on is found there.
  const keys: (string | undefined)[] = [];
  const eng = engine as { message: (...a: any[]) => unknown };
  const message = eng.message;
  eng.message = (id: string, text: string, meta: any, o: any) => (keys.push(o?.key), message(id, text, meta, o));
  try {
    await tool("SendMessage").run({ to: kids[0]!.id, message: "from the turn's own call" }, { ...ctx, sessionId: long.id, callId: top });
  } finally { eng.message = message; }
  expect(keys).toEqual([`call:${store.lineage(long.id).findLast((e) => e.kind === "assistant")!.id}:${top}`]);
  expect(runs() - before).toBeLessThanOrEqual(1);
  for (const k of kids) end(agents.get(k.id)!, "end_turn");
  await settled();
});

test("an agent's task and its parent's messages carry the owner's word only when the sender's turn held it", async () => {
  const eng = engine as { byOwner?: (id: string) => boolean };
  const owners = new Set<string>();
  eng.byOwner = (id) => owners.has(id);
  try {
    const task = (a: agents.AgentRecord) => store.events(a.session_id).find((e) => e.kind === "user" && e.data.kind === "task")!.data.owned;
    const unowned = await spawn();
    owners.add(parent.id);
    const owned = await spawn();
    expect([task(unowned), task(owned)]).toEqual([undefined, true]);
    // A message of the parent's: the parent's turn decides, not the agent's task.
    owners.delete(parent.id);
    await agents.send(unowned.id, "go on");
    owners.add(parent.id);
    await agents.send(unowned.id, "and this");
    const steers = store.events(unowned.session_id).filter((e) => e.kind === "user" && e.data.kind === "steer").map((e) => e.data.owned);
    expect(steers).toEqual([undefined, true]);
    // The owner's own message (the agent's card, a review's fix) is theirs while the parent's turn is nobody's.
    owners.delete(parent.id);
    await agents.send(unowned.id, "from the card", false, undefined, undefined, undefined, undefined, true);
    expect(store.events(unowned.session_id).filter((e) => e.kind === "user" && e.data.kind === "steer").map((e) => e.data.owned)).toEqual([undefined, true, true]);
    end(unowned, "end_turn");
    end(owned, "end_turn");
    await settled();
  } finally { delete eng.byOwner; }
});

test("a spawn names Codex's built-in roles as Keel's types, and a definition of that name goes first", async () => {
  // (The built-ins alone: a machine's own agent files may hold any name.)
  const builtIn = agents.definitions(dir).filter((d) => d.source === "built-in");
  for (const [role, type] of [["explorer", "Explore"], ["worker", "general-purpose"], ["default", "general-purpose"], ["Explorer", "Explore"], [undefined, "general-purpose"]]) {
    expect(agents.defFor(builtIn, role)?.name).toBe(type!);
  }
  expect(agents.defFor(builtIn, "tester")).toBeUndefined();
  const own = { name: "explorer", description: "mine", source: "project" };
  expect(agents.defFor([...builtIn, own], "explorer")).toBe(own);
  // A spawn that names a role starts that type (explorer reads only: no worktree).
  expect((await spawn({ type: "explorer", isolation: undefined })).type).toBe(agents.defFor(agents.definitions(dir), "explorer")!.name);
});

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
  // What is at work is read without the reports of the ended ones.
  expect(agents.live(p.id).map((x) => x.id)).toEqual([a!.id, b!.id]);
  end(a!, "end_turn");
  end(b!, "end_turn");
  expect((await Promise.all([first, second])).map((r) => r.status)).toEqual(["completed", "completed"]);
  expect(agents.live(p.id)).toEqual([]);
});

test("reads of many agents leave their reports in the store, and say how long each is", async () => {
  const p = store.createSession({ model: parent.model, workspace: dir, title: "Lean reads" });
  store.append(p.id, "assistant", { blocks: [] });
  const a = await agents.spawn(p.id, { prompt: "write a long report", isolation: "none", background: true });
  const report = "a long report with caf\u00e9 ".repeat(500);
  end(a, "end_turn", report);
  await settled();
  const whole = agents.get(a.id)!;
  expect(whole.result).toContain("a long report");
  // Every read that lists or walks agents is without the report (a coordinator's agents are mostly reports).
  for (const row of [agents.list(p.id)[0], agents.byChild(a.session_id), agents.tree(p.id)[0]!.agent, agents.shown(p.id)[0]]) {
    expect(row?.id).toBe(a.id);
    expect(row && "result" in row).toBe(false);
    expect(row?.report_chars).toBe(whole.result!.length);
  }
  // The page's frame and list carry the same length whether the report was read or not.
  expect(agents.brief(agents.list(p.id)[0]!)).toEqual(agents.brief(whole));
  expect(agents.brief(whole).report_chars).toBe(whole.result!.length);
  // A definition is read only where it names an external agent.
  expect(agents.list(p.id)[0]!.external).toBeUndefined();
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

test("a turn that declined or ran out of steps is not a completed agent, and a declined reply is not its report", async () => {
  const [a, b, c] = [await spawn(), await spawn(), await spawn()];
  // Both successors of their tasks were started already (src/automation/successor.ts): they end here.
  for (const x of [a, b]) spendSuccessors(x);
  store.append(a.session_id, "assistant", { blocks: [{ type: "text", text: "Looked at the parser." }, { type: "tool_use", id: "t1", name: "Read", input: {} }] });
  store.append(a.session_id, "assistant", { blocks: [{ type: "text", text: "I will not" }], stop: "refusal" });
  store.append(a.session_id, "turn_end", { reason: "refusal" });
  agents.onTurnEnd(a.session_id, "refusal");
  end(b, "max_steps", "Running verification.");
  end(c, "end_turn", "all good");
  await settled();
  expect([a, b, c].map((x) => agents.get(x.id)!.status)).toEqual(["incomplete", "incomplete", "completed"]);
  expect(agents.get(b.id)!.result).toContain("step budget");
  const declined = agents.get(a.id)!.result!;
  expect(declined).toContain("the model declined to go on");
  expect(declined).toContain("Looked at the parser.");
  expect(declined).not.toContain("I will not");
  expect(declined).toContain("Keel started no fresh context for it: 2 successors were started");
});

test("the landing facts of an agent are fields of its record, and a new task clears them", async () => {
  const a = await spawn();
  const facts = { base: "main", tip: "a".repeat(40), behind: 2, dirty: 0, conflict: { state: "conflict", files: ["x.ts"] }, checks: { state: "none" }, branch: "keel/x", ahead: 1, landed: false, proof: "Checks: none" };
  store.db.query("UPDATE agents SET landing = ? WHERE id = ?").run(JSON.stringify(facts), a.id);
  expect(agents.get(a.id)!.landing).toEqual(facts as any);
  expect(agents.list(parent.id).find((x) => x.id === a.id)!.landing).toEqual(facts as any);
  end(a, "end_turn", "Conflicts with main: none");
  await settled();
  // The end wrote what it found (a task with no worktree has none): a quoted line is not the fact.
  expect(agents.get(a.id)!.landing ?? null).toBeNull();
  await agents.send(a.id, "go on");
  end(a, "end_turn", "done");
  await settled();
});

test("a message to an agent whose context the model declined is decided as a declined one, never as a cut mid-work", async () => {
  const a = await spawn();
  spendSuccessors(a);
  store.append(a.session_id, "assistant", { blocks: [{ type: "text", text: "I will not" }], stop: "refusal" });
  store.append(a.session_id, "turn_end", { reason: "refusal" });
  agents.onTurnEnd(a.session_id, "refusal");
  await settled();
  expect(agents.get(a.id)!.status).toBe("incomplete");
  followUps.length = 0;
  nextPlan = undefined;
  await agents.send(a.id, "try again");
  expect(followUps.map((f) => f.ended)).toEqual(["declined"]);
  end(a, "end_turn", "done");
  await settled();
});

test("a context that declines while its own agent works hands the task and the agent to a successor", async () => {
  const a = await spawn();
  store.append(a.session_id, "assistant", { blocks: [] }); // a warm cache: its agent starts without the stagger
  const done = await agents.spawn(a.session_id, { prompt: "look first", isolation: "none", background: true });
  end(done, "end_turn", "the first look");
  await settled();
  flush(a.session_id); // its report is the context's next input, taken before the turn that declines
  const kid = await agents.spawn(a.session_id, { prompt: "look it up", isolation: "none", background: true });
  // A failure of one of its agents is owed to it, worth a turn of its own.
  expect(failures.record(a.session_id, { kind: "agent", cls: "provider error", message: "the request failed", ref: { id: kid.id, label: "look it up" }, tell: "wake" })).toBe(true);
  // Its own failure (what it lost its context to) is not its agents': it stays with it.
  expect(failures.record(a.session_id, { kind: "turn", cls: "provider error", message: "the request failed", tell: "ride" })).toBe(true);
  store.append(a.session_id, "assistant", { blocks: [{ type: "text", text: "I will not" }], stop: "refusal" });
  store.append(a.session_id, "turn_end", { reason: "refusal" });
  agents.onTurnEnd(a.session_id, "refusal");
  await settled();
  const now = agents.get(a.id)!;
  const own = (sid: string) => store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM session_failures WHERE session_id = ? AND kind = 'turn'").get(sid)!.n;
  expect([own(a.session_id), own(now.session_id)]).toEqual([1, 0]);
  // The loss is recorded and a successor started, though its agent still works.
  expect([now.status, now.lost?.map((l) => l.kind), now.session_id === a.session_id]).toEqual(["running", ["refusal"], false]);
  // What the lost context was owed of its agents' failures is the successor's: a start never wakes the lost one for it.
  const owed = (sid: string) => store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM session_failures WHERE session_id = ? AND owed > 0 AND wake = 1").get(sid)!.n;
  expect([owed(a.session_id), owed(now.session_id)]).toEqual([0, 1]);
  // The agent that ended before the handover stays the lost context's, and shows under the successor.
  expect([agents.get(done.id)!.parent_id, agents.shown(now.session_id).map((k) => k.id), agents.tree(now.session_id, true).map((r) => [r.agent.id, r.agent.parent_id])])
    .toEqual([a.session_id, [done.id, kid.id], [[done.id, now.session_id], [kid.id, now.session_id]]]);
  // The agent goes with the task: the successor's capsule names it, and it is the successor's to message or stop.
  expect([agents.get(kid.id)!.parent_id, store.session(kid.session_id)!.parent_id]).toEqual([now.session_id, now.session_id]);
  expect(sends.findLast((x) => x.id === now.session_id)!.text).toContain(`(${kid.id})`);
  // Its report wakes the successor, never the context that declined.
  const from = sends.length;
  end(kid, "end_turn", "what it found");
  await Bun.sleep(400);
  expect(sends.slice(from).filter((x) => x.text.includes("what it found")).map((x) => x.id)).toEqual([now.session_id]);
  agents.stop(a.id);
  // No successor left for the task: it waits for its agent in the same context, as before.
  const b = await spawn();
  spendSuccessors(b);
  store.append(b.session_id, "assistant", { blocks: [] });
  const other = await agents.spawn(b.session_id, { prompt: "look it up", isolation: "none", background: true });
  store.append(b.session_id, "assistant", { blocks: [{ type: "text", text: "I will not" }], stop: "refusal" });
  store.append(b.session_id, "turn_end", { reason: "refusal" });
  agents.onTurnEnd(b.session_id, "refusal");
  await settled();
  expect([agents.get(b.id)!.status, agents.get(b.id)!.session_id, agents.get(other.id)!.parent_id]).toEqual(["running", b.session_id, b.session_id]);
  agents.stop(b.id);
  // A stop while the task is being handed on ends it stopped, with its agent, and starts no successor.
  const c = await spawn();
  store.append(c.session_id, "assistant", { blocks: [] });
  const third = await agents.spawn(c.session_id, { prompt: "look it up", isolation: "none", background: true });
  store.append(c.session_id, "assistant", { blocks: [{ type: "text", text: "I will not" }], stop: "refusal" });
  store.append(c.session_id, "turn_end", { reason: "refusal" });
  agents.onTurnEnd(c.session_id, "refusal");
  agents.stop(c.id, "owner");
  await settled();
  expect([agents.get(c.id)!.status, agents.get(c.id)!.stopped_by, agents.get(c.id)!.session_id, agents.get(c.id)!.lost, agents.get(third.id)!.status]).toEqual(["stopped", "owner", c.session_id, undefined, "stopped"]);
});

test("a lost context gets a successor, but not a step budget, an open outage or a wait the provider asked for", async () => {
  const fail = (a: agents.AgentRecord, data: Record<string, unknown>) => {
    store.append(a.session_id, "error", { message: "HTTP 500: Internal Server Error", ...data });
    store.append(a.session_id, "turn_end", { reason: "error" });
    agents.onTurnEnd(a.session_id, "error");
  };
  const [lost, steps, outage, later] = [await spawn(), await spawn(), await spawn(), await spawn()];
  // A server error past the retries: a fresh context takes the task up (src/automation/successor.ts).
  fail(lost, {});
  // A turn's step budget is the owner's or its definition's: a successor would get it whole again.
  end(steps, "max_steps", "Running verification.");
  await settled();
  outageOpen.add("m");
  try {
    fail(outage, {});
    await settled();
  } finally {
    outageOpen.delete("m");
  }
  // The provider asked to be tried again in an hour, longer than a turn waits.
  fail(later, { retry_at: Date.now() + 3_600_000 });
  await settled();
  const got = (a: agents.AgentRecord) => agents.get(a.id)!;
  expect(got(lost).lost?.map((l) => l.kind)).toEqual(["provider"]);
  expect(got(lost).session_id).not.toBe(lost.session_id);
  expect(got(steps).status).toBe("incomplete");
  expect(got(steps).result).toContain("step budget");
  for (const a of [outage, later]) expect([got(a).status, got(a).lost?.length ?? 0, got(a).session_id]).toEqual(["failed", 0, a.session_id]);
  agents.stop(lost.id);
});

test("a stop that comes once a successor's session is made finds its task there, and nothing is sent after it", async () => {
  const a = await spawn();
  let stoppedAt = -1, next = "";
  // The moment its new session is announced, a stop is on its way (a request of the parent's, a tick later).
  const off = bus.on((f: any) => {
    if (f.t !== "session" || f.session.id === a.session_id || f.session.parent_id !== parent.id || next) return;
    next = f.session.id;
    queueMicrotask(() => { stoppedAt = sends.length; agents.stop(a.id); });
  });
  try {
    store.append(a.session_id, "error", { message: "HTTP 500: Internal Server Error" });
    store.append(a.session_id, "turn_end", { reason: "error" });
    agents.onTurnEnd(a.session_id, "error");
    await settled();
  } finally {
    off();
  }
  expect(next).not.toBe("");
  expect(stoppedAt).toBeGreaterThanOrEqual(0);
  // Its task went in before the stop (which then stops that), never into a session it was stopped in.
  expect(sends.slice(stoppedAt).filter((x) => x.id === next)).toEqual([]);
  expect(sends.slice(0, stoppedAt).some((x) => x.id === next)).toBe(true);
  expect(agents.get(a.id)!.status).toBe("stopped");
});

test("a later task that is lost has a successor briefed with that task, and each new task has both successors again", async () => {
  const fail = (a: agents.AgentRecord) => {
    store.append(a.session_id, "error", { message: "HTTP 500: Internal Server Error" });
    store.append(a.session_id, "turn_end", { reason: "error" });
    agents.onTurnEnd(a.session_id, "error");
  };
  const briefOf = (a: agents.AgentRecord) => sends.filter((x) => x.id === agents.get(a.id)!.session_id).map((x) => x.text).join("\n");
  // A finished agent's next task, from its parent, lost to its provider.
  const a = await spawn({ prompt: "FIRST TASK alpha", title: "Later task" });
  end(a, "end_turn", "done one");
  await settled();
  await agents.send(a.id, "SECOND TASK beta");
  fail(a);
  await settled();
  expect(agents.get(a.id)!.lost?.length).toBe(1);
  expect(briefOf(a)).toContain("SECOND TASK beta");
  expect(briefOf(a)).not.toContain("FIRST TASK alpha");
  agents.stop(a.id);
  // A task the owner starts on a finished agent's page whose task used both successors: it has both again.
  const b = await spawn({ prompt: "FIRST TASK gamma", title: "Owner task" });
  spendSuccessors(b);
  end(b, "end_turn", "done one");
  await settled();
  store.append(b.session_id, "user", { text: "THIRD TASK delta" });
  agents.onTurnStart(b.session_id);
  expect(agents.get(b.id)!.lost).toBeUndefined();
  fail(b);
  await settled();
  expect(agents.get(b.id)!.lost?.length).toBe(1);
  expect(briefOf(b)).toContain("THIRD TASK delta");
  expect(briefOf(b)).not.toContain("FIRST TASK gamma");
  agents.stop(b.id);
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
  const repo = tempTree("keel-agents-repo-");
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

test("a fork's spawn result says what a step of it costs beside a fresh agent's", async () => {
  const p = store.createSession({ model: "m:x", workspace: dir, title: "fork price" });
  const usage = (read: number, write = 0) => ({ input: 0, output: 10, cache_read: read, cache_write: write });
  store.append(p.id, "user", { text: "first" });
  store.append(p.id, "assistant", { blocks: [{ type: "text", text: "one" }], usage: usage(0, 12_000) });
  store.append(p.id, "user", { text: "later" });
  store.append(p.id, "assistant", { blocks: [{ type: "text", text: "two" }], usage: usage(300_000, 10_000) });
  store.append(p.id, "assistant", { blocks: [{ type: "tool_use", id: "call-p", name: "Agent", input: {} }] });
  const was = baseDeps.providers.resolve;
  baseDeps.providers.resolve = async () => ({ info: { price: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } } });
  try {
    const a = await agents.spawn(p.id, { prompt: "go on", fork: true, isolation: "none", background: true, call_id: "call-p" });
    const said = agents.spawnNotes(a.id);
    // 310K tokens (the last reply read 300K and wrote 10K) read at 0.5 a million, and the 12K a fresh agent starts from.
    expect(said).toContain("about 310K tokens");
    expect(said).toContain("$0.155 a step");
    expect(said).toContain("A fresh agent starts from about 12K tokens (about $0.0060 a step)");
    // Said once: the map does not keep it.
    expect(agents.spawnNotes(a.id)).not.toContain("A fork starts");
    // A fresh agent says nothing of it.
    expect(agents.spawnNotes((await agents.spawn(p.id, { prompt: "fresh", isolation: "none", background: true })).id)).not.toContain("A fork starts");
    // A model with no listed price: the tokens, and why no dollars.
    baseDeps.providers.resolve = async () => ({ info: {} });
    const b = await agents.spawn(p.id, { prompt: "again", fork: true, isolation: "none", background: true, call_id: "call-p" });
    expect(agents.spawnNotes(b.id)).toContain("lists no price");
  } finally {
    baseDeps.providers.resolve = was;
  }
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

test("a restart that parks the parent's turn leaves its blocking agent working, and the cut call says its report comes", async () => {
  const p = store.createSession({ model: parent.model, workspace: dir, title: "parked parent" });
  store.append(p.id, "assistant", { blocks: [{ type: "tool_use", id: "call-park", name: "Agent", input: { prompt: "review it" } }] });
  const ctl = new AbortController();
  const call = agents.spawn(p.id, { prompt: "review it", isolation: "none", background: false, call_id: "call-park" }, ctl.signal);
  await settled();
  const a = agents.list(p.id).at(-1)!;
  busy.add(a.session_id);
  parking.add(p.id);
  try {
    ctl.abort();
    await call;
    await settled();
    expect(agents.get(a.id)).toMatchObject({ status: "running" });
    expect(interrupted.some((x) => x.id === a.session_id)).toBe(false);
    expect((messageHooks.callOutcome!(p.id, "call-park") as { done: string }).done).toContain(`waited on agent ${a.id}`);
  } finally {
    parking.delete(p.id);
  }
  // In the next daemon it finishes, and its report goes to the parent.
  busy.delete(a.session_id);
  end(a, "end_turn", "the review");
  await settled();
  expect(agents.get(a.id)).toMatchObject({ status: "completed", handback: true });
  expect(messageHooks.callOutcome!(p.id, "call-park")).toBeUndefined();
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

// A parent with a warm cache of its own, so one test's agents and reports are its own.
const parentOf = (title: string) => {
  const p = store.createSession({ model: parent.model, workspace: dir, title });
  store.append(p.id, "assistant", { blocks: [] });
  return { ...p, to: () => sends.filter((x) => x.id === p.id).map((x) => x.text), start: (o: Partial<agents.SpawnInput> = {}) => agents.spawn(p.id, { prompt: "do it", isolation: "none", background: true, ...o }) };
};

// The owner stopped the parent's turn: its queue is held and nothing starts by
// itself. A report stays owed and goes after the owner's next turn; a wait
// still returns it.
test("a report does not restart a parent held after the owner's Stop", async () => {
  const p = parentOf("held parent");
  const a = await p.start();
  held.add(p.id);
  end(a, "end_turn", "report held A");
  await Bun.sleep(400); // past the wait that lets a burst arrive together
  expect(p.to()).toEqual([]);
  // A report lined up while the turn ran is not sent at the stop either.
  held.delete(p.id);
  busy.add(p.id);
  const b = await p.start();
  end(b, "end_turn", "report held B");
  await settled();
  held.add(p.id);
  busy.delete(p.id);
  flush(p.id);
  expect(p.to()).toEqual([]);
  // Nor by the next daemon: the hold is kept over a restart.
  dropPending(p.id);
  agents.recover();
  flush(p.id);
  expect(p.to()).toEqual([]);
  expect((await agents.waitAll(p.id, [a.id], 1000))[0]).toMatchObject({ status: "completed", result: "report held A" });
  // The owner writes: that turn's end is when both reports go, each once.
  held.delete(p.id);
  agents.onTurnEnd(p.id, "end_turn");
  flush(p.id);
  const got = p.to().join("\n");
  expect([got.split("report held A").length - 1, got.split("report held B").length - 1]).toEqual([1, 1]);
  expect([agents.get(a.id)!.handback, agents.get(b.id)!.handback]).toEqual([false, false]);
});

// A park on waits alone starts no turn of the parent, the first of a task
// included: it is a line of the parent's next input, with the latest thing the
// agent waits on, and the agent's report wakes the parent. (A parent woken for
// a park alone ended that turn with no tool call 92 times in 100.) A park on a
// command is in agent-commands.test.ts.
test("a park on a wait rides the parent's next input and starts no turn of its own", async () => {
  const p = parentOf("parks");
  const a = await p.start();
  const park = (of = a) => {
    const w = waits.create(of.session_id, waits.normalize({ kind: "timer", seconds: 60 }, dir));
    store.append(of.session_id, "turn_end", { reason: "end_turn" });
    agents.onTurnEnd(of.session_id, "end_turn");
    return w;
  };
  const resume = (w: waits.WaitRecord) => { waits.cancel(w.id); agents.onTurnStart(a.session_id); };
  const w1 = park();
  flush(p.id);
  expect(p.to()).toEqual([]); // the first park of the task starts no turn either
  expect(agents.get(a.id)!.status).toBe("waiting");
  resume(w1);
  const w2 = park();
  // Another agent's report starts the parent's next turn: the park is one line of it, as it stands now.
  const b = await p.start();
  end(b, "end_turn", "report of B");
  await settled();
  flush(p.id);
  expect(p.to()).toHaveLength(1);
  expect(p.to()[0]).toContain("report of B");
  expect(p.to()[0]!.split("is waiting for").length - 1).toBe(1);
  expect(p.to()[0]).toMatch(new RegExp(`\\[harness\\] Agent "[^"]+" \\(${a.id}\\) is waiting for timer wait ${w2.id}, due in 1 min \\(at \\d\\d:\\d\\d\\)\\. It has not finished; its report comes when it does\\.`));
  // It parks again, then finishes: only the report goes, and it starts a turn.
  resume(w2);
  resume(park());
  expect(p.to()).toHaveLength(1);
  end(a, "end_turn", "final of A");
  await settled();
  flush(p.id);
  expect(p.to()).toHaveLength(2);
  expect(p.to()[1]).toContain("final of A");
  expect(p.to()[1]).not.toContain(" is waiting for ");
  // A parent held after the owner's Stop: the park rides too, and the end of the hold sends nothing for it.
  const c = await p.start();
  held.add(p.id);
  const w6 = park(c);
  flush(p.id);
  held.delete(p.id);
  agents.onTurnEnd(p.id, "end_turn");
  flush(p.id);
  expect(p.to()).toHaveLength(2);
  waits.cancel(w6.id);
});

// A report owed at a start to a parent whose cut turn the engine is about to
// continue waits for that turn to end, as a wait's wake does: its own turn
// never takes the continuation's place.
test("a report owed at a start waits for the parent's cut turn to end", async () => {
  const p = parentOf("cut parent");
  busy.add(p.id);
  const a = await p.start();
  end(a, "end_turn", "report over the restart");
  await settled();
  store.append(p.id, "turn_end", { reason: "restart" }); // the daemon stopped: the parent's turn was parked
  busy.delete(p.id);
  dropPending(p.id); // a new process
  agents.recover();
  await Bun.sleep(400); // past the wait that lets a burst arrive together
  expect(p.to()).toEqual([]);
  flush(p.id); // the continued turn ended
  expect(p.to().filter((t) => t.includes("report over the restart"))).toHaveLength(1);
});

// A deleted parent's agents went with it: nothing rides to it and nothing stays owed.
test("a deleted parent's riding report and owed row go with it", async () => {
  const p = parentOf("deleted parent");
  const a = await p.start();
  held.add(p.id);
  end(a, "end_turn", "report to nobody");
  await settled();
  const owedRows = () => store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM agent_owed WHERE parent_id = ?").get(p.id)!.n;
  const rides = () => isPending(p.id, (m) => m.kind === "subagent");
  expect([owedRows(), rides()]).toEqual([1, true]);
  store.deleteSession(p.id);
  agents.onSessionDeleted(p.id);
  expect([owedRows(), rides()]).toEqual([0, false]);
  held.delete(p.id);
});

// A daemon stopped while an agent waited for the first one's prompt cache,
// before its task was in its session: the next daemon starts it once with the
// whole assignment and its report schema, never on a bare "continue". One
// stopped while it waited stays stopped.
test("an agent whose start was staggered starts once with its whole assignment after a restart", async () => {
  const p = store.createSession({ model: parent.model, workspace: dir, title: "cold parent" }); // no reply yet: later agents wait behind the first
  const start = (prompt: string, o: Partial<agents.SpawnInput> = {}) => agents.spawn(p.id, { prompt, isolation: "none", background: true, ...o });
  const lead = await start("lead");
  const schema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
  const second = start("the second assignment", { output_schema: schema });
  // What is kept of an assignment is kept as history is: a secret in it is its placeholder.
  const plain = store.redact;
  store.redact = (_s, _k, v) => JSON.parse(JSON.stringify(v).replaceAll("hunter2", "[secret:1a2b3c4d]"));
  const third = start("the stopped one, key hunter2").finally(() => (store.redact = plain));
  await settled();
  const [, b, c] = agents.list(p.id);
  const to = (a: agents.AgentRecord) => sends.filter((x) => x.id === a.session_id).map((x) => x.text);
  expect([to(b!), to(c!)]).toEqual([[], []]);
  const kept = store.db.query<{ task: string }, [string]>("SELECT task FROM agents WHERE id = ?").get(c!.id)!.task;
  expect([kept.includes("hunter2"), kept.includes("key [secret:1a2b3c4d]")]).toEqual([false, true]);
  agents.stop(c!.id, "parent");
  await settled();
  agents.recover(); // the next daemon
  await settled();
  expect(to(b!)).toHaveLength(1);
  expect(to(b!)[0]).toStartWith("You are a subagent of a Keel session.");
  expect(to(b!)[0]).toContain(JSON.stringify(schema));
  expect(to(b!)[0]).toEndWith("Task:\nthe second assignment");
  expect(store.events(b!.session_id).find((e) => e.kind === "user")!.data).toMatchObject({ kind: "task", agent_id: b!.id, task_at: to(b!)[0]!.length - "the second assignment".length });
  expect(agents.get(c!.id)).toMatchObject({ status: "stopped", stopped_by: "parent" });
  expect(to(c!)).toEqual([]);
  // In a daemon that did not stop, the start that waited goes on when the first agent answers: it sends nothing twice.
  bus.emit({ t: "event", event: store.append(lead.session_id, "assistant", { blocks: [] }) } as any);
  await Promise.all([second, third]);
  expect(to(b!)).toHaveLength(1);
  expect(to(c!)).toEqual([]);
  // A message that continues the stopped one gives it the assignment it never got, then the message.
  await agents.send(c!.id, "go on");
  expect(to(c!).map((t) => t.split("\n").at(-1))).toEqual(["the stopped one, key [secret:1a2b3c4d]", "go on"]);
});

// A daemon stopped after a forked agent's task was stored and before its
// record said where the task starts: the next daemon finds the task there,
// sends nothing twice and puts the start right, so what the agent reports is
// its own and never a reply copied from its parent.
test("a task found already stored at a restart is where the agent's report starts", async () => {
  const p = store.createSession({ model: parent.model, workspace: dir, title: "fork parent" });
  store.append(p.id, "user", { text: "Question" });
  store.append(p.id, "assistant", { blocks: [{ type: "text", text: "The parent's own answer" }] });
  store.append(p.id, "assistant", { blocks: [{ type: "tool_use", id: "call-f", name: "spawn_agent", input: {} }] });
  const a = await agents.spawn(p.id, { prompt: "go on", fork: true, isolation: "none", background: true, call_id: "call-f" });
  const start = agents.get(a.id)!.first_seq;
  expect(start).toBeGreaterThan(0);
  // As the stop left it: the task in the session, the record not yet updated.
  store.db.query("UPDATE agents SET first_seq = 0, task = ? WHERE id = ?").run(JSON.stringify({ text: "go on", task_at: 0 }), a.id);
  agents.recover();
  expect(agents.get(a.id)!.first_seq).toBe(start);
  expect(store.events(a.session_id).filter((e) => e.kind === "user" && e.data.kind === "task")).toHaveLength(1);
  store.append(a.session_id, "turn_end", { reason: "end_turn" }); // it ends without a word of its own
  agents.onTurnEnd(a.session_id, "end_turn");
  await settled();
  expect(agents.get(a.id)!.result).toBe("(the agent ended without a report)");
});

// A finished work agent whose empty worktree went is given more work: the
// worktree is made again (git runs, the call yields) before it runs. Its slot
// is held from the start, so a spawn in that time is refused instead of
// taking the slot and leaving the worktree made for nothing.
test("a message that restarts a finished agent holds its slot while its worktree is made again", async () => {
  const repo = tempTree("keel-agents-slot-");
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start"], { cwd: repo });
  const p = store.createSession({ model: "m:x", workspace: repo, title: "slot parent" });
  store.append(p.id, "assistant", { blocks: [] });
  agents.setLimit(p.id, 1);
  const a = await agents.spawn(p.id, { prompt: "do it", isolation: "worktree", background: true });
  end(a, "end_turn", "nothing to change");
  for (let i = 0; i < 100 && agents.get(a.id)!.status !== "completed"; i++) await Bun.sleep(20);
  expect(agents.get(a.id)!.result).toContain("its worktree was removed");
  const again = agents.send(a.id, "one more thing");
  const rival = agents.spawn(p.id, { prompt: "rival", isolation: "none", background: true });
  const [sent, spawned] = await Promise.allSettled([again, rival]);
  // The rival in the background is made and waits in line, holding no slot.
  expect(spawned).toMatchObject({ status: "fulfilled", value: { status: "waiting", slot_wait: true } });
  const queued = (spawned as PromiseFulfilledResult<agents.AgentRecord>).value;
  expect(sent).toMatchObject({ status: "fulfilled", value: { agent: { id: a.id, status: "running" } } });
  expect(agents.list(p.id).filter((x) => x.status === "running").map((x) => x.id)).toEqual([a.id]);
  // The slot is the running agent's now, not held twice: at a limit of two the one in line starts.
  agents.setLimit(p.id, 2);
  expect(agents.get(queued.id)!.status).toBe("running");
  expect(agents.get(queued.id)!.slot_wait).toBeUndefined();
  for (let i = 0; i < 100 && store.events(queued.session_id).every((e) => e.data.kind !== "task"); i++) await Bun.sleep(20);
  expect(store.events(queued.session_id).filter((e) => e.kind === "user" && e.data.kind === "task")).toHaveLength(1);
  agents.stop(queued.id, "parent");
  await settled();
  expect((await agents.spawn(p.id, { prompt: "second", isolation: "none", background: true })).status).toBe("running");

  // Two messages at once to a finished agent, at the limit less one: the first
  // makes it ready, the second waits for that and steers it. Neither is refused.
  const q = store.createSession({ model: "m:x", workspace: repo, title: "two messages" });
  store.append(q.id, "assistant", { blocks: [] });
  agents.setLimit(q.id, 1);
  const b = await agents.spawn(q.id, { prompt: "do it", isolation: "worktree", background: true });
  end(b, "end_turn", "nothing to change");
  for (let i = 0; i < 100 && agents.get(b.id)!.status !== "completed"; i++) await Bun.sleep(20);
  sends.length = 0;
  const both = await Promise.allSettled([agents.send(b.id, "first message"), agents.send(b.id, "second message")]);
  expect(both.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(agents.get(b.id)!.status).toBe("running");
  expect(sends.filter((x) => x.id === b.session_id).map((x) => x.text.split("\n").at(-1))).toEqual(["first message", "second message"]);
});

test("a report is said once: an earlier round a later one repeats is left out, and findings written before a cut reach the parent whole", async () => {
  const round = (a: agents.AgentRecord, text: string, tool = false) => {
    store.append(a.session_id, "assistant", { blocks: [{ type: "text", text }, ...(tool ? [{ type: "tool_use", id: "t", name: "Bash", input: {} }] : [])] });
    if (tool) store.append(a.session_id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] });
    store.append(a.session_id, "turn_end", { reason: tool ? "restart" : "end_turn" });
    store.append(a.session_id, "user", { text: "[harness] go on", kind: "harness" });
  };
  const report = "The parser has three bugs:\n1. off by one\n2. a missed quote\n3. no end of file check";
  // Its words: the line of what it did, which follows them, is looked at once below.
  const result = async (a: agents.AgentRecord) => { await settled(); return agents.get(a.id)!.result!.replace(/\n\n\(What it did: .*\.\)$/, ""); };
  const count = (text: string, part: string) => text.split(part).length - 1;

  // Cut before its answer, then the report, the same report again, and a final one that holds it.
  const a = await spawn();
  const thinking = `Looking at the parser first. ${"It reads a token at a time. ".repeat(60)}`.trim();
  round(a, thinking, true);
  round(a, report);
  round(a, report);
  end(a, "end_turn", `Checked again after the restart.\n\n${report}\n\nAll three are in parse.ts.`);
  const got = await result(a);
  expect(got.startsWith("Checked again after the restart.")).toBe(true);
  expect(count(got, report)).toBe(1);
  expect(count(got, "Earlier reports, oldest first:")).toBe(1);
  // What it wrote before the tool call the restart cut is in no later round: it is all there.
  expect(got.endsWith(`Earlier reports, oldest first:\n\n(No final answer. Before its last tool call it wrote:)\n${thinking}`)).toBe(true);
  // After its words, what it did (report-did.ts).
  expect(agents.get(a.id)!.result!.endsWith(`${thinking}\n\n(What it did: 4 steps, 1 tool call.)`)).toBe(true);

  // Findings written before a tool call (save the report), the turn cut, and a short last word: the findings are whole.
  const findings = `Findings:\n${Array.from({ length: 40 }, (_, i) => `${i + 1}. parse.ts:${i * 7 + 3} drops the token after a quote`).join("\n")}`;
  expect(findings.length).toBeGreaterThan(1500);
  const f = await spawn();
  round(f, findings, true);
  end(f, "end_turn", "Confirmed.");
  expect(await result(f)).toBe(`Confirmed.\n\nEarlier reports, oldest first:\n\n(No final answer. Before its last tool call it wrote:)\n${findings}`);
  // The same words said again by a later round, not the last one, are said once.
  const h = await spawn();
  round(h, findings, true);
  round(h, `${findings}\n\nSaved to report.md.`);
  end(h, "end_turn", "Confirmed.");
  const twice = await result(h);
  expect(count(twice, findings)).toBe(1);
  expect(twice).toBe(`Confirmed.\n\nEarlier reports, oldest first:\n\n${findings}\n\nSaved to report.md.`);

  // The same report twice is the report, with no tail.
  const b = await spawn();
  round(b, report);
  end(b, "end_turn", report);
  expect(await result(b)).toBe(report);

  // Two different reports are both kept, the newest first; an only round that had no answer keeps its words whole.
  const c = await spawn();
  round(c, "First finding: the lexer drops tabs.");
  end(c, "end_turn", "Second finding: the parser is fine.");
  expect(await result(c)).toBe("Second finding: the parser is fine.\n\nEarlier reports, oldest first:\n\nFirst finding: the lexer drops tabs.");
  const d = await spawn();
  spendSuccessors(d); // it ends here, not in a fresh context (src/automation/successor.ts)
  store.append(d.session_id, "assistant", { blocks: [{ type: "text", text: thinking }, { type: "tool_use", id: "t", name: "Bash", input: {} }] });
  store.append(d.session_id, "turn_end", { reason: "max_steps" });
  agents.onTurnEnd(d.session_id, "max_steps");
  expect(await result(d)).toContain(`(No final answer. Before its last tool call it wrote:)\n${thinking}`);
});

// A blocking agent's report comes back through the engine's result cap: the
// tools that return one name the agents' own cap, so a report under it (36,000
// characters, a JSON one included) arrives whole and not as a head, a tail
// and a path.
test("an agent's report under the agents' cap passes the engine's result cap whole", async () => {
  const { automationTools } = await import("./tools.ts");
  const { capResult, OUTPUT_CAP } = await import("../tools/spill.ts");
  const report = JSON.stringify({ findings: "f".repeat(36_000) });
  for (const name of ["Agent", "wait_agent"]) {
    const tool = automationTools.find((t) => t.name === name)!;
    expect(tool.resultCap).toBe(agents.RESULT_CAP);
    expect(await capResult(report, tool.resultCap ?? OUTPUT_CAP, undefined, name)).toBe(report);
  }
  expect(await capResult(report, OUTPUT_CAP, undefined, "Bash")).not.toBe(report);
});

// A message that reaches an agent as it finishes is read in the turn of its
// final answer, at the step after it. What the agent answers then is a later
// report; the one it had written is not replaced by it.
test("a final answer is kept when the turn goes on with a message that arrived as it finished", async () => {
  const say = (a: agents.AgentRecord, text: string, more: Record<string, unknown> = {}) => store.append(a.session_id, "assistant", { blocks: [{ type: "text", text }], ...more });
  const message = (a: agents.AgentRecord, text: string) => store.append(a.session_id, "user", { text: `Message from the session that started you:\n${text}`, origin: "steer", kind: "steer", agent_id: a.id });
  const result = async (a: agents.AgentRecord) => { await settled(); return agents.get(a.id)!.result!; };
  const report = `The review of the parser.\n${"A finding on a line of its own.\n".repeat(300)}That is all of it.`;
  expect(report.length).toBeGreaterThan(9_000);

  // One message after the final answer: the reply, then the report whole.
  const a = await spawn();
  say(a, report);
  message(a, "Also name the file.");
  end(a, "end_turn", "The file is parse.ts.");
  expect(await result(a)).toBe(`The file is parse.ts.\n\nEarlier reports, oldest first:\n\n${report}`);

  // Two at once, and a third after the reply: every answer is there, the newest first, the rest oldest first.
  const b = await spawn();
  say(b, report);
  message(b, "First question.");
  message(b, "Second question.");
  say(b, "Both answered: yes and no.");
  message(b, "A third.");
  end(b, "end_turn", "The third: maybe.");
  expect(await result(b)).toBe(`The third: maybe.\n\nEarlier reports, oldest first:\n\n${report}\n\nBoth answered: yes and no.`);

  // The same across a restart that cut the reply: the answer before the message is a report, the cut turn adds none.
  const c = await spawn();
  say(c, report);
  message(c, "Also name the file.");
  store.append(c.session_id, "turn_end", { reason: "restart" });
  store.append(c.session_id, "user", { text: "[harness] The daemon restarted during your previous turn. Continue where it left off.", origin: "restart" });
  end(c, "end_turn", "The file is parse.ts.");
  expect(await result(c)).toBe(`The file is parse.ts.\n\nEarlier reports, oldest first:\n\n${report}`);

  // An agent that parks between the two: what it had said is its result while it waits, and both are in its report.
  const d = await spawn();
  const w = waits.create(d.session_id, waits.normalize({ kind: "timer", seconds: 60 }, dir));
  end(d, "end_turn", report);
  expect(agents.get(d.id)).toMatchObject({ status: "waiting", result: report });
  await agents.send(d.id, "Also name the file.");
  end(d, "end_turn", "The file is parse.ts.");
  expect(agents.get(d.id)).toMatchObject({ status: "waiting", result: `The file is parse.ts.\n\nEarlier reports, oldest first:\n\n${report}` });
  waits.cancel(w.id);
  agents.onTurnStart(d.session_id);
  end(d, "end_turn", "The build passed.");
  expect(await result(d)).toBe(`The build passed.\n\nEarlier reports, oldest first:\n\n${report}\n\nThe file is parse.ts.`);

  // Input that is not after an answer makes no report: words before a tool call, and the harness's note in the turn.
  const e = await spawn();
  store.append(e.session_id, "assistant", { blocks: [{ type: "text", text: "Reading the file first." }, { type: "tool_use", id: "t", name: "Bash", input: {} }] });
  store.append(e.session_id, "tool_result", { results: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] });
  message(e, "Do not forget the tests.");
  store.append(e.session_id, "user", { text: "[harness] This is the last model step this turn may take.", origin: "harness" });
  end(e, "end_turn", "Done, with the tests.");
  // (It called a tool, so its report says what it did, after its own words.)
  expect(await result(e)).toBe("Done, with the tests.\n\n(What it did: 2 steps, 1 tool call.)");

  // A reply cut at the output limit and the one that continues it are one answer, not two reports.
  const f = await spawn();
  say(f, "The first part of the answer, cut right he", { stop: "max_tokens" });
  store.append(f.session_id, "user", { text: "[harness] Your last reply was cut off at the output limit. Continue exactly where it stopped.", origin: "harness" });
  end(f, "end_turn", "re, and its end.");
  expect(await result(f)).toBe("The first part of the answer, cut right here, and its end.");
});

// Several answers joined in one report stay within the cap. What does not fit
// goes from the oldest first (the first that does not fit keeps its start and
// its end, the ones older than it go whole), the newest is whole, and each
// cut says how many bytes it took.
test("a report of several answers over the cap shortens the oldest first and says how much it left out", () => {
  const CAP = 10_000;
  const fill = (name: string, n: number) => `${name} starts. ${`${name} é line. `.repeat(Math.ceil(n / 12))}`.slice(0, n - name.length - 7) + ` ${name} ends.`.slice(0);
  const left = (text: string) => [...text.matchAll(/\[\.\.\. (\d+) bytes left out here \.\.\.\]/g)].map((m) => Number(m[1]));
  const newest = fill("Newest", 3_000);
  const middle = fill("Middle", 3_000);
  const oldest = fill("Oldest", 9_000);
  const tail = "\n\nIt did not finish: it ran out of steps.";

  // Under the cap: nothing is cut.
  const whole = agents.fitReport(newest, [middle], tail, CAP);
  expect(whole).toBe(`${newest}\n\nEarlier reports, oldest first:\n\n${middle}${tail}`);

  // Over it: the oldest gives what is needed and keeps its start and its end; the others are whole.
  const cut = agents.fitReport(newest, [oldest, middle], tail, CAP);
  expect(cut.length).toBeLessThanOrEqual(CAP);
  expect(cut.length).toBeGreaterThan(CAP - 60); // no more is cut than is needed
  expect(cut.startsWith(`${newest}\n\nEarlier reports, oldest first:\n\nOldest starts.`)).toBe(true);
  expect(cut.endsWith(`Oldest ends.\n\n${middle}${tail}`)).toBe(true);
  const said = left(cut);
  expect(said).toHaveLength(1);
  // The bytes it names are the bytes that are not there (two a character for é).
  const shown = cut.slice(newest.length + "\n\nEarlier reports, oldest first:\n\n".length, cut.length - middle.length - tail.length - 2);
  const [head, rest] = shown.split(/\n\n\[\.\.\. \d+ bytes left out here \.\.\.\]\n\n/);
  expect(oldest.startsWith(head!) && oldest.endsWith(rest!)).toBe(true);
  expect(said[0]).toBe(Buffer.byteLength(oldest) - Buffer.byteLength(head!) - Buffer.byteLength(rest!));
  expect(said[0]).toBeGreaterThan(oldest.length - head!.length - rest!.length);

  // Many: the earlier ones nearest the newest are whole, and the oldest go whole, counted.
  const many = Array.from({ length: 30 }, (_, i) => fill(`Report${i + 1}`, 900));
  const lots = agents.fitReport(newest, many, tail, CAP);
  expect(lots.length).toBeLessThanOrEqual(CAP);
  expect(lots.startsWith(newest)).toBe(true);
  expect(lots.endsWith(`${many.at(-1)}${tail}`)).toBe(true);
  const gone = /\[(\d+) older reports left out whole: (\d+) bytes\]/.exec(lots)!;
  expect(Number(gone[1])).toBeGreaterThan(15);
  expect(Number(gone[2])).toBe(many.slice(0, Number(gone[1])).reduce((n, r) => n + Buffer.byteLength(r), 0));
  expect(lots).not.toContain("Report1 starts.");
  expect(lots).toContain(`Report${Number(gone[1]) + 1} starts.`);

  // The newest alone over the cap: it is cut last, in its middle, and says so; a pair of characters is not split.
  const long = `${"😀".repeat(6_001)} the end of the newest`;
  const alone = agents.fitReport(long, [middle], tail, CAP);
  expect(alone.length).toBeLessThanOrEqual(CAP);
  expect(alone.startsWith("😀") && alone.endsWith(`the end of the newest\n\nEarlier reports, oldest first:\n\n[1 older report left out whole: ${Buffer.byteLength(middle)} bytes]${tail}`)).toBe(true);
  expect(left(alone)).toHaveLength(1);
  expect(alone.isWellFormed()).toBe(true);
});

// A waiting agent holds no slot, and its wake is first in line: a spawn made
// after it parked does not take the slot that frees first. The wake waits as
// owed while every slot works, and the record says so.
test("a waiting agent gives its slot back and its wake goes first when one frees", async () => {
  const p = store.createSession({ model: parent.model, workspace: dir, title: "Slots for waits" });
  store.append(p.id, "assistant", { blocks: [] });
  agents.setLimit(p.id, 1);
  // The engine's turn start says the agent works (the real one calls the hook as the turn starts).
  const send = engine.send;
  engine.send = (id: string, text: string, o: any) => { const r = send(id, text, o); agents.onTurnStart(id); return r; };
  try {
    const a = await agents.spawn(p.id, { prompt: "park", isolation: "none", background: true });
    const w = waits.create(a.session_id, waits.normalize({ kind: "timer", seconds: 600 }, dir));
    end(a, "end_turn", "parked");
    expect(agents.get(a.id)!.status).toBe("waiting");
    // Its slot is free: another agent starts at once.
    const b = await agents.spawn(p.id, { prompt: "work", isolation: "none", background: true });
    expect(b.status).toBe("running");
    expect(agents.slotsOf(p.id)).toMatchObject({ limit: 1, working: 1, waiting: 1, line: 0 });
    // A's wake comes while B works: it waits in line, owed.
    void w;
    deliver(a.session_id, "[harness] The timer fired.", { kind: "wait" });
    await settled();
    expect(agents.get(a.id)).toMatchObject({ status: "waiting", slot_wait: true });
    expect(isPending(a.session_id, () => true)).toBe(true);
    // A spawn after that is made and waits behind it.
    const c = await agents.spawn(p.id, { prompt: "later", isolation: "none", background: true });
    expect(c).toMatchObject({ status: "waiting", slot_wait: true });
    expect(agents.slotsOf(p.id)).toMatchObject({ working: 1, waiting: 0, line: 2 });
    const refused = await agents.spawn(p.id, { prompt: "blocking", isolation: "none", background: false }, AbortSignal.timeout(50)).catch((e) => String(e));
    expect(refused).toContain("cancelled");
    // B ends: A goes on with its wake; C still waits.
    end(b, "end_turn");
    await settled();
    expect(agents.get(a.id)!.status).toBe("running");
    expect(store.events(a.session_id).some((e) => e.kind === "user" && e.data.kind === "wait")).toBe(true);
    expect(agents.get(c.id)).toMatchObject({ status: "waiting", slot_wait: true });
    end(agents.get(a.id)!, "end_turn");
    await settled();
    for (let i = 0; i < 100 && agents.get(c.id)!.status !== "running"; i++) await Bun.sleep(20);
    expect(agents.get(c.id)!.status).toBe("running");
  } finally {
    engine.send = send;
  }
});

// Reports that come close together while the idle parent has other agents
// at work are one input: each turn a report starts rereads the parent's context.
test("reports that come in a burst wake the parent once", async () => {
  const p = store.createSession({ model: parent.model, workspace: dir, title: "Burst of reports" });
  store.append(p.id, "assistant", { blocks: [] });
  const kids = await Promise.all([1, 2, 3].map((i) => agents.spawn(p.id, { prompt: `part ${i}`, isolation: "none", background: true })));
  const inputs = () => store.events(p.id).filter((e) => e.kind === "user" && (e.data.kind === "subagent" || e.data.kind === "wake"));
  end(kids[0]!, "end_turn", "one");
  await Bun.sleep(800);
  expect(inputs()).toHaveLength(0); // the other two still work: it settles
  end(kids[1]!, "end_turn", "two");
  await Bun.sleep(800);
  end(kids[2]!, "end_turn", "three"); // the last: nothing works any more, it goes at once with the rest
  for (let i = 0; i < 150 && !inputs().length; i++) await Bun.sleep(20);
  await Bun.sleep(100);
  expect(inputs()).toHaveLength(1);
  const text = String(inputs()[0]!.data.text);
  for (const w of ["one", "two", "three"]) expect(text).toContain(w);
  expect(agents.REPORT_SETTLE).toEqual({ quietMs: 2_000, maxMs: 10_000 });
});

// A report that settles goes with a wake already due soon: it does not hold that wake back.
test("a report that settles leaves a wake's short coalesce as it was", async () => {
  const p = store.createSession({ model: parent.model, workspace: dir, title: "Wake and a report" });
  store.append(p.id, "assistant", { blocks: [] });
  const [a, b] = await Promise.all([1, 2].map((i) => agents.spawn(p.id, { prompt: `part ${i}`, isolation: "none", background: true })));
  const inputs = () => store.events(p.id).filter((e) => e.kind === "user" && ["wake", "wait", "subagent"].includes(e.data.kind));
  deliver(p.id, "[harness] A wait fired.", { kind: "wait" }, { coalesceMs: 300 });
  end(a!, "end_turn", "the first report"); // b still works: it would settle for two seconds
  await Bun.sleep(700);
  expect(inputs()).toHaveLength(1);
  expect(String(inputs()[0]!.data.text)).toContain("the first report");
  end(b!, "end_turn");
});

// INT-M13: Claude Code's sub-agent fields. maxTurns bounds its steps, skills start its task whole, an effort the
// model lists is its own; hooks and a memory folder are not run, an inline MCP server waits for the owner, and its parent is told so.
test("a Claude Code agent's maxTurns, skills and effort hold; what Keel does not run is told to its parent", async () => {
  const folder = join(dir, ".claude", "agents"), skill = join(dir, ".claude", "skills", "api-conventions");
  mkdirSync(folder, { recursive: true });
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: api-conventions\ndescription: Our API rules.\n---\nEvery endpoint returns JSON.");
  const hidden = join(dir, ".claude", "skills", "owner-only");
  mkdirSync(hidden, { recursive: true });
  writeFileSync(join(hidden, "SKILL.md"), "---\nname: owner-only\ndescription: x\ndisable-model-invocation: true\n---\nSecret steps.");
  const huge = join(dir, ".claude", "skills", "huge");
  mkdirSync(huge, { recursive: true });
  writeFileSync(join(huge, "SKILL.md"), `---\nname: huge\ndescription: x\n---\n${"Long rule. ".repeat(agents.PRELOAD_MAX / 8)}`);
  writeFileSync(join(folder, "api-builder.md"), [
    "---", "name: api-builder", "description: Builds endpoints", "maxTurns: 7", "effort: high",
    "skills:", "  - api-conventions", "  - owner-only", "  - missing-skill", "  - huge",
    "mcpServers:", "  - github", "  - playwright:", "      type: stdio", "      command: npx", "      args: [\"-y\", \"@playwright/mcp\"]",
    "hooks:", "  PreToolUse:", "    - matcher: Bash", "      hooks:", "        - type: command", "          command: ./check.sh",
    "memory: project", "---", "Build the endpoint.",
  ].join("\n"));
  const def = agents.definitions(dir).find((d) => d.name === "api-builder")!;
  expect([def.maxTurns, def.skills, def.mcpServers, def.ownServers, def.effort]).toEqual([7, ["api-conventions", "owner-only", "missing-skill", "huge"], ["github"], ["playwright"], "high"]);
  expect(def.notTaken).toEqual([expect.stringContaining("its hooks (PreToolUse)")]);
  expect(def.memory).toBe("project");
  const r = await tool("Agent").run({ description: "endpoint", prompt: "add /health", subagent_type: "api-builder", run_in_background: true, isolation: "none" }, ctx as any);
  const text = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
  for (const said of ["playwright", "hooks", "the skill owner-only", "the skill missing-skill", "the skill huge: the skills an agent starts with hold 64 KB together at most", "the MCP server github", "the effort high"]) expect(text).toContain(said);
  const a = agents.list(parent.id).find((x) => x.type === "api-builder")!;
  expect(store.session(a.session_id)!.settings?.max_steps).toBe(7);
  const task = sends.find((x) => x.id === a.session_id)!.text;
  expect(task).toContain("Every endpoint returns JSON.");
  expect(task).not.toContain("Secret steps.");
  expect(task).not.toContain("Long rule.");
  end(a, "end_turn");
  await settled();
});

// The same note when the agent waits for a slot: on the spawn's answer of either tool, its queued row, and the row of its start.
test("what an agent is started without is told when it waits for a slot, and again when it starts", async () => {
  const p = store.createSession({ model: parent.model, workspace: dir, title: "A definition in line" });
  store.append(p.id, "assistant", { blocks: [] });
  agents.setLimit(p.id, 1);
  const pctx = { ...ctx, sessionId: p.id };
  const busy = await agents.spawn(p.id, { prompt: "hold the slot", isolation: "none", background: true });
  const r = await tool("Agent").run({ description: "queued endpoint", prompt: "add /ready", subagent_type: "api-builder", run_in_background: true, isolation: "none" }, pctx as any);
  const text = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
  expect(text).toContain("waits for a slot");
  expect(text).toContain("the MCP server github");
  const j = JSON.parse(String((await tool("spawn_agent").run({ message: "add /live", agent_type: "api-builder", isolation: "none" }, pctx as any)).content));
  expect(j).toMatchObject({ status: "waits_for_slot", not_carried: expect.stringContaining("its hooks (PreToolUse)") });
  const rows = () => activity.list({ session_id: p.id, limit: 50 }).items.map((x: any) => `${x.sub}: ${x.text}`);
  expect(rows().filter((x) => x.startsWith("queued:") && x.includes("Not carried from its definition") && x.includes("its own MCP server (playwright): it waits for the owner's approval"))).toHaveLength(2);
  end(busy, "end_turn");
  for (let i = 0; i < 100 && !rows().some((x) => x.startsWith("started:") && x.includes("when a slot freed") && x.includes("Not carried")); i++) await Bun.sleep(20);
  expect(rows().some((x) => x.startsWith("started:") && x.includes("when a slot freed") && x.includes("Not carried from its definition"))).toBe(true);
  for (const a of agents.list(p.id)) if (a.status === "running" || a.status === "waiting") agents.stop(a.id);
  await settled();
});

// INT-M13 leftover: an agent's memory folder (Claude Code's `memory` field). Its task says where the folder is and
// carries MEMORY.md's first 200 lines (25 KB at most), asking it to curate a longer one; Read, Write and Edit join a
// tools list that names other tools; an unknown scope is told to the parent.
test("an agent file's memory folder starts its task with MEMORY.md, within its bounds", async () => {
  const folder = join(dir, ".claude", "agents");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "reviewer.md"), ["---", "name: reviewer", "description: Reviews code", "tools: Grep", "memory: project", "---", "Review the change."].join("\n"));
  writeFileSync(join(folder, "odd-memory.md"), ["---", "name: odd-memory", "description: x", "memory: team", "---", "x"].join("\n"));
  const mem = join(dir, ".claude", "agent-memory", "reviewer");
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, "MEMORY.md"), Array.from({ length: 250 }, (_, i) => `- note ${i + 1}`).join("\n"));
  expect(agents.definitions(dir).find((d) => d.name === "odd-memory")!.notTaken).toEqual([expect.stringContaining("its memory scope team")]);
  await tool("Agent").run({ description: "review", prompt: "review the diff", subagent_type: "reviewer", run_in_background: true, isolation: "none" }, ctx as any);
  const a = agents.list(parent.id).find((x) => x.type === "reviewer")!;
  const task = sends.find((x) => x.id === a.session_id)!.text;
  expect(task).toContain(`memory folder of your own at ${mem} (project scope`);
  expect(task).toContain("- note 1\n");
  expect(task).toContain("- note 200");
  expect(task).not.toContain("- note 201");
  expect(task).toContain("cut at that bound: curate it");
  const stored = JSON.parse(store.db.query<{ def: string }, [string]>("SELECT def FROM agents WHERE id = ?").get(a.id)!.def);
  expect(stored.tools).toEqual(["Grep", "Read", "Write", "Edit"]);
  expect(agents.gate(a.session_id, "Write", { file_path: join(mem, "MEMORY.md") })).toBeUndefined();
  // RSH-S25: a write that leaves MEMORY.md past that bound is told with the call's result; another file's is not.
  const edit = { name: "Write", kind: "edit" as const };
  expect(agents.memoryWrite(a.session_id, edit, { file_path: join(mem, "MEMORY.md") })).toContain("MEMORY.md is now 250 lines and 3 KB: past the 200 lines or 25 KB you are given at each start, so from line 201 on it is not read again.");
  expect(agents.memoryWrite(a.session_id, edit, { file_path: join(mem, "detail.md") })).toBeUndefined();
  expect(agents.memoryWrite(parent.id, edit, { file_path: join(mem, "MEMORY.md") })).toBeUndefined();
  end(a, "end_turn");
  await settled();
});

// RSH-S42: an entry with a specifier is one entry for its tool. Claude Code's sub-agents doc: `Bash(git push *)` in
// disallowedTools takes the whole of Bash away, and `Agent(worker, researcher)` in a subagent's tools lets it spawn.
test("an agent file's tool entries with a specifier work as Claude Code reads them", async () => {
  const folder = join(dir, ".claude", "agents");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "nopush.md"), ["---", "name: nopush", "description: Never pushes", "disallowedTools: Bash(git push *)", "---", "Work."].join("\n"));
  writeFileSync(join(folder, "coordinator.md"), ["---", "name: coordinator", "description: Leads", "tools: Agent(worker, researcher), Read, Bash", "---", "Lead."].join("\n"));
  writeFileSync(join(folder, "flow.md"), ["---", "name: flow", "description: x", "tools: [Agent(worker, researcher), Read]", "---", "x"].join("\n"));
  writeFileSync(join(folder, "status.md"), ["---", "name: status", "description: Reads status", "tools: Bash(git status), Read", "---", "Look."].join("\n"));
  const defs = agents.definitions(dir);
  expect(defs.find((d) => d.name === "coordinator")!.tools).toEqual(["Agent(worker, researcher)", "Read", "Bash"]);
  expect(defs.find((d) => d.name === "flow")!.tools).toEqual(["Agent(worker, researcher)", "Read"]);
  for (const type of ["nopush", "coordinator", "status"])
    await tool("Agent").run({ description: type, prompt: "go", subagent_type: type, run_in_background: true, isolation: "none" }, ctx as any);
  const nopush = agents.list(parent.id).find((x) => x.type === "nopush")!;
  const lead = agents.list(parent.id).find((x) => x.type === "coordinator")!;
  expect(agents.gate(nopush.session_id, "Bash", { command: "git push origin x" })).toContain("takes the whole tool away");
  expect(agents.gate(nopush.session_id, "Bash", { command: "ls" })).toBeDefined();
  expect(agents.gate(nopush.session_id, "Read", { file_path: join(dir, "a") })).toBeUndefined();
  for (const t of ["Agent", "Read", "Bash"]) expect(agents.gate(lead.session_id, t, {})).toBeUndefined();
  expect(agents.gate(lead.session_id, "Write", { file_path: join(dir, "a") })).toContain("not in this agent's tools");
  // Another tool with a specifier in tools grants nothing (fail-closed), and the refusal says why.
  const status = agents.list(parent.id).find((x) => x.type === "status")!;
  for (const command of ["git status", "rm -rf build"]) expect(agents.gate(status.session_id, "Bash", { command })).toContain("grants no Bash");
  expect(agents.gate(status.session_id, "Read", { file_path: join(dir, "a") })).toBeUndefined();
  for (const a of [nopush, lead, status]) end(a, "end_turn");
  await settled();
});

// An agent that ends without its end being settled (its parent archived while a daemon was down, its session
// deleted) keeps no reading of its repositories from its start.
test("an agent closed by a restart or a deleted session leaves no reading of its repositories", async () => {
  leftovers.migrate(store);
  const reading = (id: string) => store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM agent_git_before WHERE agent_id = ?").get(id)!.n;
  const put = (id: string) => store.db.query("INSERT INTO agent_git_before (agent_id, repo, snap, at) VALUES (?, '/r/.git', '{}', 0)").run(id);
  const p = parentOf("archived while down");
  const a = await p.start();
  put(a.id);
  store.db.query("UPDATE sessions SET archived = 1 WHERE id = ?").run(p.id);
  agents.recover();
  expect(agents.get(a.id)!.status).toBe("stopped");
  expect(reading(a.id)).toBe(0);
  const q = parentOf("child deleted");
  const b = await q.start();
  put(b.id);
  store.deleteSession(b.session_id);
  agents.tick();
  expect(agents.get(b.id)!.status).toBe("stopped");
  expect(reading(b.id)).toBe(0);
});

// The tick reads whole only the agents with something to do: a deleted session, a time limit passed, a long park.
test("the tick's query names only the agents that are due", async () => {
  const p = parentOf("due agents");
  const a = await p.start();
  const due = (now = Date.now()) => agents.dueAgents(store.db, now, 60_000).map((r) => r.id);
  expect(due()).not.toContain(a.id);
  // A limit in its definition, not yet passed, then passed.
  store.db.query("UPDATE agents SET def = ? WHERE id = ?").run(JSON.stringify({ name: "x", timeoutMins: 10 }), a.id);
  expect(due()).not.toContain(a.id);
  expect(due(Date.now() + 11 * 60_000)).toContain(a.id);
  store.db.query("UPDATE agents SET def = NULL WHERE id = ?").run(a.id);
  expect(due(Date.now() + 11 * 60_000)).not.toContain(a.id);
  // A park on a command, background, past the long-park time.
  store.db.query("UPDATE agents SET status = 'waiting', background = 1, parked = ? WHERE id = ?").run(Date.now() - 30_000, a.id);
  expect(due()).not.toContain(a.id);
  expect(due(Date.now() + 40_000)).toContain(a.id);
  store.db.query("UPDATE agents SET background = 0 WHERE id = ?").run(a.id);
  expect(due(Date.now() + 40_000)).not.toContain(a.id);
  // Its session is gone.
  store.db.query("DELETE FROM sessions WHERE id = ?").run(a.session_id);
  expect(due()).toContain(a.id);
});

test("a wait's JSON is read before a note the harness put after it", async () => {
  const { jsonHead } = await import("./agents.ts");
  expect(JSON.parse(jsonHead('{"status":{}}\n\n<memory source="tacit">x</memory>'))).toEqual({ status: {} });
  expect(JSON.parse(jsonHead('{"status":{}}\n\n[harness] same result'))).toEqual({ status: {} });
  expect(jsonHead('{"a":"x\\n\\ny"}')).toBe('{"a":"x\\n\\ny"}');
});

// A follow-up's capsule is made from what the agent reported since its last
// checkpoint, every task's, not from its newest report alone: a turn a
// harness notice opened after it reported does not take the lead.
test("a follow-up is decided on every task's reports, and a notice's turn does not lead them", async () => {
  const p = store.createSession({ model: parent.model, workspace: dir, title: "Follow-ups" });
  store.append(p.id, "assistant", { blocks: [] });
  const a = await agents.spawn(p.id, { prompt: "Review branch X", isolation: "none", background: true });
  end(a, "end_turn", "REPORT-ONE: P1 at src/a.ts:10, P2 at src/b.ts:20");
  await settled();
  nextPlan = undefined;
  await agents.send(a.id, "fix P1");
  end(a, "end_turn", "REPORT-TWO: fixed P1 in abc1234");
  await settled();
  followUps.length = 0;
  await agents.send(a.id, "and P2?");
  expect(followUps[0].report.startsWith("REPORT-TWO")).toBe(true);
  expect(followUps[0].report).toContain("REPORT-ONE");
  end(a, "end_turn", "REPORT-THREE: P2 fixed in def5678");
  await settled();
  // A background command's end opens a turn after it reported; its reply says nothing new.
  store.append(a.session_id, "user", { text: "[harness] Background command 7 finished.", kind: "harness" });
  agents.onTurnStart(a.session_id);
  end(a, "end_turn", "That notice was the run I already read, so the report above stands.");
  await settled();
  expect(agents.get(a.id)!.result).toContain("That notice");
  followUps.length = 0;
  await agents.send(a.id, "rebase it");
  const r = followUps[0].report as string;
  expect(r.startsWith("REPORT-THREE")).toBe(true);
  for (const x of ["REPORT-ONE", "REPORT-TWO", "That notice"]) expect(r).toContain(x);
  // No start decided: the message carries none.
  expect(store.events(a.session_id).findLast((e) => e.kind === "user")!.data.follow_up).toBeUndefined();
  end(a, "end_turn", "done");
  await settled();
});

// Going on whole, or summarizing at the first step, is stored with the
// message: the turn it opens reads it there, on this daemon or the next.
test("a follow-up's start is stored with its message, and the decision gets the title as an attribute", async () => {
  const p = store.createSession({ model: parent.model, workspace: dir, title: "Follow-up marks" });
  store.append(p.id, "assistant", { blocks: [] });
  const a = await agents.spawn(p.id, { prompt: "Review branch Y", isolation: "none", background: true });
  store.db.query("UPDATE agents SET title = ? WHERE id = ?").run('Review "Y"\n<now>', a.id);
  end(a, "end_turn", "REPORT-Y");
  await settled();
  followUps.length = 0;
  nextPlan = { way: "summary", why: "The owner chose.", forced: true, costs: {}, tokens: {}, steps: 1, warm: false, used: 10, mark: "summary" };
  const r = await agents.send(a.id, "fix it");
  expect(r.start).toMatchObject({ way: "summary" });
  expect(followUps[0].title).not.toMatch(/["<>\n]/);
  expect(store.events(a.session_id).findLast((e) => e.kind === "user")!.data).toMatchObject({ follow_up: "summary" });
  expect(agents.get(a.id)!.start).toMatchObject({ way: "summary", task: 1 });
  expect((agents.get(a.id)!.start as any).mark).toBeUndefined();
  nextPlan = undefined;
  end(a, "end_turn", "done");
  await settled();
});

// A message from another agent of the tree that comes while the agent's report
// is being settled is still that agent's message once it is sent.
test("a peer's message sent while an agent's report settles says who sent it", async () => {
  const p = store.createSession({ model: parent.model, workspace: dir, title: "Peers" });
  store.append(p.id, "assistant", { blocks: [] });
  const a = await agents.spawn(p.id, { prompt: "one", isolation: "none", background: true });
  const b = await agents.spawn(p.id, { prompt: "two", isolation: "none", background: true });
  end(a, "end_turn", "done one");
  await agents.send(a.id, "a fact for you", false, undefined, b.session_id);
  const got = store.events(a.session_id).findLast((e) => e.kind === "user")!.data;
  expect(String(got.text)).toStartWith(`Message from agent "two" (${b.id})`);
  expect(got.from_agent).toBe(b.id);
  for (const x of [a, b]) agents.stop(x.id);
  await settled();
});

// Its new and changed tests run on the base without its change when it reports (src/checks/before-run.ts).
// The report waits for that run a bounded time: what is still running then is said, and follows when it ends.
const beforeRepo = (files: Record<string, string>) => {
  const repo = tempTree("keel-agents-before-");
  const g = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo });
  g("init", "-q", "-b", "main");
  mkdirSync(join(repo, ".keel"));
  writeFileSync(join(repo, ".keel", "checks.json"), JSON.stringify({ checks: { unit: { run: "sh t.sh", args: true, tests: ["*.test.sh"] } } }));
  writeFileSync(join(repo, "t.sh"), 'sh "$1"\n');
  g("add", "-A");
  g("commit", "-qm", "checks");
  for (const [f, text] of Object.entries(files)) writeFileSync(join(repo, f), text);
  new Worktrees(store, join(dir, "before-worktrees")); // its table: the base is read from it
  bindLedger(store);
  bindBefore({ store, bus, perm: () => ({ mode: "full-auto", sandbox: "off" }), confine: () => undefined, capture: (e) => { throw e; } });
  const p = store.createSession({ model: "m:x", workspace: repo, title: "before parent" });
  store.append(p.id, "assistant", { blocks: [] });
  return p;
};
const until = async (what: () => boolean, ms: number) => { const end = Date.now() + ms; while (!what() && Date.now() < end) await Bun.sleep(20); return what(); };

test("an agent's report waits for its tests on the base a bounded time, and their answers follow it", async () => {
  const p = beforeRepo({ "slow.test.sh": "sleep 2; exit 1\n", "weak.test.sh": "sleep 2; exit 0\n" });
  const was = agents.BEFORE_WAIT.ms;
  agents.BEFORE_WAIT.ms = 300;
  try {
    const a = await agents.spawn(p.id, { prompt: "do it", isolation: "none", background: true });
    sends.length = 0;
    end(a, "end_turn", "report R");
    // The report goes before the run has ended, and says what is still running.
    expect(await until(() => agents.get(a.id)!.status === "completed", 1_500)).toBe(true);
    expect(agents.get(a.id)!.result).toContain("2 still running (their answers follow when done");
    // A file passes without the change: the parent is told when the run ends, and the report says it in its place.
    expect(await until(() => sends.some((x) => x.id === p.id && x.text.includes("weak.test.sh passes without the change")), 15_000)).toBe(true);
    expect(sends.find((x) => x.text.includes("weak.test.sh passes"))!.text).toContain("slow.test.sh fails before: yes (exit 1)");
    expect(agents.get(a.id)!.result).toContain("slow.test.sh fails before: yes (exit 1)");
    expect(agents.get(a.id)!.result).not.toContain("still running");
  } finally {
    agents.BEFORE_WAIT.ms = was;
  }
});

test("a stop while an agent's report is being written leaves its end as it was and hands back one report", async () => {
  const p = beforeRepo({ "slow.test.sh": "sleep 1; exit 1\n" });
  const a = await agents.spawn(p.id, { prompt: "do it", isolation: "none", background: true });
  sends.length = 0;
  end(a, "end_turn", "report Q");
  agents.stop(a.id, "parent");
  expect(await until(() => latest(a.session_id)?.state === "done" && agents.get(a.id)!.status === "completed", 15_000)).toBe(true);
  flush(p.id);
  expect(agents.get(a.id)).toMatchObject({ status: "completed", stopped_by: null });
  expect(sends.filter((x) => x.id === p.id && x.text.includes("report Q"))).toHaveLength(1);
});

// The report says files are still running: that is what owes their answers, also when the run ends before the
// report's write (a slow read of the parent between the wait and the write).
test("a run that ends between the report's wait and its write still has its answers told", async () => {
  const p = beforeRepo({ "slow.test.sh": "sleep 1; exit 0\n" });
  const was = agents.BEFORE_WAIT.ms, warm = store.warm.bind(store);
  agents.BEFORE_WAIT.ms = 200;
  (store as any).warm = async (...args: Parameters<Store["warm"]>) => { await Bun.sleep(3_000); return warm(...args); };
  try {
    const a = await agents.spawn(p.id, { prompt: "do it", isolation: "none", background: true });
    sends.length = 0;
    end(a, "end_turn", "report W");
    expect(await until(() => agents.get(a.id)!.status === "completed", 10_000)).toBe(true);
    expect(latest(a.session_id)!.state).toBe("done"); // it ended before the report was written
    expect(await until(() => sends.some((x) => x.id === p.id && x.text.includes("slow.test.sh passes without the change")), 5_000)).toBe(true);
    expect(agents.get(a.id)!.result).toContain("slow.test.sh passes without the change");
    expect(agents.get(a.id)!.result).not.toContain("still running");
    expect(latest(a.session_id)!.follow_agent).toBeNull(); // told: no longer owed
  } finally {
    agents.BEFORE_WAIT.ms = was;
    (store as any).warm = warm;
  }
});

// A daemon that stops while the files run owes their answers still: the next one says the restart cut them.
test("answers a report owes for a run a restart cut are told by the next daemon", async () => {
  const p = beforeRepo({});
  const a = await agents.spawn(p.id, { prompt: "do it", isolation: "none", background: true });
  end(a, "end_turn", "report C");
  expect(await until(() => agents.get(a.id)!.status === "completed", 5_000)).toBe(true);
  flush(p.id);
  const said = "(Its new and changed tests on the base, without the change: 1 still running (its answer follows when done, and the Review view shows it).)";
  store.db.query("UPDATE agents SET result = ? WHERE id = ?").run(`report C\n\n${said}`, a.id);
  const results = [{ path: "cut.test.sh", check: "unit", command: "sh t.sh cut.test.sh", state: "running", why: "", exit: null, ms: null, cpu_ms: null }];
  store.db.query("INSERT INTO fails_before (session_id, key, repo, base, merge_base, state, results, created, follow_agent, follow_said) VALUES (?, 'k', ?, 'main', 'aaaaaaa', 'running', ?, ?, ?, ?)")
    .run(a.session_id, p.workspace, JSON.stringify(results), Date.now(), a.id, said);
  sends.length = 0;
  // The next daemon: the run is ended where it was bound, and the report's answer is told.
  await bindBefore({ store, bus, perm: () => ({ mode: "full-auto", sandbox: "off" }), confine: () => undefined, capture: (e) => { throw e; } });
  agents.recover();
  expect(agents.get(a.id)!.result).toContain("cut.test.sh could not run (the daemon restarted while it ran)");
  expect(agents.get(a.id)!.result).not.toContain("still running");
  // Nothing in it to act on: it rides with the parent's next input, once, and is no longer owed when it went.
  const id = latest(a.session_id)!.id;
  expect(isPending(p.id, (m) => m.fails_before === id)).toBe(true);
  agents.recover();
  deliver(p.id, "next input", { kind: "harness" });
  flush(p.id);
  expect(sends.filter((x) => x.id === p.id && x.text.includes("cut.test.sh could not run (the daemon restarted while it ran)"))).toHaveLength(1);
  expect(latest(a.session_id)!.follow_agent).toBeNull();
  agents.recover();
  flush(p.id);
  expect(sends.filter((x) => x.text.includes("cut.test.sh could not run"))).toHaveLength(1);
});

// Finding the files reads git: a slow read does not hold the report past BEFORE_WAIT, and what it finds follows.
test("a run whose start is slow does not hold the report, and its answers follow it", async () => {
  const p = beforeRepo({ "late.test.sh": "exit 1\n" });
  const bin = tempTree("keel-agents-git-");
  const real = Bun.which("git")!;
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" merge-base "*) sleep 3;; esac\nexec ${real} "$@"\n`, { mode: 0o755 });
  const was = agents.BEFORE_WAIT.ms, path = process.env.PATH;
  agents.BEFORE_WAIT.ms = 300;
  process.env.PATH = `${bin}:${path}`;
  try {
    const a = await agents.spawn(p.id, { prompt: "do it", isolation: "none", background: true });
    sends.length = 0;
    end(a, "end_turn", "report L");
    expect(await until(() => agents.get(a.id)!.status === "completed", 2_000)).toBe(true);
    expect(agents.get(a.id)!.result).not.toContain("Its new and changed tests");
    // It fails before: nothing to act on, so its answer rides with the parent's next input.
    expect(await until(() => !!agents.get(a.id)!.result?.includes("late.test.sh fails before: yes (exit 1)"), 15_000)).toBe(true);
    deliver(p.id, "next input", { kind: "harness" });
    flush(p.id);
    expect(sends.find((x) => x.id === p.id && x.text.includes("late.test.sh fails before: yes (exit 1)"))!.text).toContain("whose run started after it reported");
  } finally {
    agents.BEFORE_WAIT.ms = was;
    process.env.PATH = path;
  }
});

// A spawn's writes, a reviewer's own folders, and the parent's yes as the agents keep them (the gate's decision is
// write-scope.test.ts; the whole path is test/e2e/write-scope.spec.ts).
test("a spawn's write scope: its writes, a reviewer's default, a scoped agent's agents, one question a path, and only its parent's yes", async () => {
  writeAsks.init();
  const folder = join(dir, ".claude", "agents");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "code-review.md"), ["---", "name: code-review", "description: Reviews a change", "---", "Review the change."].join("\n"));
  try {
    const plain = await spawn({ title: "Build the thing" });
    expect(writeAsks.given(plain.session_id)).toBeUndefined();
    // A title that says verify is no reviewer: a builder may be titled so, and it is not scoped in silence.
    const titled = await spawn({ title: "Verify the build and fix what fails" });
    expect(writeAsks.given(titled.session_id)).toBeUndefined();
    const review = await spawn({ title: "Look at the patch", type: "code-review" });
    expect(writeAsks.given(review.session_id)).toEqual({ places: [] });
    // The parent is told why it is scoped and where it writes.
    const said = await tool("Agent").run({ description: "Look again", prompt: "look", subagent_type: "code-review", run_in_background: true, isolation: "none" }, ctx as any);
    expect(String(said.content)).toContain("It may write only in");
    expect(String(said.content)).toContain("its type, code-review, is one that reviews or verifies");
    // An agent of a scoped agent is scoped, given nothing: its own folders only.
    const kid = await agents.spawn(review.session_id, { prompt: "do it", isolation: "none", background: true, title: "Kid" });
    expect(writeAsks.given(kid.session_id)).toEqual({ places: [] });
    const given = await spawn({ title: "Write the logs", writes: ["out", "/abs/logs/*.txt"] });
    expect(writeAsks.given(given.session_id)!.places).toEqual([{ path: join(dir, "out") }, { path: "/abs/logs/*.txt", glob: true }]);
    await expect(spawn({ writes: ["/"] })).rejects.toThrow("the whole file system");
    // One question a path, however often the agent tries it.
    const first = writeAsks.ask(review.session_id, ["/elsewhere/x"], "Bash");
    expect(first).toContain("Your parent session was asked once");
    expect(writeAsks.ask(review.session_id, ["/elsewhere/x"], "Bash")).toContain("asked about it already");
    // Only the parent widens the scope; an agent with none is told it has none.
    const send = (from: string, to: string, writes: unknown) => tool("SendMessage").run({ to, message: "go on", writes }, { ...ctx, sessionId: from });
    expect((await send(given.session_id, review.id, ["/elsewhere/x"])).is_error).toBe(true);
    expect(String((await send(parent.id, plain.id, ["/elsewhere/x"])).content)).toContain("has no write scope");
    expect((await send(parent.id, review.id, ["/elsewhere"])).is_error).toBeFalsy();
    expect(writeAsks.given(review.session_id)!.places.map((x) => x.path).sort()).toEqual(["/elsewhere", "/elsewhere/x"]);
    // The question under the folder given is answered, and nothing is owed to the parent any more.
    expect(store.db.query("SELECT state FROM agent_write_asks WHERE agent_session = ? AND path = '/elsewhere/x'").get(review.session_id)).toEqual({ state: "allowed" });
    for (const x of [plain, titled, review, given, kid, ...agents.list(parent.id).filter((x) => x.title === "Look again")]) agents.stop(x.id);
    await settled();
  } finally {
    rmSync(join(folder, "code-review.md"), { force: true });
    scopes.of = undefined;
    scopes.ask = undefined;
  }
});

test("an agent started in a turn a skill narrowed keeps the skill's disallowed-tools, patterns too", async () => {
  holdChoice(parent.id, { disallowed: ["WebFetch", "Bash(git push *)"] }, "careful", false, false);
  try {
    const a = await spawn();
    expect(agents.gate(a.session_id, "WebFetch")).toContain("not allowed for this agent");
    expect(agents.gate(a.session_id, "Bash", { command: "git push origin main" }, ["Bash"])).toContain("Bash(git push *)");
    expect(agents.gate(a.session_id, "Bash", { command: "git status" }, ["Bash"])).toBeUndefined();
    end(a, "end_turn");
    await settled();
  } finally {
    dropChoice(parent.id);
  }
});

// RSH-S54: an agent takes its parent's effort and speed when its spawn names none, and a spawn may name either.
// What the child's model does not list is left off and said; a speed it does not list is refused with the ones it does.
test("an agent inherits its parent's effort and speed, a spawn may set either, and what a model lacks is said", async () => {
  const fast = { id: "fast", label: "Fast", body: { service_tier: "priority" } };
  const infos: Record<string, any> = {
    "m:x": { id: "m:x", provider: "m", model: "x", name: "x", efforts: ["low", "high"], speeds: [fast] },
    "m:y": { id: "m:y", provider: "m", model: "y", name: "y", efforts: [], speeds: [] },
  };
  setDeps({ ...baseDeps, providers: { ...baseDeps.providers, models: async () => Object.values(infos), resolve: async (id: string) => ({ info: infos[id] }) } });
  try {
    const p = store.createSession({ model: "m:x", workspace: dir, title: "inherits", settings: { effort: "low", speed: "fast" } });
    store.append(p.id, "assistant", { blocks: [] });
    const own = (o: Partial<agents.SpawnInput> = {}) => agents.spawn(p.id, { prompt: "do it", isolation: "none", background: true, ...o });
    const settingsOf = (a: agents.AgentRecord) => store.session(a.session_id)!.settings;
    // Omitted: the parent's.
    const a = await own();
    expect(settingsOf(a)).toMatchObject({ effort: "low", speed: "fast" });
    // The spawn's own wins.
    const b = await own({ effort: "high", speed: "Fast" });
    expect(settingsOf(b)).toMatchObject({ effort: "high", speed: "fast" });
    // A grandchild inherits from its parent.
    const g = await agents.spawn(a.session_id, { prompt: "deeper", isolation: "none", background: true });
    expect(settingsOf(g)).toMatchObject({ effort: "low", speed: "fast" });
    // A speed the child's model does not list is refused, with the ones it lists.
    await expect(own({ speed: "turbo" })).rejects.toThrow(/speed turbo.*x lists: fast/);
    await expect(own({ model: "m:y", speed: "fast" })).rejects.toThrow(/y lists no speed/);
    // A model that lists neither gets neither, and the spawn says so.
    const c = await own({ model: "m:y" });
    expect(settingsOf(c)?.effort).toBeUndefined();
    expect(settingsOf(c)?.speed).toBeUndefined();
    const said = agents.notCarried(c.id);
    expect(said).toContain("your effort low");
    expect(said).toContain("your speed fast");
    // Kept in the session: a daemon restart reads the same settings back.
    expect(store.session(a.session_id)!.settings).toMatchObject({ effort: "low", speed: "fast" });
    for (const x of [a, b, c, g]) end(x, "end_turn");
    await settled();
  } finally {
    setDeps(baseDeps);
  }
});

test("an agent deleted while its end is settled owes nothing and leaves no error", async () => {
  leftovers.migrate(store);
  const a = await spawn();
  const seen: unknown[] = [];
  const was = baseDeps.errors.capture;
  baseDeps.errors.capture = (...args: unknown[]) => { seen.push(args[1]); };
  try {
    end(a, "end_turn", "report gone");
    store.db.query("DELETE FROM agents WHERE id = ?").run(a.id); // its session was deleted while its end was read
    await settled();
    await settled();
  } finally { baseDeps.errors.capture = was; }
  expect(seen.map(String)).toEqual([]);
});
