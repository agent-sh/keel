// A read of a list of agents asks the database a fixed number of questions, however many agents it holds
// (a coordinator's day of ended agents was thousands of statements a list), and gives each row what a
// read of that one agent gives.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "keel-agent-rows-"));
process.env.KEEL_CONFIG_DIR ??= join(dir, "config"); // before any Keel source is loaded
const { Bus } = await import("../core/bus.ts");
const { Store } = await import("../core/store.ts");
const core = await import("./core.ts");
const agents = await import("./agents.ts");

const store = new Store(join(dir, "state"));
const engine = { isRunning: () => false, isHeld: () => false, heldBy: () => null, hasInput: () => false, message: () => ({ queued: true }) };
core.setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine } as any);
store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
agents.migrate();

const root = store.createSession({ model: "m", workspace: dir, title: "Root" });
let n = 0;
const add = (parent: string, status = "completed") => {
  const s = store.createSession({ model: "m", workspace: dir, title: `Agent ${n}` });
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parent, s.id);
  store.db.query("INSERT INTO agents (id, parent_id, session_id, title, type, model, background, status, created, ended) VALUES (?, ?, ?, ?, 'general-purpose', 'm', 1, ?, ?, ?)")
    .run(`ag${++n}`, parent, s.id, `Agent ${n}`, status, 1000 + n, status === "completed" ? 2000 + n : null);
  return s.id;
};
// Counts what the reads ask: each statement a read prepares.
const asked = <T>(f: () => T): { out: T; statements: number } => {
  const db = store.db as any;
  const q = db.query;
  let statements = 0;
  db.query = function (...a: any[]) { statements++; return q.apply(this, a); };
  try { return { out: f(), statements }; } finally { db.query = q; }
};

test("the statements of a list do not grow with the number of agents", () => {
  const counts: Record<string, number[]> = { list: [], tree: [], shown: [] };
  for (const more of [3, 40]) {
    for (let i = 0; i < more; i++) add(root.id);
    const under = agents.list(root.id).length;
    counts.list!.push(asked(() => agents.list(root.id)).statements);
    counts.tree!.push(asked(() => agents.tree(root.id, true)).statements);
    counts.shown!.push(asked(() => agents.shown(root.id)).statements);
    expect(under).toBe(n);
  }
  expect(counts.list![1]).toBe(counts.list![0]!);
  expect(counts.tree![1]).toBe(counts.tree![0]!);
  expect(counts.shown![1]).toBe(counts.shown![0]!);
});

test("a row of a list says what a read of that agent says, messages waiting included", () => {
  const live = add(root.id, "running");
  store.db.query("INSERT INTO queue (id, session_id, text, steer, pos, created, meta) VALUES ('q1', ?, 'a word', 1, 1, 1, ?), ('q2', ?, 'another', 1, 2, 1, ?), ('q3', ?, 'later', 0, 3, 1, ?)")
    .run(live, JSON.stringify({ kind: "steer" }), live, JSON.stringify({ kind: "steer" }), live, JSON.stringify({ kind: "note" }));
  const rows = agents.list(root.id);
  expect(rows.length).toBeGreaterThan(2);
  for (const r of rows) expect(r).toEqual(agents.byChild(r.session_id)!);
  expect(rows.find((r) => r.session_id === live)!.messages_waiting).toBe(2);
  expect(rows.filter((r) => r.messages_waiting).length).toBe(1);
  expect(agents.tree(root.id, true).find((r) => r.agent.session_id === live)!.agent.messages_waiting).toBe(2);
});
