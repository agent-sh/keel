import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { lineage } from "../core/tree.ts";
import * as activity from "./activity.ts";
import * as agents from "./agents.ts";
import { deliver, flush, setDeps } from "./core.ts";
import * as failures from "./failures.ts";
import * as waits from "./waits.ts";

// The failure notice against a stand-in engine (a child's turn ends when the
// test says so): who is told, when, and what stays a report of its own. The
// grouping itself is in failure-groups.test.ts.
const dir = mkdtempSync(join(tmpdir(), "keel-failures-"));
const store = new Store(join(dir, "state"));
const busy = new Set<string>();
const held = new Set<string>();
const sends: { id: string; text: string }[] = [];
const engine = {
  isRunning: (id: string) => busy.has(id),
  isHeld: (id: string) => held.has(id),
  send: (id: string, text: string, o: any) => (sends.push({ id, text }), { event: store.append(id, "user", { text, ...o?.meta }) }),
  interrupt: async () => {},
  lineage: (id: string) => lineage(store.events(id), store.session(id)?.head ?? null),
  idle: async () => {},
};
setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine, providers: { models: async () => [], resolve: async () => ({ info: {} }), current: () => [] } } as any);
store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT"); // the fleet adds it in the daemon
agents.migrate();
waits.migrate();
activity.migrate();
failures.init();

const QUOTA = "HTTP 402: your credit balance is too low to make this request.";
const parentOf = (title: string) => {
  const p = store.createSession({ model: "m:x", workspace: dir, title });
  store.append(p.id, "assistant", { blocks: [] }); // a warm cache: agents start without the stagger
  return p;
};
const spawn = (parentId: string, title: string) => agents.spawn(parentId, { prompt: title, isolation: "none", background: true });
// The agent's turn ends on a provider error, with no words of its own.
const fail = (a: agents.AgentRecord, message = QUOTA) => {
  store.append(a.session_id, "error", { message });
  store.append(a.session_id, "turn_end", { reason: "error" });
  agents.onTurnEnd(a.session_id, "error");
};
const settled = () => Bun.sleep(5);
const to = (id: string) => sends.filter((s) => s.id === id).map((s) => s.text);
const misses = (sessionId: string, n: number) => {
  const s = store.session(sessionId)!;
  for (let i = 0; i < n; i++)
    failures.hooks.toolRan!(s, { id: `c${i}`, tool: { name: "Read" } } as any, { type: "tool_result", tool_use_id: `c${i}`, content: `File does not exist: /work/f${i}.txt`, is_error: true }, { ms: 1, outcome: "error" });
};
const owedRows = (sessionId: string) => store.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM session_failures WHERE session_id = ? AND owed > 0").get(sessionId)!.n;

// P1: past the twenty ids a cause can name, an agent keeps its own report.
test("the twenty-first agent to fail on one cause before the notice goes keeps its own report", async () => {
  const p = parentOf("Twenty-one");
  agents.setLimit(p.id, 30);
  busy.add(p.id); // the parent is in its turn: everything waits for its end
  const all: agents.AgentRecord[] = [];
  for (let i = 1; i <= 21; i++) all.push(await spawn(p.id, `Lane ${i}`));
  for (const a of all) { fail(a); await settled(); }
  busy.delete(p.id);
  flush(p.id);
  const got = to(p.id);
  expect(got).toHaveLength(1);
  expect(got[0]).toContain("20 agents failed on one cause (quota)");
  expect(got[0]).not.toContain("not listed");
  // Every one of the twenty-one is named once: twenty in the entry, one in its report.
  for (const a of all) expect(got[0]!.split(a.id).length - 1).toBe(1);
  expect(got[0]!.match(/<subagent_result [^>]*status="failed"/g)).toHaveLength(1);
  expect(got[0]).toContain(`<subagent_result agent_id="${all[20]!.id}"`);
});

