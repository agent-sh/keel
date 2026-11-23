// The facts an agent's lane reads (src/automation/lane.ts): its worktree where
// it is not here to read (on another machine, removed), its branch's work with
// no worktree row to say its base, the failure of an agent below it by name,
// and a successor's task read over every context it lost. The lines made from
// them are in lane-line.test.ts.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { Worktrees } from "../worktree/manager.ts";
import { setDeps } from "./core.ts";
import * as agents from "./agents.ts";
import * as failures from "./failures.ts";
import * as goals from "./goals.ts";
import { contextsOf, failureOf, gitOf, planOf, wordsOf, wroteOf } from "./lane.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-lane-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const store = new Store(join(dir, "state"));
const engine = { isRunning: () => false, isHeld: () => false, heldBy: () => undefined, hasInput: () => false, send: () => ({}), message: () => ({}), interrupt: async () => {}, idle: async () => {} };
setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine, providers: { models: async () => [], resolve: async () => ({ info: {} }), current: () => [] } } as any);
store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
agents.migrate();
goals.migrate();
failures.init();
new Worktrees(store, join(dir, "worktrees"));

const sh = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
};
function repo(name: string) {
  const r = join(dir, name);
  mkdirSync(r);
  sh(r, "init", "-q", "-b", "main");
  writeFileSync(join(r, "a.txt"), "a\n");
  sh(r, "add", "a.txt");
  sh(r, "commit", "-q", "-m", "base");
  return r;
}
let n = 0;
function agentRow(parentId: string, sessionId: string, o: Partial<agents.AgentRecord> = {}) {
  const id = `ag${++n}`;
  store.db.query("INSERT INTO agents (id, parent_id, session_id, title, type, model, background, status, created, first_seq, worktree, branch, machine, lost, task_at) VALUES (?, ?, ?, ?, 'general', 'm:x', 1, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, parentId, sessionId, o.title ?? `Agent ${n}`, o.status ?? "running", Date.now(), o.first_seq ?? 0, o.worktree ?? null, o.branch ?? null, o.machine ?? null, o.lost ? JSON.stringify(o.lost) : null, o.task_at ?? null);
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parentId, sessionId);
  return agents.get(id)!;
}

test("a worktree on another machine is said to be there, not read here as if it had no commit", async () => {
  expect(await gitOf({ worktree: join(dir, "nowhere"), branch: "keel/far", machine: "build-box", session_id: "s-far" })).toEqual({ remote: "build-box", branch: "keel/far" });
});

test("a removed worktree says so, with its branch and where the branch points", async () => {
  const r = repo("removed");
  sh(r, "branch", "keel/done");
  const head = sh(r, "rev-parse", "--short", "keel/done");
  const parent = store.createSession({ model: "m:x", workspace: r });
  const child = store.createSession({ model: "m:x", workspace: r });
  const folder = join(dir, "removed-wt");
  // Its row says removed (the folder is gone with it).
  store.db.query("INSERT INTO worktrees (session_id, repo_root, path, branch, base, base_commit, state, created, updated) VALUES (?, ?, ?, 'keel/done', 'main', ?, 'removed', 0, 0)").run(child.id, r, folder, sh(r, "rev-parse", "main"));
  expect(await gitOf({ worktree: folder, branch: "keel/done", machine: null, session_id: child.id })).toEqual({ gone: true, branch: "keel/done", head });
  // With no row, a folder that is gone is removed too: its branch read in its parent's repository.
  expect(await gitOf({ worktree: join(dir, "gone-wt"), branch: "keel/done", machine: null, session_id: "s-none" }, parent.workspace)).toEqual({ gone: true, branch: "keel/done", head });
  // A branch that went with it is said to be gone.
  expect(await gitOf({ worktree: join(dir, "gone-wt"), branch: "keel/lost", machine: null, session_id: "s-none" }, parent.workspace)).toEqual({ gone: true, branch: "keel/lost", head: null });
});

