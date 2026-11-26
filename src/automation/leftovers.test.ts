// An agent's end against real repositories and real commands. Keel removes only the worktree it made for the
// agent and that worktree's branch, when nothing of them would be lost; nothing the agent's commands can write
// (a trace file, a tmux server the owner later uses, a forced branch, an owner's branch it checks out) makes
// anything of the owner's go. (The decisions alone are in leftover-rules.test.ts.)
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv } from "../../test/env.ts";
import { Store } from "../core/store.ts";
import { startJob } from "../tools/jobs.ts";
import { Worktrees } from "../worktree/manager.ts";
import { Overlaps } from "../worktree/overlap-scan.ts";
import { bindLedger, record, repoOf, treeOf, unbindLedger } from "../checks/ledger.ts";
import { cmd } from "./leftover-rules.ts";
import * as leftovers from "./leftovers.ts";

// Each test runs git a few dozen times; on a busy disk one git command can take half a second.
setDefaultTimeout(30_000);
const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "leftovers-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// git's own settings for this file: an identity, and nothing of the machine's.
const gitconfig = join(root, "gitconfig");
const identity = "[user]\n\tname = t\n\temail = t@t\n";
writeFileSync(gitconfig, identity);
ownEnv({ GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const has = (c: string) => { try { execFileSync(c, ["-V"], { stdio: "ignore" }); return true; } catch { return false; } };
const repo = (name: string, branch = "main") => {
  const r = join(root, name);
  mkdirSync(r, { recursive: true });
  git(r, "init", "-q", "-b", branch);
  writeFileSync(join(r, ".gitignore"), "out/\n");
  git(r, "add", "-A");
  git(r, "commit", "-qm", "init");
  return r;
};
const storeAt = (name: string) => {
  const store = new Store(join(root, name));
  if (!store.columnExists("sessions", "machine")) store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
  leftovers.migrate(store);
  return store;
};
// An agent of its own: a session, the reading from its start, its commands run as its tools run them, its end.
function agent(store: Store, name: string, dirs: string[]) {
  const s = store.createSession({ workspace: dirs[0]!, title: name, model: "scripted:stand-in" });
  const a = { id: `ag-${name}`, session_id: s.id, parent_id: "p", created: Date.now() - 1000, report: `ag-${name}:0` };
  let n = 0;
  const start = (command: string, cwd = dirs[0]!) => startJob({ sessionId: s.id, command, cwd, logDir: join(root, "jobs", name), callId: `c${++n}` });
  return {
    session: s,
    begin: () => leftovers.before(store, a.id, dirs),
    start,
    // Resolves with the job, ended.
    run: async (command: string, cwd = dirs[0]!) => { const j = start(command, cwd); await j.exited; return j; },
    end: () => leftovers.settle({ store, isRunning: () => false }, a),
  };
}
const branchesOf = (r: string) => git(r, "branch", "--format=%(refname:short)").trim().split("\n");
const treesOf = (r: string) => git(r, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
// A trace2 event file of git's own form, written where an earlier build read a job's trace from: what a
// command of the agent can write.
const forge = (log: string, file: string, argv: string[], repoDir: string) => {
  const d = log.replace(/\.log$/, ".git-trace");
  mkdirSync(d, { recursive: true });
  const sid = `forged-${file}`;
  writeFileSync(join(d, file), [
    { event: "start", sid, time: new Date(0).toISOString(), argv },
    { event: "def_repo", sid, worktree: repoDir },
    { event: "exit", sid, time: new Date(Date.now() + 1e12).toISOString(), code: 0 },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
};

test("a forged trace takes nothing in a repository the agent was not given: the owner's clean worktree and merged branch stay", async () => {
  const store = storeAt("state-f1");
  const o = repo("f1-owner");
  git(o, "worktree", "add", "-q", join(root, "f1-owner-wt"), "-b", "owner-wt-b");
  git(o, "branch", "owner-merged");
  const a = repo("f1-agent");
  const one = agent(store, "f1", [a]);
  await one.begin();
  const j = await one.run("true");
  forge(j.log, "a", ["git", "worktree", "add", join(root, "f1-owner-wt")], o);
  forge(j.log, "b", ["git", "branch", "owner-merged"], o);
  const line = await one.end();
  expect(treesOf(o)).toContain(join(root, "f1-owner-wt"));
  expect(branchesOf(o)).toEqual(expect.arrayContaining(["owner-wt-b", "owner-merged"]));
  expect(line).toBe("");
});

test("a forged trace takes nothing in its own repository: what the owner made there after it started is listed, not removed", async () => {
  const store = storeAt("state-f2");
  const b = repo("f2");
  const two = agent(store, "f2", [b]);
  await two.begin();
  git(b, "worktree", "add", "-q", join(root, "f2-owner"), "-b", "f2-owner-b");
  git(b, "branch", "f2-owner-merged");
  const k = await two.run("true");
  forge(k.log, "a", ["git", "worktree", "add", join(root, "f2-owner")], b);
  forge(k.log, "b", ["git", "branch", "f2-owner-merged"], b);
  const line2 = await two.end();
  expect(treesOf(b)).toContain(join(root, "f2-owner"));
  expect(branchesOf(b)).toEqual(expect.arrayContaining(["f2-owner-b", "f2-owner-merged"]));
  expect(line2).toBe(`Left behind: new in its repositories since it started, not removed (who made them is not known; Settings, Leftovers removes them): worktree ${join(root, "f2-owner")} (branch f2-owner-b: nothing uncommitted, no commit of its own), branch f2-owner-merged in ${b} (every commit on another branch).`);
});

// (tmux is what the case is about: a machine without it has nothing to check.)
test.skipIf(!has("tmux"))("the owner's git in a tmux server the agent's command started is the owner's: it stays", async () => {
  const r = repo("t1");
  const store = storeAt("state-t");
  const ag = agent(store, "t1", [r]);
  await ag.begin();
  const sock = `keel-left-${process.pid}`;
  try {
    expect((await ag.run(`tmux -L ${sock} new -d -s x 'sleep 300'`)).exitCode).toBe(0);
    // The owner, from a shell of their own, opens a window of that server and makes a worktree there.
    execFileSync("tmux", ["-L", sock, "new-window", "-d", `cd ${r} && git worktree add -q ../t1-owner -b t1-owner-b`], { env: { ...process.env, TMUX: undefined } as NodeJS.ProcessEnv });
    for (let i = 0; i < 100 && !existsSync(join(root, "t1-owner", ".git")); i++) await Bun.sleep(50);
    expect(existsSync(join(root, "t1-owner", ".git"))).toBe(true);
    await Bun.sleep(200); // git writes the branch's ref after the folder
    const line = await ag.end();
    expect(treesOf(r)).toContain(join(root, "t1-owner"));
    expect(branchesOf(r)).toContain("t1-owner-b");
    // The tmux server was the agent's command: stopped.
    expect(line).toContain(`stopped \`tmux -L ${sock} new -d -s x 'sleep 300'\``);
    expect(line).toContain(`worktree ${join(root, "t1-owner")} (branch t1-owner-b: nothing uncommitted, no commit of its own)`);
  } finally {
    try { execFileSync("tmux", ["-L", sock, "kill-server"], { stdio: "ignore" }); } catch {}
  }
});

test("an owner's branch the agent resets with branch -f in the same second stays", async () => {
  const store = storeAt("state-r1");
  const r1 = repo("r1");
  git(r1, "commit", "-q", "--allow-empty", "-m", "two");
  const one = agent(store, "r1", [r1]);
  await one.begin();
  git(r1, "branch", "race");
  expect((await one.run("git branch -f race HEAD~1")).exitCode).toBe(0);
  const line1 = await one.end();
  expect(branchesOf(r1)).toContain("race");
  expect(line1).toContain(`branch race in ${r1} (every commit on another branch)`);
});

test("an old branch of the owner's whose reflog expired, reset by the agent with branch -f, stays", async () => {
  const store = storeAt("state-r2");
  const o = repo("r2-owner");
  git(o, "commit", "-q", "--allow-empty", "-m", "two");
  git(o, "branch", "old-owner");
  git(o, "reflog", "expire", "--expire=now", "--all");
  const two = agent(store, "r2", [repo("r2")]);
  await two.begin();
  expect((await two.run(`git -C ${o} branch -f old-owner HEAD~1`)).exitCode).toBe(0);
  expect(await two.end()).toBe("");
  expect(branchesOf(o)).toContain("old-owner");
});

test("an owner's branch the agent checks out into a new worktree in the same second stays, and so does the worktree", async () => {
  const store = storeAt("state-r3");
  const r3 = repo("r3");
  const three = agent(store, "r3", [r3]);
  await three.begin();
  git(r3, "branch", "feat");
  expect((await three.run("git worktree add -q ../r3-w feat")).exitCode).toBe(0);
  const line3 = await three.end();
  expect(treesOf(r3)).toContain(join(root, "r3-w"));
  expect(branchesOf(r3)).toContain("feat");
  expect(line3).toContain(`worktree ${join(root, "r3-w")} (branch feat: nothing uncommitted, no commit of its own)`);
});

test("what the agent's own commands made is listed with what is in it, and nothing of it is removed", async () => {
  const r = repo("rl");
  const store = storeAt("state-l");
  const ag = agent(store, "listed", [r]);
  await ag.begin();
  const wt = (n: string) => join(root, "rl.worktrees", n);
  expect((await ag.run(`git worktree add -q ${wt("clean")} -b mine-clean && git worktree add -q ${wt("ignored")} -b mine-ignored && git worktree add -q --detach ${wt("d")} && git branch tmp`)).exitCode).toBe(0);
  mkdirSync(join(wt("ignored"), "out"));
  writeFileSync(join(wt("ignored"), "out", "results.csv"), "a,b\n");
  expect((await ag.run("echo y > y && git add y && git commit -qm two", wt("d"))).exitCode).toBe(0);
  const line = await ag.end();
  for (const w of ["clean", "ignored", "d"]) expect(treesOf(r)).toContain(wt(w));
  expect(branchesOf(r)).toEqual(expect.arrayContaining(["mine-clean", "mine-ignored", "tmp"]));
  expect(line).toContain(`worktree ${wt("clean")} (branch mine-clean: nothing uncommitted, no commit of its own)`);
  expect(line).toContain(`worktree ${wt("ignored")} (branch mine-ignored: 1 ignored path (out/))`);
  expect(line).toContain(`worktree ${wt("d")} (detached: 1 commit on no other branch)`);
  expect(line).toContain(`branch tmp in ${r} (every commit on another branch)`);
  // A second pass of the same end (a daemon that went down before the report was stored) says the same.
  expect(await ag.end()).toBe(line);
});

// The worktree Keel made for an agent: made through the manager and recorded with the agent's session, as
// spawn_agent's isolation does.
async function keelMade(name: string) {
  const r = repo(name);
  const store = storeAt(`state-${name}`);
  const wts = new Worktrees(store, join(root, `${name}-wts`));
  const s = store.createSession({ workspace: r, title: name, model: "scripted:stand-in" });
  const { wt } = await wts.create(s.id, r, name);
  wts.adopt(s.id, wt);
  const own = () => leftovers.ownWorktree({ store, wts }, s.id, () => false);
  return { r, store, wts, s, wt, own };
}

test("the worktree Keel made for the agent goes with its branch when clean, and when every commit of it is on another branch", async () => {
  const k = await keelMade("own-clean");
  mkdirSync(join(k.wt.path, "out"));
  writeFileSync(join(k.wt.path, "out", "build.log"), "x\n"); // ignored output goes with it, as it always has, and is named
  expect(await k.own()).toBe("\n\n(The agent changed no files; its worktree was removed, and 1 ignored path with it: out/.)");
  expect(existsSync(k.wt.path)).toBe(false);
  expect(branchesOf(k.r)).not.toContain(k.wt.branch);
  expect(k.wts.get(k.s.id)!.state).toBe("removed");
  // A commit that is also on main: nothing is lost with the branch.
  const m = await keelMade("own-merged");
  git(m.wt.path, "commit", "-q", "--allow-empty", "-m", "work");
  git(m.r, "merge", "-q", "--ff-only", m.wt.branch);
  expect(await m.own()).toBe(`\n\nIts 1 commit over main is also on main: its worktree ${m.wt.path} and branch ${m.wt.branch} were removed.`);
  expect(existsSync(m.wt.path)).toBe(false);
  expect(branchesOf(m.r)).toEqual(["main"]);
});

// A child agent's worktree is made from its parent's branch, which main does not have yet. The parent's commits
// are the parent's: with none of its own the child has nothing to merge, and its worktree and branch go.
test("a worktree made from another live Keel branch, with nothing of its own, is not told as work to merge", async () => {
  const parent = await keelMade("own-from-parent");
  git(parent.wt.path, "commit", "-q", "--allow-empty", "-m", "the parent's work");
  const child = store0(parent);
  const made = await parent.wts.create(child.id, parent.r, "child", parent.wt.branch);
  parent.wts.adopt(child.id, made.wt);
  const note = await leftovers.ownWorktree({ store: parent.store, wts: parent.wts }, child.id, () => false);
  expect(note).not.toContain("Review and merge");
  expect(note).toContain(`its worktree was removed`);
  expect(note).toContain(`the commits it started from are on ${parent.wt.branch}`);
  expect(existsSync(made.wt.path)).toBe(false);
  expect(branchesOf(parent.r)).not.toContain(made.wt.branch);
  // The parent's branch is the parent's, untouched.
  expect(branchesOf(parent.r)).toContain(parent.wt.branch);
  // With a commit of its own, it is told as work to merge, as ever.
  const second = store0(parent);
  const own = await parent.wts.create(second.id, parent.r, "second", parent.wt.branch);
  parent.wts.adopt(second.id, own.wt);
  git(own.wt.path, "commit", "-q", "--allow-empty", "-m", "its own");
  const note2 = await leftovers.ownWorktree({ store: parent.store, wts: parent.wts }, second.id, () => false);
  expect(note2).toContain(`Its work is on branch ${own.wt.branch} in the worktree ${own.wt.path}: 1 commit over ${parent.wt.branch}, 0 uncommitted files.`);
  expect(existsSync(own.wt.path)).toBe(true);
});
const store0 = (k: { store: Store; r: string }) => k.store.createSession({ workspace: k.r, title: "child", model: "scripted:stand-in" });

test("the worktree Keel made is kept and listed with uncommitted work, an untracked file git hides, or a commit on no other branch", async () => {
  // Uncommitted work.
  const d = await keelMade("own-dirty");
  writeFileSync(join(d.wt.path, ".gitignore"), "changed\n");
  expect(await d.own()).toStartWith(`\n\nIts work is on branch ${d.wt.branch} in the worktree ${d.wt.path}: 0 commits over main, 1 uncommitted file. Review and merge it from there (git merge ${d.wt.branch}).\nTip: `);
  expect(existsSync(d.wt.path)).toBe(true);
  // An untracked file, where the owner's git does not show untracked files.
  const u = await keelMade("own-untracked");
  writeFileSync(gitconfig, `${identity}[status]\n\tshowUntrackedFiles = no\n`);
  try {
    writeFileSync(join(u.wt.path, "notes.txt"), "notes\n");
    expect(await u.own()).toContain("1 uncommitted file");
    expect(readFileSync(join(u.wt.path, "notes.txt"), "utf8")).toBe("notes\n");
  } finally {
    writeFileSync(gitconfig, identity);
  }
  // A commit only its branch holds.
  const c = await keelMade("own-commit");
  git(c.wt.path, "commit", "-q", "--allow-empty", "-m", "only here");
  expect(await c.own()).toContain(`Its work is on branch ${c.wt.branch} in the worktree ${c.wt.path}: 1 commit over main, 0 uncommitted files.`);
  expect(existsSync(c.wt.path)).toBe(true);
  expect(branchesOf(c.r)).toContain(c.wt.branch);
  // Listed on the page once its session is gone from work, as Keel's own for that session.
  c.store.db.query("UPDATE sessions SET archived = 1 WHERE id = ?").run(c.s.id);
  const s = await leftovers.survey({ store: c.store, isRunning: () => false, workspace: c.r });
  expect(s.worktrees.find((w) => w.path === c.wt.path)).toMatchObject({ branch: c.wt.branch, ahead: 1, removable: true, by: { session_id: c.s.id, how: "keel" } });
  // A process of the owner's in a clean one keeps it.
  const p = await keelMade("own-busy");
  const hand = spawn("sleep", ["60"], { cwd: p.wt.path, stdio: "ignore" });
  try {
    await Bun.sleep(100);
    expect(await p.own()).toBe(`\n\nWorktree ${p.wt.path} (branch ${p.wt.branch}) was kept: a process works in it: pid ${hand.pid} (sleep).`);
  } finally {
    hand.kill();
  }
});

test("the worktree Keel made keeps its branch, with the branch's only commit, when its HEAD was detached on main", async () => {
  const d = await keelMade("own-detached");
  git(d.wt.path, "commit", "-q", "--allow-empty", "-m", "only on the branch");
  const tip = git(d.wt.path, "rev-parse", "HEAD").trim();
  git(d.wt.path, "checkout", "-q", "--detach", "main");
  expect(await d.own()).toBe(`\n\nWorktree ${d.wt.path} (branch ${d.wt.branch}) was kept: its HEAD is detached, not on ${d.wt.branch}.`);
  expect(git(d.r, "rev-parse", `refs/heads/${d.wt.branch}`).trim()).toBe(tip);
  expect(existsSync(d.wt.path)).toBe(true);
});

test("the worktree Keel made keeps its branch, with the branch's only commit, when its HEAD went to a new branch reset to main", async () => {
  const n = await keelMade("own-switched");
  git(n.wt.path, "commit", "-q", "--allow-empty", "-m", "only on the branch");
  git(n.wt.path, "checkout", "-q", "-b", "other-branch");
  git(n.wt.path, "reset", "-q", "--hard", "main");
  expect(await n.own()).toBe(`\n\nWorktree ${n.wt.path} (branch ${n.wt.branch}) was kept: its HEAD is on other-branch, not on ${n.wt.branch}.`);
  expect(branchesOf(n.r)).toContain(n.wt.branch);
});

test("two of Keel's worktrees ending together with a commit only their branches share both stay", async () => {
  const r = repo("own-pair");
  const store = storeAt("state-own-pair");
  const wts = new Worktrees(store, join(root, "own-pair-wts"));
  const made = async (title: string) => {
    const s = store.createSession({ workspace: r, title, model: "scripted:stand-in" });
    const { wt } = await wts.create(s.id, r, title);
    wts.adopt(s.id, wt);
    return { s, wt };
  };
  const a = await made("alpha");
  git(a.wt.path, "commit", "-q", "--allow-empty", "-m", "shared");
  const b = await made("beta");
  git(b.wt.path, "reset", "-q", "--hard", a.wt.branch);
  const sha = git(r, "rev-parse", a.wt.branch).trim();
  const notes = await Promise.all([a, b].map((x) => leftovers.ownWorktree({ store, wts }, x.s.id, () => false)));
  for (const note of notes) expect(note).toContain("1 commit over main, 0 uncommitted files");
  expect(git(r, "branch", "--contains", sha)).toContain("keel/");
  expect(branchesOf(r)).toEqual(expect.arrayContaining([a.wt.branch, b.wt.branch]));
});

test("a worktrees row that names a worktree outside Keel's folder, or a branch not of Keel's naming, is never removed", async () => {
  const k = await keelMade("own-forged");
  const owners = join(root, "own-forged-owner");
  git(k.r, "worktree", "add", "-q", owners, "-b", "owner-b");
  const s = k.store.createSession({ workspace: k.r, title: "forged", model: "scripted:stand-in" });
  const base = git(k.r, "rev-parse", "HEAD").trim();
  const row = (path: string, branch: string, sid: string) => k.store.db.query("INSERT INTO worktrees (session_id, repo_root, path, branch, base, base_commit, state, snapshot_ref, created, updated) VALUES (?, ?, ?, ?, 'main', ?, 'active', NULL, 0, 0)").run(sid, k.r, path, branch, base);
  row(owners, "owner-b", s.id);
  expect(await leftovers.ownWorktree({ store: k.store, wts: k.wts }, s.id, () => false)).toBe(`\n\nWorktree ${owners} (branch owner-b) was kept: it is not in Keel's worktree folder on a branch of Keel's naming.`);
  expect(existsSync(owners)).toBe(true);
  expect(branchesOf(k.r)).toContain("owner-b");
  // Inside Keel's folder, but on the owner's branch.
  const t = k.store.createSession({ workspace: k.r, title: "forged2", model: "scripted:stand-in" });
  const underKeel = join(root, "own-forged-wts", "owners");
  git(k.r, "worktree", "add", "-q", underKeel, "-b", "owner-c");
  row(underKeel, "owner-c", t.id);
  expect(await leftovers.ownWorktree({ store: k.store, wts: k.wts }, t.id, () => false)).toContain("was kept: it is not in Keel's worktree folder");
  expect(branchesOf(k.r)).toContain("owner-c");
});

test("the worktree Keel made stays when an ignored folder in it holds a repository with a commit of its own", async () => {
  const i = await keelMade("own-nested");
  mkdirSync(join(i.wt.path, "out", "inner"), { recursive: true });
  git(join(i.wt.path, "out", "inner"), "init", "-q", "-b", "main");
  writeFileSync(join(i.wt.path, "out", "inner", "w"), "w\n");
  git(join(i.wt.path, "out", "inner"), "add", "-A");
  git(join(i.wt.path, "out", "inner"), "commit", "-qm", "inner work");
  expect(await i.own()).toBe(`\n\nWorktree ${i.wt.path} (branch ${i.wt.branch}) was kept: an ignored folder holds a repository (out/inner).`);
  expect(existsSync(join(i.wt.path, "out", "inner", "w"))).toBe(true);
});

test("the worktree Keel made stays with an edit git is told not to see (assume-unchanged)", async () => {
  const a = await keelMade("own-assumed");
  git(a.wt.path, "update-index", "--assume-unchanged", ".gitignore");
  writeFileSync(join(a.wt.path, ".gitignore"), "edited\n");
  expect(await a.own()).toContain("0 commits over main, 1 uncommitted file");
  expect(readFileSync(join(a.wt.path, ".gitignore"), "utf8")).toBe("edited\n");
});

test("the worktree Keel made stays when a stash entry was made on its branch", async () => {
  const t = await keelMade("own-stash");
  writeFileSync(join(t.wt.path, ".gitignore"), "stashed\n");
  git(t.wt.path, "stash", "-q");
  expect(await t.own()).toBe(`\n\nWorktree ${t.wt.path} (branch ${t.wt.branch}) was kept: a stash entry was made on its branch (stash@{0}).`);
  expect(existsSync(t.wt.path)).toBe(true);
});

test("the owner's Remove of a listed item works, and refuses one that changed since it was listed; Remove all does each", async () => {
  const r = repo("rp");
  const store = storeAt("state-p");
  const ctx = { store, isRunning: () => false, workspace: r };
  const at = (n: string) => join(root, "rp.worktrees", n);
  git(r, "worktree", "add", "-q", "--detach", at("only"));
  git(at("only"), "commit", "-q", "--allow-empty", "-m", "only here");
  for (const n of ["plain", "moved", "a", "b"]) git(r, "worktree", "add", "-q", "--detach", at(n));
  for (const n of ["merged", "shifted", "m1", "m2"]) git(r, "branch", n);
  const s = await leftovers.survey(ctx);
  const tree = (p: string) => { const w = s.worktrees.find((x) => x.path === p)!; return { repo: w.repo, path: w.path, head: w.head, ignored: w.ignored?.length ?? 0 }; };
  const branch = (n: string) => { const b = s.branches.find((x) => x.name === n)!; return { repo: b.repo, branch: b.name, sha: b.sha }; };
  expect(s.worktrees.find((w) => w.path === at("only"))).toMatchObject({ removable: false, why: "1 commit on no branch" });
  await expect(leftovers.removeTree(ctx, tree(at("only")))).rejects.toThrow("1 commit on no branch");
  expect(existsSync(at("only"))).toBe(true);
  // One click on what was listed.
  await leftovers.removeTree(ctx, tree(at("plain")));
  expect(existsSync(at("plain"))).toBe(false);
  await leftovers.deleteBranch(ctx, branch("merged"));
  expect(branchesOf(r)).not.toContain("merged");
  // Changed after it was listed: refused, and left as it is.
  const seenMoved = tree(at("moved")), seenShifted = branch("shifted");
  git(r, "commit", "-q", "--allow-empty", "-m", "later");
  git(at("moved"), "checkout", "-q", "--detach", "main");
  git(r, "branch", "-f", "shifted", "main");
  await expect(leftovers.removeTree(ctx, seenMoved)).rejects.toThrow("it changed since it was listed");
  expect(existsSync(at("moved"))).toBe(true);
  await expect(leftovers.deleteBranch(ctx, seenShifted)).rejects.toThrow("it changed since it was listed");
  expect(branchesOf(r)).toContain("shifted");
  // The whole list in one act: each item as listed; what changed is said, the rest goes.
  const all = await leftovers.removeAll(ctx, { worktrees: [tree(at("a")), tree(at("b")), seenMoved], branches: [branch("m1"), branch("m2"), seenShifted] });
  expect(all.removed).toEqual([at("a"), at("b")]);
  expect(all.deleted).toEqual(["m1", "m2"]);
  expect(all.refused.map((x) => x.what)).toEqual([at("moved"), "shifted"]);
  expect(existsSync(at("a")) || existsSync(at("b"))).toBe(false);
  expect(branchesOf(r)).toEqual(expect.arrayContaining(["shifted", "main"]));
});

// What carries the run's words, killed whatever the run left.
// The tag is found only as a whole number, as leftovers-run.ts finds it.
const sweep = (tag: string) => {
  const named = new RegExp(`(?<![0-9])${tag}(?![0-9])`);
  for (const n of readdirSync("/proc")) {
    if (!/^\d+$/.test(n)) continue;
    try { if (named.test(readFileSync(`/proc/${n}/cmdline`, "utf8"))) process.kill(Number(n), "SIGKILL"); } catch {}
  }
};
const run = (name: string, others: number, env: Record<string, string | undefined>) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const out = execFileSync(process.execPath, [join(import.meta.dir, "leftovers-run.ts"), dir, String(others)], { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 90_000 });
  const r = JSON.parse(out.trim().split("\n").at(-1)!);
  sweep(r.tag);
  return r as { contain: string; line: string; held: boolean[]; before: string[]; after: string[]; port: number; tag: string };
};
const expectSettled = (r: ReturnType<typeof run>) => {
  expect(r.before.length).toBeGreaterThanOrEqual(4);
  expect(r.after).toEqual([]);
  // Each command as the line cuts it (its length depends on the run's pid).
  expect(r.line).toContain(`stopped ${cmd(`sleep 600.${r.tag} & echo started`)}, ${cmd(`setsid sh -c 'sleep 601.${r.tag} & exit 0' & sleep 0.2; echo done`)}, \`the agent's server\` on port ${r.port}, `);
  expect(r.line).not.toContain("left running");
  expect(r.line).toContain(`its commands name systemd unit keel-left-${r.tag} (systemd-run), which Keel neither tracks nor stops`);
};

test("without a cgroup: commands past the kept count, a child that left the session and a server whose client is the agent's own all stop", () => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.DBUS_SESSION_BUS_ADDRESS;
  delete env.XDG_RUNTIME_DIR;
  const r = run("group", 205, env);
  expect(r.contain).toBe("group");
  expect(r.held).toEqual([true, true, true, true]);
  expectSettled(r);
}, 120_000);

test("a server kept at the agent's end for another process's connection is looked at again, and stopped once the connection is gone", () => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.DBUS_SESSION_BUS_ADDRESS;
  delete env.XDG_RUNTIME_DIR;
  const dir = join(root, "later");
  mkdirSync(dir, { recursive: true });
  const out = execFileSync(process.execPath, [join(import.meta.dir, "leftovers-later-run.ts"), dir], { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 90_000 });
  const r = JSON.parse(out.trim().split("\n").at(-1)!);
  sweep(r.tag);
  expect(r.contain).toBe("group");
  expect(r.line).toContain("left running `the agent's server`");
  expect(r.keptAtEnd).toBe(true);
  // While the connection lasts the pass leaves it; the first pass without a client waits (it may come back);
  // the second stops it and tells the agent's parent once.
  expect(r.withClient).toEqual([]);
  expect(r.aliveWithClient).toBe(true);
  expect(r.first).toEqual([]);
  expect(r.aliveFirst).toBe(true);
  expect(r.later).toHaveLength(1);
  expect(r.aliveAfter).toBe(false);
  expect(r.told).toHaveLength(1);
  expect(r.told[0]).toContain("no process is connected to its port any more");
}, 120_000);

test("in the daemon's own environment (a cgroup scope where the user manager gives one): the same commands all stop", () => {
  const r = run("own", 0, { ...process.env });
  expectSettled(r);
}, 120_000);

// What landing needs, on lines of their own under the work note: the tip, the base's commits it lacks, the
// forecast's conflict with the base, and the named checks that passed on its files as they are.
test("the work note says the tip, the commits behind, the conflict with the base and the checks passed on its tree", async () => {
  const k = await keelMade("land-conflict");
  new Overlaps(k.store, { changed: () => {}, failed: (e) => { throw e; } });
  bindLedger(k.store);
  try {
    writeFileSync(join(k.r, "a.txt"), "base\n");
    git(k.r, "add", "-A");
    git(k.r, "commit", "-qm", "a");
    git(k.wt.path, "merge", "-q", "--ff-only", "main");
    mkdirSync(join(k.wt.path, ".keel"));
    writeFileSync(join(k.wt.path, ".keel", "checks.json"), JSON.stringify({ checks: { typecheck: { run: "tsc -p ." }, unit: { run: "bun test", args: true } } }));
    writeFileSync(join(k.wt.path, "a.txt"), "branch\n");
    git(k.wt.path, "add", "-A");
    git(k.wt.path, "commit", "-qm", "branch side");
    writeFileSync(join(k.r, "a.txt"), "main\n");
    git(k.r, "commit", "-qam", "main side");
    // typecheck passed on the branch's files; unit ran on one file only and failed on an older tree.
    const repo = repoOf(k.wt.path)!;
    const tree = (await treeOf(repo))!.tree!;
    const at = Date.now();
    const run = { dir: ".", repo: repo.scope, head: null, session_id: k.s.id, by: "agent" as const, exit: 0, pass: null, fail: null, started: at, ended: at, log: null, from_run: null, top: repo.top };
    record({ ...run, name: "typecheck", command: "tsc -p .", tree, result: "pass" });
    record({ ...run, name: "unit", command: "bun test src/x", tree, result: "pass" });
    record({ ...run, name: "unit", command: "bun test", tree: "0".repeat(40), result: "fail" });
    const tip = git(k.wt.path, "rev-parse", "HEAD").trim();
    expect(await k.own()).toEndWith(`(git merge ${k.wt.branch}).\nTip: ${tip}\nBehind main: 1 commit\nConflicts with main: yes, 1 file: a.txt\nChecks passed on this tree: typecheck, unit (\`bun test src/x\`)`);
    // The same facts are fields, for the agent's record: no line of text is read for them.
    expect(leftovers.takeLanding(k.s.id)).toMatchObject({
      branch: k.wt.branch, base: "main", tip, behind: 1, ahead: 1, landed: false, dirty: 0,
      conflict: { state: "conflict", files: ["a.txt"] },
      checks: { state: "known", passed: ["typecheck", "unit (`bun test src/x`)"], failed: [], notRun: [] },
    });
    expect(leftovers.takeLanding(k.s.id)).toBeUndefined();
    // A clean branch merges clean; uncommitted files are said to be outside the merge.
    const c = await keelMade("land-clean");
    new Overlaps(c.store, { changed: () => {}, failed: (e) => { throw e; } });
    writeFileSync(join(c.wt.path, "b.txt"), "b\n");
    git(c.wt.path, "add", "-A");
    git(c.wt.path, "commit", "-qm", "b");
    writeFileSync(join(c.wt.path, "c.txt"), "c\n");
    const note = await c.own();
    expect(leftovers.takeLanding(c.s.id)).toMatchObject({ conflict: { state: "clean" }, ahead: 1, landed: false, dirty: 1, checks: { state: "none" } });
    expect(note).toContain("\nBehind main: 0 commits\nConflicts with main: none, it merges clean (its commits only: 1 uncommitted file not in it)\nChecks passed on this tree: none named (the repository names no checks)");
  } finally {
    unbindLedger();
  }
});

test("a job scope that is not this daemon's job is said once for the scope and its record's mark, across restarts", () => {
  const dir = join(root, "foreign-told");
  let store = new Store(dir);
  leftovers.migrate(store);
  const cg = "/sys/fs/cgroup/user.slice/app.slice/keel-job-b1-abcdef.scope";
  expect(leftovers.foreignFirst(store, cg, "b1.100")).toBe(true);
  expect(leftovers.foreignFirst(store, cg, "b1.100")).toBe(false);
  // Another record's mark over the same scope, and another scope with the same mark, are new.
  expect(leftovers.foreignFirst(store, cg, "b1.200")).toBe(true);
  expect(leftovers.foreignFirst(store, `${cg}x`, "b1.100")).toBe(true);
  // The same scope and mark refused for another reason is a new thing to say, once.
  expect(leftovers.foreignFirst(store, cg, "b1.100", "its scope carries another state folder's id")).toBe(true);
  expect(leftovers.foreignFirst(store, cg, "b1.100", "its scope carries another state folder's id")).toBe(false);
  // Every start is a new daemon over the same store: it says nothing again.
  store.db.close();
  store = new Store(dir);
  for (let start = 0; start < 5; start++) expect(leftovers.foreignFirst(store, cg, "b1.100")).toBe(false);
  expect(leftovers.foreignFirst(store, cg, "b1.100", "its scope carries another state folder's id")).toBe(false);
  store.db.close();
});

test("a stop of a command's scope is told once for its key, across a restart, and to the parent when its session is gone", () => {
  const dir = join(root, "told");
  let store = new Store(dir);
  leftovers.migrate(store);
  store.db.run("CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, parent_id TEXT, session_id TEXT, created INTEGER)");
  const parent = store.createSession({ workspace: root, title: "parent", model: "scripted:stand-in" });
  const told: string[] = [];
  const seen = (sid: string, line: string) => void told.push(`${sid}: ${line}`);
  expect(leftovers.tellLeft(store, parent.id, "stopped x", "j1:stop:", seen)).toBe(parent.id);
  expect(leftovers.tellLeft(store, parent.id, "stopped x", "j1:stop:", seen)).toBeUndefined();
  store.db.run("INSERT INTO agents VALUES ('ag', ?, 'gone-session', 1)", [parent.id]);
  expect(leftovers.tellLeft(store, "gone-session", "stopped y", "j2:stop:", seen)).toBe(parent.id);
  store.db.close();
  store = new Store(dir);
  expect(leftovers.tellLeft(store, "gone-session", "stopped y", "j2:stop:", seen)).toBeUndefined();
  expect(leftovers.tellLeft(store, "nobody", "stopped z", "j3:stop:", seen)).toBeUndefined();
  expect(told).toEqual([`${parent.id}: stopped x`, `${parent.id}: Of an agent's session that is gone: stopped y`]);
  store.db.close();
});

// A branch the base took with another patch: a cherry-pick onto a base that moved the context, an edit while
// landing it. Its commits are on no other branch; what decides is whether a commit of the base holds its lines.
const ten = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const put = (dir: string, lines: string[]) => writeFileSync(join(dir, "f.txt"), lines.join("\n") + "\n");
const edit = (dir: string, n: number, text: string, subject: string) => {
  const lines = readFileSync(join(dir, "f.txt"), "utf8").trimEnd().split("\n");
  lines[n - 1] = text;
  put(dir, lines);
  git(dir, "commit", "-qam", subject);
};
// A repository with f.txt on main, and agents' worktrees Keel made from it, one per name.
async function landRepo(name: string, agents: string[]) {
  const r = repo(name);
  put(r, ten);
  git(r, "add", "-A");
  git(r, "commit", "-qm", "ten lines");
  const store = storeAt(`state-${name}`);
  const wts = new Worktrees(store, join(root, `${name}-wts`));
  const made = [];
  for (const a of agents) {
    const s = store.createSession({ workspace: r, title: a, model: "scripted:stand-in" });
    const { wt } = await wts.create(s.id, r, a);
    wts.adopt(s.id, wt);
    made.push({ s, wt, own: () => leftovers.ownWorktree({ store, wts }, s.id, () => false) });
  }
  return { r, store, wts, made };
}

test("the worktree Keel made goes with its branch when the base holds its every line under another patch", async () => {
  const { r, made: [k, later] } = await landRepo("land-tree", ["picked", "edited-after"]);
  edit(k!.wt.path, 6, "six", "Change six");
  edit(r, 4, "four", "Change four on main"); // the context of the branch's hunk: its patch id on main differs
  git(r, "cherry-pick", k!.wt.branch);
  expect(git(r, "cherry", "main", k!.wt.branch).trim()).toStartWith("+ "); // not one patch id
  expect(await k!.own()).toStartWith(`\n\nIts 1 commit over main landed with another patch (the base holds its every line at `);
  expect(existsSync(k!.wt.path)).toBe(false);
  expect(branchesOf(r)).not.toContain(k!.wt.branch);
  // Landed, then the base edited the same line again: the base's tip no longer holds it, the landed commit does.
  edit(later!.wt.path, 8, "eight", "Change eight");
  git(r, "cherry-pick", later!.wt.branch);
  edit(r, 8, "eight, later", "Change eight again on main");
  expect(await later!.own()).toContain("landed with another patch (the base holds its every line at ");
  expect(branchesOf(r)).not.toContain(later!.wt.branch);
});

test("a branch that landed with changes, or not at all, keeps its worktree and branch at its end", async () => {
  const { r, made: [changed, open, reverted] } = await landRepo("land-changed", ["changed", "open", "reverted"]);
  edit(changed!.wt.path, 6, "six from the agent", "Change six");
  edit(r, 6, "six as landed", "Change six"); // the same subject, landed with an edit
  const said = await changed!.own();
  expect(said).toContain("landed as ");
  expect(said).toContain("with changes (its commit is on the base by subject)");
  expect(existsSync(changed!.wt.path)).toBe(true);
  expect(branchesOf(r)).toContain(changed!.wt.branch);
  // Its subject on the base and nothing else: no commit holds its line, nothing says it landed whole.
  edit(open!.wt.path, 2, "two", "Change two");
  expect(await open!.own()).toStartWith(`\n\nIts work is on branch ${open!.wt.branch}`);
  expect(branchesOf(r)).toContain(open!.wt.branch);
  // Taken and reverted with another subject before any landing record: the base's tip gives its line back.
  edit(reverted!.wt.path, 9, "nine", "Change nine");
  edit(r, 9, "nine", "Something else");
  edit(r, 9, "line 9", "Revert something else");
  expect(await reverted!.own()).toStartWith(`\n\nIts work is on branch ${reverted!.wt.branch}`);
  expect(existsSync(reverted!.wt.path)).toBe(true);
});

test("the landed pass removes each listed landed worktree, the branch only of a whole landing, and refuses one that changed", async () => {
  const { r, store, made: [whole, changed, moved, open] } = await landRepo("land-pass", ["whole", "changed", "moved", "open"]);
  edit(whole!.wt.path, 3, "three", "Change three");
  edit(changed!.wt.path, 5, "five from the agent", "Change five");
  edit(moved!.wt.path, 7, "seven", "Change seven");
  edit(open!.wt.path, 10, "ten", "Change ten");
  edit(r, 1, "one", "Change one on main");
  git(r, "cherry-pick", whole!.wt.branch, moved!.wt.branch);
  edit(r, 5, "five as landed", "Change five");
  const ctx = { store, isRunning: () => false, workspace: r };
  const s = await leftovers.survey(ctx);
  const row = (p: string) => s.worktrees.find((w) => w.path === p)!;
  expect(row(whole!.wt.path).landed).toMatchObject({ how: "whole", by: "tree" });
  expect(row(changed!.wt.path).landed).toMatchObject({ how: "changed" });
  expect(row(open!.wt.path).landed).toBeUndefined();
  expect(row(whole!.wt.path).bytes).toBeGreaterThan(0);
  const seen = (p: string) => { const w = row(p); return { repo: w.repo, path: w.path, head: w.head, ignored: w.ignored?.length ?? 0, how: w.landed!.how }; };
  const listed = [seen(whole!.wt.path), seen(changed!.wt.path), seen(moved!.wt.path)];
  git(moved!.wt.path, "commit", "-q", "--allow-empty", "-m", "after it was listed");
  const out = await leftovers.removeLanded(ctx, listed);
  expect(out.removed).toEqual([whole!.wt.path, changed!.wt.path]);
  expect(out.deleted).toEqual([whole!.wt.branch]);
  expect(out.refused.map((x) => x.what)).toEqual([moved!.wt.path]);
  expect(out.refused[0]!.why).toContain("it changed since it was listed");
  expect(existsSync(whole!.wt.path) || existsSync(changed!.wt.path)).toBe(false);
  expect(branchesOf(r)).toEqual(expect.arrayContaining([changed!.wt.branch, moved!.wt.branch, open!.wt.branch]));
  expect(branchesOf(r)).not.toContain(whole!.wt.branch);
  expect(existsSync(open!.wt.path)).toBe(true);
});