// P2-3, P2-4: what is never told is never owed.
test("a silent agent's failures and a single tool miss leave nothing owed", async () => {
  const p = parentOf("Quiet");
  const reviewer = store.createSession({ model: "m:x", workspace: dir, title: "Review" });
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(p.id, reviewer.id);
  agents.adopt(p.id, reviewer.id, { title: "Review", type: "reviewer", model: "m:x" });
  misses(reviewer.id, 5);
  const worker = await spawn(p.id, "Worker");
  misses(worker.session_id, 1);
  // Counted for the owner's record, owed to nobody: no row a start has to look at.
  expect(failures.groupsOf(store, p.id).find((g) => g.kind === "tool")).toMatchObject({ count: 6, owed: 0 });
  expect(owedRows(p.id)).toBe(0);
  // The worker repeating it is owed, under its own id only.
  misses(worker.session_id, 2);
  const g = failures.groupsOf(store, p.id).find((x) => x.kind === "tool")!;
  expect([g.count, g.owed]).toEqual([8, 3]);
  expect(g.refs.filter((r) => r.owed).map((r) => r.id)).toEqual([worker.id]);
});

// P2-5: giving up the report and writing the failure are one step.
test("an agent whose failure cannot be recorded reports normally", async () => {
  const p = parentOf("No record");
  const a = await spawn(p.id, "Lane");
  const redact = store.redact;
  // The failure's text is redacted as a string; an event's data is an object.
  store.redact = (_s, kind, v) => { if (kind === "error" && typeof v === "string") throw new Error("the vault is down"); return v; };
  try {
    busy.add(p.id);
    fail(a);
    await settled();
  } finally {
    store.redact = redact;
  }
  busy.delete(p.id);
  flush(p.id);
  const got = to(p.id);
  expect(got).toHaveLength(1);
  expect(got[0]).toContain(`<subagent_result agent_id="${a.id}" title="Lane" status="failed">`);
  expect(got[0]).toContain(`Error: ${QUOTA}`);
  expect(got[0]).not.toContain("<failures>");
});

// P2-6: a notice does not start a turn the owner stopped the session from starting.
test("a held parent gets the notice after the owner's next turn, not before", async () => {
  const p = parentOf("Held");
  const a = await spawn(p.id, "Lane 1");
  held.add(p.id); // the owner stopped its turn: nothing starts by itself
  fail(a);
  await Bun.sleep(400); // past the wait that lets a burst arrive together
  expect(to(p.id)).toEqual([]);
  // A notice lined up while the turn ran is not sent at the stop either.
  held.delete(p.id);
  busy.add(p.id);
  const b = await spawn(p.id, "Lane 2");
  fail(b);
  await settled();
  held.add(p.id);
  busy.delete(p.id);
  flush(p.id);
  expect(to(p.id)).toEqual([]);
  // The owner writes; that turn's end is when the notice goes, with both agents.
  held.delete(p.id);
  failures.wake(p.id);
  flush(p.id);
  const got = to(p.id);
  expect(got).toHaveLength(1);
  expect(got[0]).toContain("2 agents failed on one cause (quota)");
  expect(got[0]).toContain(a.id);
  expect(got[0]).toContain(b.id);
});

// Re-review P2-1: a wait returns one report. The failure of an earlier task of
// the same agent is not that report, so it is still told.
const done = (a: agents.AgentRecord, text = "task two is done") => {
  store.append(a.session_id, "assistant", { blocks: [{ type: "text", text }] });
  store.append(a.session_id, "turn_end", { reason: "end_turn" });
  agents.onTurnEnd(a.session_id, "end_turn");
};
const waited = (p: { id: string }, a: agents.AgentRecord) => agents.ackWaited(p.id, [{ id: a.id, report: agents.reportId(agents.get(a.id)!) }]);

