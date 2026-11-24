// An agent's budget over its tree, read from the ledger as the daemon reads it: a spent budget of an
// agent above gives the agents below it their last step, a dollar limit is refused where no price is
// listed, and the reads plan on the ledger's session index.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "keel-budget-tree-"));
process.env.KEEL_CONFIG_DIR ??= join(dir, "config"); // before any Keel source is loaded
const { Bus } = await import("../core/bus.ts");
const { Store } = await import("../core/store.ts");
const core = await import("./core.ts");
const agents = await import("./agents.ts");

const store = new Store(join(dir, "state"));
// An engine that takes a message into a working agent's queue, as the real one does (Engine.message).
const engine = { isRunning: () => true, isHeld: () => false, heldBy: () => null, hasInput: () => false, message: () => ({ queued: true }) };
core.setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine } as any);
store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
agents.migrate();
// The ledger's table as src/admin/telemetry.ts makes it, the columns these reads name, and its two indexes.
store.migrate(`CREATE TABLE IF NOT EXISTS telemetry_calls (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts INTEGER NOT NULL, model TEXT NOT NULL, cost REAL, unpriced INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL, purpose TEXT);
CREATE INDEX IF NOT EXISTS telemetry_calls_ts ON telemetry_calls(ts);
CREATE INDEX IF NOT EXISTS telemetry_calls_session ON telemetry_calls(session_id, ts);`);

const t0 = Date.now() - 60_000;
const root = store.createSession({ model: "m", workspace: dir, title: "Root" });
let n = 0;
function agent(parent: string, title: string, budget: object | null) {
  const s = store.createSession({ model: "m", workspace: dir, title });
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent, s.id);
  const id = `ag${++n}`;
  store.db.query("INSERT INTO agents (id, parent_id, session_id, title, type, model, background, status, created, budget, task_at) VALUES (?, ?, ?, ?, 'general-purpose', 'm', 1, 'running', ?, ?, ?)")
    .run(id, parent, s.id, title, t0, budget ? JSON.stringify(budget) : null, t0);
  return s.id;
}
const spend = (session: string, cost: number | null, times = 1) => {
  for (let i = 0; i < times; i++) store.db.query("INSERT INTO telemetry_calls (session_id, ts, model, cost, unpriced, outcome, purpose) VALUES (?, ?, 'm', ?, ?, 'ok', 'turn')").run(session, Date.now() - 1000, cost, cost === null ? 1 : 0);
};

test("a spent budget of an agent above gives the agents below it their last step", () => {
  const outer = agent(root.id, "Outer", { usd: 0.004 });
  const inner = agent(outer, "Inner", null);
  const leaf = agent(inner, "Leaf", { steps: 50 });
  spend(outer, 0.001);
  expect(agents.budgetSpent(inner)).toBeUndefined();
  // The tree's spend passes the outer agent's limit: every agent of it is told, with whose budget it was.
  spend(inner, 0.002, 2);
  expect(agents.budgetSpent(outer)).toContain("Your budget for this task is spent ($0.004; used $0.005)");
  expect(agents.budgetSpent(inner)).toContain('The budget of "Outer", an agent above you, is spent ($0.004; used $0.005)');
  expect(agents.budgetSpent(leaf)).toContain('The budget of "Outer", an agent above you');
  expect(agents.budgetSpent(leaf)).toContain("any agents you started stop with you");
});

test("calls with no listed price are counted apart, and a dollar limit is refused where there is no price", () => {
  const solo = agent(root.id, "Solo", { minutes: 30 });
  spend(solo, null, 3);
  spend(solo, 0.01);
  const used = agents.usedOf({ session_id: solo, created: t0, task_at: t0 });
  expect([used.steps, used.unpriced, +used.usd.toFixed(4)]).toEqual([4, 3, 0.01]);
  expect(agents.usdRefusal({ usd: 1 }, "plan:model", undefined)).toContain("budget.usd cannot be counted on plan:model");
  expect(agents.usdRefusal({ steps: 3 }, "plan:model", undefined)).toBeUndefined();
  expect(agents.usdRefusal({ usd: 1 }, "p:m", { input: 1, output: 2 })).toBeUndefined();
  // A tree's builder trial does not move a spawn with a dollar budget to a model that lists no price.
  const listed = [{ id: "p:priced", price: { input: 1, output: 2 } }, { id: "p:plain" }];
  expect(agents.triedBuilder("p:plain", listed, { usd: 1 })).toBeUndefined();
  expect(agents.triedBuilder("p:plain", listed, { steps: 3 })).toBe("p:plain");
  expect(agents.triedBuilder("p:priced", listed, { usd: 1 })).toBe("p:priced");
  expect(agents.triedBuilder("p:gone", listed, undefined)).toBeUndefined();
});

test("the reads of what a task used plan on the ledger's session index", () => {
  // Many sessions' rows since the task began: a plan on the time index would read them all.
  const tx = store.db.transaction(() => { for (let i = 0; i < 5000; i++) store.db.query("INSERT INTO telemetry_calls (session_id, ts, model, cost, outcome, purpose) VALUES (?, ?, 'm', 0.001, 'ok', 'turn')").run(`other-${i % 500}`, Date.now() - 5000 + i); });
  tx();
  store.db.exec("ANALYZE");
  const plan = (sql: string) => (store.db.query(`EXPLAIN QUERY PLAN ${sql}`).all(JSON.stringify([root.id, "lost-context"]), t0) as { detail: string }[]).map((r) => r.detail).join(" | ");
  for (const sql of [agents.STEPS_SQL, agents.TREE_SPEND_SQL]) {
    const p = plan(sql);
    expect(p).toContain("telemetry_calls_session");
    expect(p).not.toContain("telemetry_calls_ts");
  }
});

test("a task's steps and dollars count every context it lost, and the agents those started", () => {
  // An agent that worked 3 steps, lost its context, and goes on in a successor's session (successor.ts):
  // the record's session is the new one, the lost one is in its `lost` list.
  const first = agent(root.id, "Lost once", { steps: 5, usd: 1 });
  spend(first, 0.01, 3);
  const helper = agent(first, "Helper of the lost context", null);
  spend(helper, 0.02);
  const id = agents.byChild(first)!.id;
  const next = store.createSession({ model: "m", workspace: dir, title: "Lost once" });
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(root.id, next.id);
  const lost = [{ kind: "refusal", model: "m", family: "other", session: first, at: Date.now() }];
  store.db.query("UPDATE agents SET session_id = ?, lost = ? WHERE id = ?").run(next.id, JSON.stringify(lost), id);
  spend(next.id, 0.01);
  const used = agents.usedOf(agents.get(id)!);
  expect([used.steps, +used.usd.toFixed(4)]).toEqual([4, 0.06]);
  // Its budget is spent by the fifth step, wherever the first four were taken.
  spend(next.id, 0.01);
  expect(agents.budgetSpent(next.id)).toContain("Your budget for this task is spent (5 steps; used 5 steps)");
});

test("a new budget sent to a working agent counts from the message", async () => {
  const busy = agent(root.id, "Busy", { steps: 2 });
  spend(busy, 0.001, 3);
  expect(agents.budgetSpent(busy)).toContain("Your budget for this task is spent (2 steps; used 3 steps)");
  const id = agents.byChild(busy)!.id;
  const before = Date.now();
  await agents.send(id, "Take two more.", false, undefined, root.id, { steps: 2 });
  expect(agents.get(id)!.task_at!).toBeGreaterThanOrEqual(before);
  expect(agents.budgetSpent(busy)).toBeUndefined();
});
