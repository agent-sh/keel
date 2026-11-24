// Dollar caps as the daemon reads them from the ledger: a top session's cap stops the agents below it
// and new agents, the 80 percent is told once into the failures lists, and the pulse's read plans on
// the ledger's session index.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "keel-caps-"));
process.env.KEEL_CONFIG_DIR ??= join(dir, "config"); // before any Keel source is loaded
const { Bus } = await import("../core/bus.ts");
const { Store } = await import("../core/store.ts");
const core = await import("./core.ts");
const agents = await import("./agents.ts");
const caps = await import("./caps.ts");
const failures = await import("./failures.ts");

const store = new Store(join(dir, "state"));
const frames: any[] = [];
const bus = new Bus();
bus.on((f: any) => frames.push(f));
let running = true;
const sent: string[] = [];
const engine = { isRunning: () => running, isHeld: () => false, heldBy: () => null, hasInput: () => false, message: () => ({ queued: true }), send: (_id: string, text: string) => (sent.push(text), { event: { seq: 1 } }) };
// The models' listing: a price for one model only.
let listed: { id: string; price?: object }[] = [];
core.setDeps({ store, bus, errors: { capture() {} }, engine, providers: { current: () => listed } } as any);
store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
agents.migrate();
caps.migrate();
failures.migrate();
store.migrate(`CREATE TABLE IF NOT EXISTS telemetry_calls (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, cost REAL, unpriced INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL, purpose TEXT);
CREATE INDEX IF NOT EXISTS telemetry_calls_ts ON telemetry_calls(ts);
CREATE INDEX IF NOT EXISTS telemetry_calls_session ON telemetry_calls(session_id, ts);`);

const t0 = Date.now() - 3_600_000;
let n = 0;
function top(title: string, cap?: number) {
  const s = store.createSession({ model: "m", workspace: dir, title });
  if (cap) store.mergeSettings(s.id, { cap_usd: cap, cap_from: t0 });
  return s.id;
}
function agent(parent: string, title: string, budget: object | null) {
  const s = store.createSession({ model: "m", workspace: dir, title });
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent, s.id);
  store.db.query("INSERT INTO agents (id, parent_id, session_id, title, type, model, background, status, created, budget, task_at) VALUES (?, ?, ?, ?, 'general-purpose', 'm', 1, 'running', ?, ?, ?)")
    .run(`cp${++n}`, parent, s.id, title, t0, budget ? JSON.stringify(budget) : null, t0);
  return s.id;
}
const spend = (session: string, cost: number, ago = 1000) => store.db.query("INSERT INTO telemetry_calls (session_id, ts, model, cost, outcome, purpose) VALUES (?, ?, 'm', ?, 'ok', 'turn')").run(session, Date.now() - ago, cost);
const said = (x: unknown) => (typeof x === "string" ? x : (x as { text?: string } | undefined)?.text);
const notice = (session: string) => failures.groupsOf(store, session).filter((g) => g.kind === "budget");

test("a session with no cap reads nothing: no step stops, no agent is refused", () => {
  const plain = top("Plain");
  const a = agent(plain, "Worker", null);
  spend(a, 5);
  expect(said(caps.closing(plain, false))).toBeUndefined();
  expect(said(agents.budgetSpent(a))).toBeUndefined();
  expect(caps.refusal(plain)).toBeUndefined();
});

test("a top session at its cap gets its last step, its agents theirs, and no agent starts", () => {
  const root = top("Capped", 1);
  const mid = agent(root, "Mid", null);
  const leaf = agent(mid, "Leaf", { steps: 99 });
  spend(root, 0.3);
  spend(leaf, 0.5);
  expect(said(caps.closing(root, false))).toBeUndefined();
  expect(said(agents.budgetSpent(leaf))).toBeUndefined();
  expect(caps.refusal(root)).toBeUndefined();
  // The tree's spend reaches the cap: the session's words, the agents' words naming the session above them.
  spend(mid, 0.25);
  expect(said(caps.closing(root, false))).toContain("The dollar cap of this session is reached ($1; spent $1.05)");
  expect(said(agents.budgetSpent(mid))).toContain('The dollar cap of "Capped", the session above you, is reached');
  expect(said(agents.budgetSpent(leaf))).toContain("any agents you started stop with you");
  expect(caps.refusal(root)).toContain("no agent starts until the owner raises it");
});

test("what was spent before the cap was set is not counted", () => {
  const root = top("Late");
  spend(root, 40, 2 * 3_600_000);
  store.mergeSettings(root, { cap_usd: 1, cap_from: Date.now() - 1000 });
  expect(said(caps.closing(root, false))).toBeUndefined();
  spend(root, 1.5, 10);
  expect(said(caps.closing(root, false))).toContain("spent $1.50");
});