test("a wait that returns an agent's later report does not clear its earlier failure", async () => {
  const p = parentOf("Two tasks");
  busy.add(p.id);
  const a = await spawn(p.id, "Lane");
  fail(a); // task 1 fails, with no words of its own
  await settled();
  await agents.send(a.id, "try the other way"); // task 2
  done(agents.get(a.id)!);
  await settled();
  waited(p, a); // wait_agent returned task 2's report
  busy.delete(p.id);
  flush(p.id);
  const got = to(p.id);
  expect(got).toHaveLength(1);
  expect(got[0]).toContain(`1 agent failed (quota), with no report of its own: ${a.id} "Lane"`);
  expect(got[0]).not.toContain("<subagent_result"); // the wait holds task 2's report
});

test("a wait that returns a second failure, on another cause, leaves the first one owed", async () => {
  const p = parentOf("Two causes");
  busy.add(p.id);
  const a = await spawn(p.id, "Lane");
  fail(a);
  await settled();
  await agents.send(a.id, "try the other way");
  fail(agents.get(a.id)!, "HTTP 529: the model is overloaded");
  await settled();
  waited(p, a); // the wait returned the second failure
  busy.delete(p.id);
  flush(p.id);
  const got = to(p.id);
  expect(got).toHaveLength(1);
  expect(got[0]).toContain(`1 agent failed (quota), with no report of its own: ${a.id} "Lane"`);
  expect(got[0]).not.toContain("overloaded");
  expect(owedRows(p.id)).toBe(0);
});

test("an input with a report and a notice says once how many agents still run, and leaves a reporting agent's tool failure to its report", async () => {
  const p = parentOf("One sentence");
  busy.add(p.id);
  const a = await spawn(p.id, "Lane");
  const b = await spawn(p.id, "Worker");
  await spawn(p.id, "Slow"); // still running when the input goes
  misses(b.session_id, 3);
  fail(a);
  await settled();
  done(b, "the work is done");
  await settled();
  busy.delete(p.id);
  flush(p.id);
  const got = to(p.id);
  expect(got).toHaveLength(1);
  expect(got[0]).toContain(`<subagent_result agent_id="${b.id}"`);
  expect(got[0]).toContain("1 agent failed (quota)");
  expect(got[0]!.match(/still running/g)).toHaveLength(1);
  expect(got[0]).not.toContain("Read failed");
  expect(owedRows(p.id)).toBe(0);
  // The notice reads last, after the report it came with.
  expect(got[0]!.indexOf("<failures>")).toBeGreaterThan(got[0]!.indexOf("</subagent_result>"));
});

test("a prune that fails after the failure is written does not bring the report back", async () => {
  const p = parentOf("Prune");
  busy.add(p.id);
  const a = await spawn(p.id, "Lane");
  const query = store.db.query.bind(store.db);
  (store.db as any).query = (sql: string) => { if (sql.startsWith("DELETE FROM session_failures")) throw new Error("the prune failed"); return query(sql); };
  try {
    fail(a, "HTTP 500: a cause this session has not seen");
    await settled();
  } finally {
    (store.db as any).query = query;
  }
  busy.delete(p.id);
  flush(p.id);
  const got = to(p.id);
  expect(got).toHaveLength(1);
  expect(got[0]).toContain(`1 agent failed (server), with no report of its own: ${a.id} "Lane"`);
  expect(got[0]).not.toContain("<subagent_result");
});

// Last in the file: it sets other daemon parts.
test("the notice's rider goes with the daemon parts it was set up for", () => {
  const other = new Store(join(dir, "other")); // a store the notice was never set up on: no failures table
  const out: string[] = [];
  const send = (id: string, text: string, o: any) => (out.push(text), { event: other.append(id, "user", { text, ...o?.meta }) });
  setDeps({ store: other, bus: new Bus(), errors: { capture() {} }, engine: { isRunning: () => false, send } } as any);
  const s = other.createSession({ model: "m:x", workspace: dir, title: "Other parts" });
  deliver(s.id, "a wake", { kind: "wake" });
  expect(out).toEqual(["a wake"]);
});
