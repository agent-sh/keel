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
  writeFileSync(join(k.wt.path, "out", "build.log"), "x\n"); // ignored output goes with it, as it always has
  expect(await k.own()).toBe("\n\n(The agent changed no files; its worktree was removed.)");
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

test("the worktree Keel made is kept and listed with uncommitted work, an untracked file git hides, or a commit on no other branch", async () => {
  // Uncommitted work.
  const d = await keelMade("own-dirty");
  writeFileSync(join(d.wt.path, ".gitignore"), "changed\n");
  expect(await d.own()).toBe(`\n\nIts work is on branch ${d.wt.branch} in the worktree ${d.wt.path}: 0 commits over main, 1 uncommitted file. Review and merge it from there (git merge ${d.wt.branch}).`);
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
const sweep = (tag: string) => {
  for (const n of readdirSync("/proc")) {
    if (!/^\d+$/.test(n)) continue;
    try { if (readFileSync(`/proc/${n}/cmdline`, "utf8").includes(tag)) process.kill(Number(n), "SIGKILL"); } catch {}
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

test("in the daemon's own environment (a cgroup scope where the user manager gives one): the same commands all stop", () => {
  const r = run("own", 0, { ...process.env });
  expectSettled(r);
}, 120_000);
