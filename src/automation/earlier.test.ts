// Earlier attempts at a spawn (src/automation/earlier.ts) on a real repository and a real store: three earlier
// agents (one landed, one refused by a reviewer, one on something else) and a fourth that is stopped, and what
// a new spawn's note says of them. The ranking is in earlier-rank.test.ts, the wording in earlier-line.test.ts.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { recordVerdict } from "../board/verdicts.ts";
import { Worktrees } from "../worktree/manager.ts";
import { setDeps } from "./core.ts";
import * as agents from "./agents.ts";
import * as failures from "./failures.ts";
import * as goals from "./goals.ts";
import { earlierNote } from "./earlier.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-earlier-"));
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
const repo = join(dir, "repo");
mkdirSync(repo);
sh(repo, "init", "-q", "-b", "main");
writeFileSync(join(repo, "a.txt"), "a\n");
sh(repo, "add", "a.txt");
sh(repo, "commit", "-q", "-m", "base");
const baseCommit = sh(repo, "rev-parse", "main");

const BRIEF = "Read the brief first and follow it exactly. Scratch daemons only. One commit per row.";
const coordinator = store.createSession({ model: "m:x", workspace: repo });
let created = Date.now() - 100_000, count = 0;
// An agent of the repository: its session, its task as the session's first message, its worktree row.
function agent(o: { title: string; task: string; status?: string; branch?: string; report?: string; stopped_by?: string; commit?: boolean }) {
  const s = store.createSession({ model: "m:x", workspace: repo });
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(coordinator.id, s.id);
  const id = `ag-${++count}`;
  store.db.query("INSERT INTO agents (id, parent_id, session_id, title, type, model, background, status, created, result, branch, stopped_by) VALUES (?, ?, ?, ?, 'general', 'm:x', 1, ?, ?, ?, ?, ?)")
    .run(id, coordinator.id, s.id, o.title, o.status ?? "completed", (created += 1000), o.report ?? "", o.branch ?? null, o.stopped_by ?? null);
  const text = `${BRIEF}\n\nTask:\n${o.task}`;
  store.append(s.id, "user", { text, task_at: text.length - o.task.length, kind: "task", agent_id: id });
  if (o.branch) {
    sh(repo, "branch", o.branch, "main");
    if (o.commit !== false) { sh(repo, "checkout", "-q", o.branch); writeFileSync(join(repo, `${id}.txt`), "x\n"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", o.title); sh(repo, "checkout", "-q", "main"); }
    store.db.query("INSERT INTO worktrees (session_id, repo_root, path, branch, base, base_commit, state, created, updated) VALUES (?, ?, ?, ?, 'main', ?, 'removed', 0, 0)").run(s.id, repo, join(dir, `wt-${id}`), o.branch, baseCommit);
  }
  return id;
}

const landed = agent({ title: "Leftovers: remove only what Keel made", task: "When an agent ends, list the worktrees, branches and jobs it leaves behind and remove only what Keel made (FIND-M13).", branch: "keel/leftovers-a1", report: "## Done\nBuilt the leftovers step; every check passes on the head." });
sh(repo, "merge", "-q", "--ff-only", "keel/leftovers-a1");
const refused = agent({ title: "Leftovers settle at an agent's end", task: "Show what an agent leaves behind when it ends, its worktrees and branches, and remove what Keel made when nothing would be lost.", branch: "keel/leftovers-b2", report: "Removed worktrees at the end of an agent." });
const refuser = agent({ title: "Review one", task: "Review the branch.", status: "completed" });
recordVerdict(store.db, { agent: refuser, commit: sh(repo, "rev-parse", "keel/leftovers-b2"), branches: ["keel/leftovers-b2"], land: "no", why: "It removes a worktree another session still works in. Nothing checks that first." });
const unrelated = agent({ title: "Sidebar rows redesign", task: "Redesign the sidebar's session rows and the top bar at 1920x1040 in both themes (UI-M31).", branch: "keel/sidebar-c3", report: "Rows redesigned." });
const stopped = agent({ title: "Leftovers jobs sweep", task: "Sweep the jobs an agent leaves behind when it ends.", status: "stopped", stopped_by: "owner", report: "" });

const ask = (title: string, prompt: string) => earlierNote({ repo, title, prompt: `${BRIEF}\n\nTask:\n${prompt}`, parent: coordinator.id });

test("a spawn near two earlier agents is told how each ended, and not of the one on something else", async () => {
  const note = await ask("Agent leftovers", "Show what an agent leaves behind when it ends (worktrees, branches, jobs) and remove only what Keel made.");
  expect(note).toContain(`(agent ${landed}): landed; branch keel/leftovers-a1 @${sh(repo, "rev-parse", "--short=7", "keel/leftovers-a1")}`);
  expect(note).toContain(`(agent ${refused}): refused by review (It removes a worktree another session still works in); branch keel/leftovers-b2`);
  expect(note).toContain("Report: \"Built the leftovers step; every check passes on the head.\"");
  expect(note).not.toContain("Sidebar");
  expect(note).not.toContain(unrelated);
  // The reviewer of the refusal is no earlier attempt of its own, and at most three are named.
  expect(note.match(/^- /gm)!.length).toBeLessThanOrEqual(3);
  expect(Buffer.byteLength(note)).toBeLessThan(1_200);
});

test("an agent stopped before it landed anything is abandoned, and the coordinator's own session is never named", async () => {
  const note = await ask("Sweep jobs left", "Sweep the jobs an agent leaves behind when it ends.");
  expect(note).toContain(`Leftovers jobs sweep (agent ${stopped}): abandoned (the owner stopped it)`);
});

test("nothing close: no note; and another repository has none of these agents", async () => {
  expect(await ask("Mobile dock", "Make the phone dock stay put while the keyboard is open.")).toBe("");
  expect(await earlierNote({ repo: join(dir, "elsewhere"), title: "Agent leftovers", prompt: "Show what an agent leaves behind", parent: coordinator.id })).toBe("");
});

test("work a stack cherry-picked onto the base under new hashes reads as landed, and unrelated work does not", async () => {
  const stacked = agent({ title: "Rollout gates for retries", task: "Gate the retry rollout behind the owner's rollout setting and show the gates.", branch: "keel/rollout-d4", report: "Rollout gates are in." });
  const open = agent({ title: "Rollout gates for backoff", task: "Gate the backoff rollout behind the owner's rollout setting and show the gates.", branch: "keel/rollout-e5", report: "Backoff gates are in." });
  // The stack's way: the branch's commit is picked onto main, a new hash, the same patch.
  writeFileSync(join(repo, "other.txt"), "o\n");
  sh(repo, "add", "other.txt");
  sh(repo, "commit", "-q", "-m", "something else landed first");
  sh(repo, "cherry-pick", "keel/rollout-d4");
  expect(Bun.spawnSync(["git", "merge-base", "--is-ancestor", "keel/rollout-d4", "main"], { cwd: repo }).exitCode).toBe(1);
  const note = await ask("Rollout gates", "Gate the rollout behind the owner's rollout setting and show the gates.");
  expect(note).toContain(`(agent ${stacked}): landed; branch keel/rollout-d4`);
  expect(note).toContain(`(agent ${open}): finished, not landed; branch keel/rollout-e5`);
});