test("the 80 percent of a top session is told once in its own failures, and again for a raised cap", () => {
  const root = top("Warned", 10);
  spend(root, 7.9);
  caps.closing(root, false);
  expect(notice(root)).toHaveLength(0);
  spend(root, 0.3);
  caps.closing(root, false);
  caps.closing(root, false);
  const g = notice(root);
  expect(g).toHaveLength(1);
  expect(g[0]!.count).toBe(1);
  expect(g[0]!.cls).toBe("80%");
  expect(g[0]!.sample).toContain("$8.20 of the $10 cap (82 percent)");
  // The rate of the last ten minutes and its forecast go with it (all of it was spent just now).
  expect(g[0]!.sample).toContain("in an hour");
  // Raised to $20: its 80 percent is $16, told again when it is met.
  store.mergeSettings(root, { cap_usd: 20 });
  caps.closing(root, false);
  expect(notice(root)[0]!.count).toBe(1);
  spend(root, 8);
  caps.closing(root, false);
  expect(notice(root)[0]!.count).toBe(2);
});

test("the 80 percent of an agent's dollar budget is told once to its parent, naming the agent", () => {
  const root = top("Parent");
  const a = agent(root, "Spender", { usd: 1 });
  spend(a, 0.85);
  agents.budgetSpent(a);
  agents.budgetSpent(a);
  const g = notice(root);
  expect(g).toHaveLength(1);
  expect(g[0]!.refs.map((r) => [r.id, r.label])).toEqual([[agents.byChild(a)!.id, "Spender"]]);
  expect(g[0]!.count).toBe(1);
});

test("the pulse's read gives the spend and the last ten minutes, and a frame only when a figure changed", async () => {
  const root = top("Pulsed", 100);
  const a = agent(root, "Worker", null);
  spend(a, 2, 30 * 60_000); // half an hour ago
  spend(a, 1, 60_000); // a minute ago
  spend(root, 0.5, 2000);
  caps.reset();
  frames.length = 0;
  const now = Date.now();
  const rows = await caps.refresh(now);
  const mine = rows.find((r) => r.id === root)!;
  expect(mine.kind).toBe("session");
  expect(mine.spent).toBeCloseTo(3.5, 9);
  // $1.50 in the last ten minutes, over a ten-minute window: $9 an hour.
  expect(mine.burn_hour).toBeCloseTo(9, 6);
  expect(mine.forecast_hour).toBeCloseTo(12.5, 6);
  const caps_ = () => frames.filter((f) => f.name === "caps").length;
  expect(caps_()).toBe(1);
  await caps.refresh(now);
  expect(caps_()).toBe(1);
  // An agent with a dollar budget is a cap of its own, over its own tree, from its task's start.
  const b = agent(root, "Budgeted", { usd: 2 });
  spend(b, 0.5, 120_000);
  const sub = agent(b, "Under it", null);
  spend(sub, 0.25, 30_000);
  const withAgent = await caps.refresh(now);
  const own = withAgent.find((r) => r.id === b)!;
  expect([own.kind, own.usd, +own.spent.toFixed(4), +own.burn_hour.toFixed(2)]).toEqual(["agent", 2, 0.75, 4.5]);
  expect(withAgent.find((r) => r.id === root)!.spent).toBeCloseTo(4.25, 9);
  expect(caps_()).toBe(2);
  // It ends: its cap goes from the list, in a frame.
  store.db.query("UPDATE agents SET status = 'completed' WHERE session_id = ?").run(b);
  expect((await caps.refresh(now)).some((r) => r.id === b)).toBe(false);
  expect(caps_()).toBe(3);
});

test("the read plans on the ledger's session index, and reads only the tree's rows", () => {
  const tx = store.db.transaction(() => { for (let i = 0; i < 5000; i++) store.db.query("INSERT INTO telemetry_calls (session_id, ts, model, cost, outcome, purpose) VALUES (?, ?, 'm', 0.001, 'ok', 'turn')").run(`other-${i % 500}`, Date.now() - 5000 + i); });
  tx();
  store.db.exec("ANALYZE");
  const plan = (store.db.query(`EXPLAIN QUERY PLAN ${caps.SPEND_SQL}`).all(JSON.stringify(["a-session"]), t0, Date.now()) as { detail: string }[]).map((r) => r.detail).join(" | ");
  expect(plan).toContain("telemetry_calls_session");
  expect(plan).not.toContain("telemetry_calls_ts");
});

