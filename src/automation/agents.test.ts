import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { lineage } from "../core/tree.ts";
import { toMessages } from "../engine/turn.ts";
import * as activity from "./activity.ts";
import * as agents from "./agents.ts";
import { flush, setDeps } from "./core.ts";
import { automationTools } from "./tools.ts";
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
  await tool("wait_agent").run({ targets: [a.id] }, ctx);
  busy.delete(parent.id);
  sends.length = 0;
  flush(parent.id);
  const to = sends.filter((x) => x.id === parent.id).map((x) => x.text).join("\n");
  expect(to).toContain("report B");
  expect(to).not.toContain("report A");
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