test("with no worktree row, its commits are counted over where it grew from, not against its head", async () => {
  const r = repo("norow");
  sh(r, "checkout", "-q", "-b", "keel/work");
  writeFileSync(join(r, "b.txt"), "b\n");
  sh(r, "add", "b.txt");
  sh(r, "commit", "-q", "-m", "Add b");
  const g = await gitOf({ worktree: r, branch: "keel/work", machine: null, session_id: "s-norow" });
  expect(g).toMatchObject({ branch: "keel/work", subject: "Add b", commits: 1, files: 1, names: ["b.txt"] });
});

test("a failure of an agent below it is named, its own is its own", async () => {
  const root = store.createSession({ model: "m:x", workspace: dir });
  const sa = store.createSession({ model: "m:x", workspace: dir, title: "Lead" });
  const sb = store.createSession({ model: "m:x", workspace: dir, title: "Bee" });
  const a = agentRow(root.id, sa.id, { title: "Lead" });
  const b = agentRow(sa.id, sb.id, { title: "Bee" });
  failures.record(root.id, { kind: "tool", cls: "Bash", message: "exit 1", ref: { id: a.id, label: "Lead" } }, sa.id);
  expect(failureOf([sa.id], a.id)).toMatchObject({ kind: "tool", text: "exit 1" });
  expect(failureOf([sa.id], a.id)?.below).toBeUndefined();
  await Bun.sleep(2);
  failures.record(sa.id, { kind: "agent", cls: "quota", message: "HTTP 402: credit too low", ref: { id: b.id, label: "Bee" } }, sb.id);
  expect(failureOf([sa.id], a.id)).toMatchObject({ kind: "agent", text: "HTTP 402: credit too low", below: "Bee" });
});

test("a successor's task is read over the contexts it lost: what they wrote, said and planned", async () => {
  const root = store.createSession({ model: "m:x", workspace: dir });
  const began = Date.now() - 1000;
  const lost = store.createSession({ model: "m:x", workspace: dir, title: "Heir" });
  store.append(lost.id, "assistant", { blocks: [{ type: "text", text: "Wrote the parser. Next I'll run the tests." }, { type: "tool_use", id: "w1", name: "Write", input: { file_path: join(dir, "src/parse.ts"), content: "x" } }] });
  store.append(lost.id, "tool_result", { results: [{ tool_use_id: "w1", content: "ok" }] });
  goals.fromPlanTool(lost.id, "TodoWrite", { todos: [{ content: "Write the parser", status: "completed" }, { content: "Run the tests", status: "in_progress" }] });
  const now = store.createSession({ model: "m:x", workspace: dir, title: "Heir" });
  const a = agentRow(root.id, now.id, { title: "Heir", lost: [{ kind: "context", model: "m:x", family: "anthropic" as any, session: lost.id, at: Date.now() }], task_at: began });
  const ctx = contextsOf(a, began);
  expect(ctx.map((c) => c.id)).toEqual([now.id, lost.id]);
  expect(await wroteOf(ctx, dir)).toEqual({ names: ["src/parse.ts"], n: 1 });
  expect(await wordsOf(ctx)).toBe("Wrote the parser. Next I'll run the tests.");
  expect(planOf(ctx)?.map((t) => t.text)).toEqual(["Write the parser", "Run the tests"]);
  // Its own words and plan, once it has them, come first; a write read again takes only what came after.
  store.append(now.id, "assistant", { blocks: [{ type: "text", text: "Picking up: I will now fix the lexer." }, { type: "tool_use", id: "w2", name: "Edit", input: { file_path: join(dir, "src/lex.ts") } }] });
  expect(await wordsOf(ctx)).toBe("Picking up: I will now fix the lexer.");
  expect((await wroteOf(ctx, dir))?.n).toBe(2);
  // A call whose result failed after the last read wrote nothing.
  store.append(now.id, "tool_result", { results: [{ tool_use_id: "w2", content: "no such file", is_error: true }] });
  expect(await wroteOf(ctx, dir)).toEqual({ names: ["src/parse.ts"], n: 1 });
});