test("the gate's read is the rows after the last one it read, never the tree's rows since the cap began", () => {
  const root = top("Constant", 1000);
  const a = agent(root, "Worker", null);
  for (let i = 0; i < 50; i++) spend(a, 0.01);
  expect(caps.treeSpend(root, t0).spent).toBeCloseTo(0.5, 9);
  // A row already counted is not read again: changing it moves nothing, a new row adds.
  store.db.query("UPDATE telemetry_calls SET cost = 100 WHERE session_id = ?").run(a);
  spend(a, 0.25);
  expect(caps.treeSpend(root, t0).spent).toBeCloseTo(0.75, 9);
  // The plan walks the ledger's row ids past the last one and does not use the session index.
  const plan = (store.db.query(`EXPLAIN QUERY PLAN ${caps.DELTA_SQL}`).all(JSON.stringify([root]), 1, t0) as { detail: string }[]).map((r) => r.detail).join(" | ");
  expect(plan).toContain("PRIMARY KEY");
  expect(plan).not.toContain("telemetry_calls_session");
  // A session that joins the tree later counts from its first row.
  const late = agent(a, "Late", null);
  spend(late, 0.5);
  expect(caps.treeSpend(root, t0).spent).toBeCloseTo(1.25, 9);
});

test("the pulse puts the exact figure back under the gate's sum", async () => {
  const root = top("Exact", 1000);
  const a = agent(root, "Worker", null);
  spend(a, 1);
  expect(caps.treeSpend(root, t0).spent).toBeCloseTo(1, 9);
  store.db.query("UPDATE telemetry_calls SET cost = 3 WHERE session_id = ?").run(a);
  expect(caps.treeSpend(root, t0).spent).toBeCloseTo(1, 9);
  await caps.changed(root, true);
  expect(caps.treeSpend(root, t0).spent).toBeCloseTo(3, 9);
});

test("the owner's own message past the cap runs the turn with a note; an agent, a loop or a report gets the closing step", () => {
  const root = top("Owner at cap", 1);
  const a = agent(root, "Worker", null);
  spend(a, 1.2);
  const notes = caps.closing(root, false, () => true) as { text: string; note?: boolean; cap: boolean };
  expect(notes.note).toBe(true);
  expect(notes.text).toContain("The owner wrote to you, so this turn goes on");
  expect(notes.text).toContain("spent $1.20");
  const last = caps.closing(root, false, () => false) as { text: string; note?: boolean };
  expect(last.note).toBeUndefined();
  expect(last.text).toContain("This is your last step");
  // Below the cap the owner's turn needs no note.
  const room = top("Room", 5);
  spend(room, 1);
  expect(caps.closing(room, false, () => true)).toBeUndefined();
});

test("a reached cap holds loops, wakes and reports of its session, told once, and they go when it is raised", async () => {
  const root = top("Held", 1);
  const a = agent(root, "Worker", null);
  spend(a, 1.5);
  running = false;
  sent.length = 0;
  try {
    core.deliver(root, "loop run one", { kind: "loop" });
    core.deliver(root, "a report", { kind: "subagent" });
    core.deliver(root, "loop run two", { kind: "loop" });
    expect(sent).toEqual([]);
    expect(core.hasPending(root)).toBe(true);
    const g = notice(root).filter((x) => x.cls === "held");
    expect(g).toHaveLength(1);
    expect(g[0]!.count).toBe(1);
    expect(g[0]!.sample).toContain("wait until the cap is raised");
    // An agent's own inputs are not held: its next step is its report.
    expect(caps.held(a)).toBe(false);
    // Raised: what waited goes, together, in one input.
    store.mergeSettings(root, { cap_usd: 10 });
    await caps.changed(root, true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("loop run one");
    expect(sent[0]).toContain("a report");
    expect(core.hasPending(root)).toBe(false);
  } finally { running = true; }
});

test("a call with no price is counted at the model's listed price now, and the cap says when a model has none", async () => {
  const root = top("Unpriced", 100);
  const priced = (model: string) => store.db.query("INSERT INTO telemetry_calls (session_id, ts, model, input, output, cost, unpriced, outcome, purpose) VALUES (?, ?, ?, 1000000, 1000000, NULL, 1, 'ok', 'turn')").run(root, Date.now() - 1000, model);
  priced("listed-m");
  priced("plan-m");
  listed = [{ id: "listed-m", price: { input: 2, output: 10 } }];
  // $2 + $10 of the listed model; the plan's call adds nothing and is counted.
  expect(caps.treeSpend(root, t0)).toEqual({ spent: 12, none: 1 });
  // The same by the delta: one more such call.
  priced("listed-m");
  expect(caps.treeSpend(root, t0)).toEqual({ spent: 24, none: 1 });
  await caps.changed(root, true);
  const row = caps.current().find((r) => r.id === root)!;
  expect(row.spent).toBeCloseTo(24, 9);
  expect(row.unpriced).toBe(1);
  listed = [];
});

test("new work for a finished agent starts an agent: refused past a reached cap, as a spawn is", async () => {
  const root = top("Cap on a revival", 1);
  const a = agent(root, "Done", null);
  store.db.query("UPDATE agents SET status = 'completed' WHERE session_id = ?").run(a);
  const id = agents.byChild(a)!.id;
  spend(a, 2);
  await expect(agents.send(id, "go on", false, undefined, root)).rejects.toThrow(/CAP: the dollar cap of this session/);
});
