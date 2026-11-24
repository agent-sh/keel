// The guard an agent's commands carry, on a real repository: the main checkout (on main), the agent's worktree
// (keel/x, made from main) and another agent's (keel/y). git is started the way any program the agent runs starts
// it, with the environment the gate gives the command.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realOf } from "../core/paths.ts";
import { checkoutsOf, checkoutsOfAsync } from "./refwatch.ts";
import { ledgerSync, settleMade } from "./made.ts";
import { guardEnv, hooksPathIn, ledgerOf, PAD, refGuardRoot } from "./ref-guard.ts";
import { confine, sandboxStatus, splitScope } from "./sandbox.ts";
import { sharedRefusal } from "./shared-branches.ts";

const hasGit = !!Bun.which("git");
// git runs the hook for a symbolic ref's update from 2.46 on, the release that made such updates part of a ref
// transaction (Documentation/RelNotes/2.46.0); an older git moves one without it.
const gitVersion = hasGit ? (/(\d+)\.(\d+)/.exec(Bun.spawnSync(["git", "--version"]).stdout.toString()) ?? []).slice(1).map(Number) : [];
const symrefs = gitVersion.length === 2 && (gitVersion[0]! > 2 || (gitVersion[0] === 2 && gitVersion[1]! >= 46));

test("core.hooksPath is read from a config file as git reads it", () => {
  expect(hooksPathIn("[core]\n\tbare = false\n\thooksPath = .husky/_\n")).toBe(".husky/_");
  expect(hooksPathIn('[core]\n  HooksPath = "/a b/c" # note\n[core "x"]\n\thooksPath = no\n')).toBe("/a b/c");
  expect(hooksPathIn("[user]\n\thooksPath = no\n")).toBeUndefined();
  expect(hooksPathIn("[core] hooksPath = one\n[core]\nhooksPath = two\n")).toBe("two");
});

test.skipIf(!hasGit)("a git an agent's command starts moves no branch its worktree shares, and runs the repository's own hooks", () => {
  const dir = realOf(mkdtempSync(join(process.env.TMPDIR ?? ".", "guard-")));
  const base = { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const run = (cwd: string, env: Record<string, string>, ...argv: string[]) => {
    const r = Bun.spawnSync(argv, { cwd, env: { ...base, ...env } });
    return { code: r.exitCode, err: r.stderr.toString(), out: r.stdout.toString() };
  };
  const git = (cwd: string, ...a: string[]) => { const r = run(cwd, {}, "git", "-c", "init.defaultBranch=main", ...a); if (r.code !== 0) throw new Error(r.err); return r.out.trim(); };
  try {
    const main = join(dir, "main"), agent = join(dir, "agent"), other = join(dir, "other"), elsewhere = join(dir, "elsewhere");
    git(dir, "init", "-q", main);
    writeFileSync(join(main, "a"), "a\n");
    git(main, "add", "a");
    git(main, "commit", "-qm", "a");
    // The repository's own hook, which finds its helper beside itself ($0), as husky's do.
    mkdirSync(join(main, ".hooks"));
    writeFileSync(join(main, ".hooks", "helper"), "echo ran >> \"$(dirname \"$0\")/../hook.log\"\n");
    writeFileSync(join(main, ".hooks", "post-commit"), "#!/bin/sh\n. \"$(dirname \"$0\")/helper\"\n", { mode: 0o755 });
    git(main, "config", "core.hooksPath", join(main, ".hooks"));
    git(main, "worktree", "add", "-q", "-b", "keel/x", agent);
    git(main, "worktree", "add", "-q", "-b", "keel/y", other);
    git(main, "branch", "base-only");
    git(dir, "init", "-q", elsewhere);
    git(elsewhere, "commit", "-q", "--allow-empty", "-m", "e");
    const s = checkoutsOf(agent, "keel/x", "main")!;
    const env = guardEnv(s, base);
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    const mainAt = git(main, "rev-parse", "main"), yAt = git(main, "rev-parse", "keel/y");
    const sh = (cwd: string, line: string) => run(cwd, env, "sh", "-c", line);
    writeFileSync(join(agent, "b"), "b\n");
    // Its own work: a commit (the repository's hook runs, from its own folder), a branch of its own, a reset.
    expect(sh(agent, "git add b && git commit -qm b && git branch keel/x-2 && git reset -q --hard HEAD").code).toBe(0);
    expect(readFileSync(join(main, "hook.log"), "utf8")).toBe("ran\n");
    // What the gate cannot read: a script, a program, fast-import, a symbolic ref.
    const refused: [string, string][] = [
      [agent, "git update-ref refs/heads/main HEAD"],
      [agent, "python3 -c 'import subprocess,sys; sys.exit(subprocess.run([\"git\",\"update-ref\",\"refs/heads/keel/y\",\"HEAD\"]).returncode)'"],
      [agent, "printf 'reset refs/heads/main\\nfrom %s\\n\\n' $(git rev-parse HEAD) | git fast-import --quiet"],
      [agent, "git update-ref -d refs/heads/keel/y"],
      ...(symrefs ? [[agent, "git symbolic-ref refs/heads/main refs/heads/keel/x"], [agent, "git symbolic-ref HEAD refs/heads/main"], [agent, `git -C ${main} symbolic-ref HEAD refs/heads/keel/x`]] as [string, string][] : []),
    ];
    for (const [cwd, line] of refused) {
      const r = sh(cwd, line);
      expect([line, r.code !== 0, r.err.includes("Refused by Keel") && r.err.includes("keel__landing_queue")]).toEqual([line, true, true]);
    }
    expect([git(main, "rev-parse", "main"), git(main, "rev-parse", "keel/y"), git(main, "symbolic-ref", "HEAD")]).toEqual([mainAt, yAt, "refs/heads/main"]);
    expect(git(agent, "symbolic-ref", "HEAD")).toBe("refs/heads/keel/x");
    // Packing the refs moves none (pack-refs writes each branch's value into packed-refs, then deletes its loose
    // copy): it runs, alone and from gc and maintenance; a move or a delete of a packed branch is still refused.
    for (const line of ["git pack-refs --all", "git gc -q", "git maintenance run --task=pack-refs"]) {
      // (A loose copy again for the next to pack.)
      if (line !== "git pack-refs --all") { mkdirSync(join(main, ".git", "refs", "heads", "keel"), { recursive: true }); writeFileSync(join(main, ".git", "refs", "heads", "main"), `${mainAt}\n`); writeFileSync(join(main, ".git", "refs", "heads", "keel", "y"), `${yAt}\n`); }
      const r = sh(agent, line);
      expect([line, r.code, r.err]).toEqual([line, 0, ""]);
    }
    expect(readFileSync(join(main, ".git", "packed-refs"), "utf8")).toContain(`${mainAt} refs/heads/main`);
    for (const line of ["git update-ref refs/heads/main HEAD", "git update-ref -d refs/heads/keel/y", `git update-ref -d refs/heads/keel/y ${yAt}`, `git update-ref -d refs/heads/main ${mainAt}`]) {
      const r = sh(agent, line);
      expect([line, r.code !== 0, r.err.includes("Refused by Keel")]).toEqual([line, true, true]);
    }
    expect([git(main, "rev-parse", "main"), git(main, "rev-parse", "keel/y")]).toEqual([mainAt, yAt]);
    // In the session's sandbox too, where the shared refs are writable: the hook's folder is shown there.
    if (sandboxStatus().available) {
      const line = "git commit -q --allow-empty -m c && git update-ref refs/heads/main HEAD";
      const p = Bun.spawnSync(splitScope(confine(["sh", "-c", line], { sandbox: "workspace-write", network: false }, agent)).argv, { cwd: agent, env: { ...base, ...env } });
      // (The main checkout is in the temporary folder here, which the sandbox replaces: its hook is not found, and
      // a hook that is not there is skipped, as git skips it.)
      expect([p.exitCode, p.stderr.toString().includes("Refused by Keel"), p.stderr.toString().includes("not found")]).toEqual([128, true, false]);
      expect(git(main, "rev-parse", "main")).toBe(mainAt);
    }
    // Another repository the command works in is not touched.
    expect(sh(agent, `git -C ${elsewhere} update-ref refs/heads/main HEAD && git -C ${elsewhere} config --get core.hooksPath`).code).toBe(1);
    // The base is held even when no checkout has it out.
    const s2 = checkoutsOf(agent, "keel/x", "base-only")!;
    const r = run(agent, guardEnv(s2, base), "git", "branch", "-f", "base-only", "HEAD");
    expect([r.code, r.err.includes("the branch base-only")]).toEqual([128, true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // (Its folders are shown in every sandbox while they are there: none is left for the files after this one.)
    rmSync(refGuardRoot(), { recursive: true, force: true });
  }
});

test.skipIf(!hasGit)("an agent moves, renames or deletes no branch but its own and the ones it made, at the gate and at git's door", async () => {
  const dir = realOf(mkdtempSync(join(process.env.TMPDIR ?? ".", "guard-")));
  const base = { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const run = (cwd: string, env: Record<string, string>, ...argv: string[]) => {
    const r = Bun.spawnSync(argv, { cwd, env: { ...base, ...env } });
    return { code: r.exitCode, err: r.stderr.toString(), out: r.stdout.toString() };
  };
  const git = (cwd: string, ...a: string[]) => { const r = run(cwd, {}, "git", "-c", "init.defaultBranch=main", ...a); if (r.code !== 0) throw new Error(r.err); return r.out.trim(); };
  try {
    const main = join(dir, "main"), agent = join(dir, "agent");
    git(dir, "init", "-q", main);
    writeFileSync(join(main, "a"), "a\n");
    git(main, "add", "a");
    git(main, "commit", "-qm", "a");
    git(main, "worktree", "add", "-q", "-b", "keel/x", agent);
    // Branches nobody has out: the owner's release line, and what an agent that is gone left.
    git(main, "branch", "release/1");
    git(main, "branch", "keel/gone");
    // (Its own commit, so that HEAD is a value none of those branches has.)
    writeFileSync(join(agent, "b"), "b\n");
    git(agent, "add", "b");
    git(agent, "commit", "-qm", "b");
    const s = checkoutsOf(agent, "keel/x", "main", ["keel/kid"])!;
    const env = guardEnv(s, base);
    // (After each command the daemon takes what the hook noted into the ledger, as the gate does.)
    const sh = (line: string) => run(agent, env, "sh", "-c", line);
    const shm = async (line: string) => { const t = Date.now(); const r = sh(line); await settleMade(s.common, s.gitDir, t); return r; };
    expect([...s.foreign!()].sort()).toEqual(["keel/gone", "main", "release/1"]);
    // The gate: the commands a model sends.
    for (const line of ["git branch -D keel/gone", "git update-ref refs/heads/release/1 HEAD", "git branch -m release/1 r", "git checkout -B keel/gone", "git push . HEAD:release/1"]) {
      expect([line, sharedRefusal(line, agent, dir, s)?.includes("which this worktree did not make")]).toEqual([line, true]);
    }
    // Git's door: what the gate cannot read.
    const at = (b: string) => git(main, "rev-parse", b);
    const before = [at("release/1"), at("keel/gone")];
    for (const line of ["git update-ref refs/heads/release/1 HEAD", "git update-ref -d refs/heads/keel/gone", "git branch -f release/1 HEAD", "git branch -D keel/gone", "sh -c 'git branch -M keel/gone keel/x2'"]) {
      const r = sh(line);
      expect([line, r.code !== 0, r.err.includes("did not make")]).toEqual([line, true, true]);
    }
    expect([at("release/1"), at("keel/gone")]).toEqual(before);
    // Its own: a commit, a branch it makes, moved, renamed and deleted again, in separate commands and in one.
    for (const line of ["git commit -q --allow-empty -m c", "git branch keel/x-sub", "git branch -f keel/x-sub HEAD~1", "git branch -m keel/x-sub keel/x-sub2", "git update-ref -d refs/heads/keel/x-sub2", "git branch t && git branch -D t", "git checkout -q -b keel/x-more && git checkout -q keel/x"]) {
      const r = await shm(line);
      expect([line, r.code, r.err]).toEqual([line, 0, ""]);
    }
    // (The daemon noted what it made; the branches it deleted again are not kept, nor is the pad.)
    expect(ledgerSync(s.gitDir).map((e) => e.ref)).toEqual(["refs/heads/keel/x-more"]);
    expect(existsSync(join(s.gitDir, PAD))).toBe(false);
    expect((await shm("git branch keel/x-more2")).code).toBe(0);
    expect(ledgerSync(s.gitDir).map((e) => e.ref)).toEqual(["refs/heads/keel/x-more", "refs/heads/keel/x-more2"]);
    expect((await shm("git branch -m keel/x-more2 keel/x-more3")).code).toBe(0);
    expect(ledgerSync(s.gitDir).map((e) => e.ref).sort()).toEqual(["refs/heads/keel/x-more", "refs/heads/keel/x-more3"]);
    expect([...(await checkoutsOfAsync(agent, "keel/x", "main", ["keel/kid"], true))!.foreign!()].sort()).toEqual(["keel/gone", "main", "release/1"]);
    expect(sh("git branch -D keel/x-more3").code).toBe(0);
    expect((await shm("git branch -D keel/x-more")).code).toBe(0);
    expect(ledgerSync(s.gitDir)).toEqual([]);
    // The branch an agent under it made is its own to remove, by what the harness says of it.
    git(main, "branch", "keel/kid");
    const s2 = checkoutsOf(agent, "keel/x", "main", ["keel/kid"])!;
    expect(sharedRefusal("git branch -D keel/kid", agent, dir, s2)).toBeNull();
    expect(run(agent, guardEnv(s2, base), "git", "branch", "-D", "keel/kid").code).toBe(0);
    expect(run(agent, guardEnv(s2, base), "git", "branch", "-D", "release/1").code).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(refGuardRoot(), { recursive: true, force: true });
  }
});

// A scratch repository with an agent's worktree, its guard and the helpers the next tests share.
function scratch() {
  const dir = realOf(mkdtempSync(join(process.env.TMPDIR ?? ".", "guard-")));
  const base = { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const run = (cwd: string, env: Record<string, string>, ...argv: string[]) => {
    const r = Bun.spawnSync(argv, { cwd, env: { ...base, ...env } });
    return { code: r.exitCode, err: r.stderr.toString(), out: r.stdout.toString() };
  };
  const git = (cwd: string, ...a: string[]) => { const r = run(cwd, {}, "git", "-c", "init.defaultBranch=main", ...a); if (r.code !== 0) throw new Error(r.err); return r.out.trim(); };
  const main = join(dir, "main"), agent = join(dir, "agent");
  git(dir, "init", "-q", main);
  writeFileSync(join(main, "a"), "a\n");
  git(main, "add", "a");
  git(main, "commit", "-qm", "a");
  git(main, "worktree", "add", "-q", "-b", "keel/x", agent);
  const s = checkoutsOf(agent, "keel/x", "main", [])!;
  const env = guardEnv(s, base);
  const sh = (line: string) => run(agent, env, "sh", "-c", line);
  // (After each command the daemon takes what the hook noted into the ledger, as the gate does.)
  const shm = async (line: string) => { const t = Date.now(); const r = sh(line); await settleMade(s.common, s.gitDir, t); return r; };
  const owner = (...a: string[]) => git(main, ...a);
  const done = () => { rmSync(dir, { recursive: true, force: true }); rmSync(refGuardRoot(), { recursive: true, force: true }); };
  return { dir, main, agent, s, sh, shm, owner, run, base, done };
}

test.skipIf(!hasGit)("a branch an agent made and deleted does not make the next one of that name its own", async () => {
  const t = scratch();
  try {
    // Made and deleted in one command, and in two: the owner then makes the name again.
    expect((await t.shm("git branch wip && git branch -D wip")).code).toBe(0);
    expect((await t.shm("git branch wip2")).code).toBe(0);
    expect(ledgerSync(t.s.gitDir).map((e) => e.ref)).toEqual(["refs/heads/wip2"]);
    expect((await t.shm("git branch -D wip2")).code).toBe(0);
    expect(ledgerSync(t.s.gitDir)).toEqual([]);
    // (Not within the second the agent's branch began in: a branch begins with the line of its log, with the time.)
    await Bun.sleep(1100);
    t.owner("branch", "wip");
    t.owner("branch", "wip2");
    const now = (await checkoutsOfAsync(t.agent, "keel/x", "main", [], true))!;
    expect([...now.foreign!()].filter((b) => b.startsWith("wip")).sort()).toEqual(["wip", "wip2"]);
    for (const b of ["wip", "wip2"]) {
      expect([b, sharedRefusal(`git branch -D ${b}`, t.agent, t.dir, now)?.includes("which this worktree did not make")]).toEqual([b, true]);
      const r = t.sh(`git branch -D ${b}`);
      expect([b, r.code !== 0, r.err.includes("did not make")]).toEqual([b, true, true]);
    }
    expect(t.owner("rev-parse", "--verify", "wip")).toMatch(/^[0-9a-f]{40}$/);
    // A branch it made and still has stays its own, through a rename in another command.
    expect((await t.shm("git branch mine")).code).toBe(0);
    expect((await t.shm("git branch -m mine mine2")).code).toBe(0);
    expect(ledgerSync(t.s.gitDir).map((e) => e.ref)).toEqual(["refs/heads/mine2"]);
    expect(t.sh("git branch -D mine2").code).toBe(0);
  } finally { t.done(); }
});

test.skipIf(!hasGit)("a branch the owner made again with logs off is not the one the agent made, and a rename still follows its log", async () => {
  const t = scratch();
  try {
    expect((await t.shm("git branch wip")).code).toBe(0);
    expect(ledgerSync(t.s.gitDir).map((e) => e.ref)).toEqual(["refs/heads/wip"]);
    // The owner deletes it and makes the name again with reflogs off: no log, and the name alone does not make it the agent's.
    t.owner("branch", "-D", "wip");
    t.owner("-c", "core.logAllRefUpdates=false", "branch", "wip");
    expect(existsSync(join(t.s.common, "logs/refs/heads/wip"))).toBe(false);
    const r = t.sh("git branch -D wip");
    expect([r.code !== 0, r.err.includes("did not make")]).toEqual([true, true]);
    expect(t.owner("rev-parse", "--verify", "wip")).toMatch(/^[0-9a-f]{40}$/);
    // A rename of a branch it made, in one command, goes through.
    expect((await t.shm("git branch mine && git branch -m mine mine2")).code).toBe(0);
    expect(t.sh("git branch -D mine2").code).toBe(0);
  } finally { t.done(); }
});

test.skipIf(!hasGit)("a pad line for a branch made before the command's start is not taken", async () => {
  const t = scratch();
  try {
    t.owner("branch", "sibling");
    const line = readFileSync(join(t.s.common, "logs/refs/heads/sibling"), "utf8").split("\n")[0]!;
    const sec = Number(/> (\d+) [+-]\d{4}\t/.exec(line)![1]);
    // A command that started in the second after the branch was made: the branch is not its.
    writeFileSync(join(t.s.gitDir, PAD), `refs/heads/sibling ${line}\n`);
    await settleMade(t.s.common, t.s.gitDir, (sec + 1) * 1000);
    expect(ledgerSync(t.s.gitDir)).toEqual([]);
    // One that started in the same second could have made it: the line has no finer time.
    writeFileSync(join(t.s.gitDir, PAD), `refs/heads/sibling ${line}\n`);
    await settleMade(t.s.common, t.s.gitDir, sec * 1000);
    expect(ledgerSync(t.s.gitDir).map((e) => e.ref)).toEqual(["refs/heads/sibling"]);
  } finally { t.done(); }
});

// (An older git moves a symbolic ref without the hook: the gate refuses the typed form there, see ref-guard.ts.)
test.skipIf(!hasGit || !symrefs)("a script puts HEAD on no branch the worktree did not make", () => {
  const t = scratch();
  try {
    t.owner("branch", "release/1");
    const was = t.owner("rev-parse", "release/1");
    const r = t.sh("git symbolic-ref HEAD refs/heads/release/1");
    expect([r.code !== 0, r.err.includes("which this worktree did not make")]).toEqual([true, true]);
    expect(t.run(t.agent, {}, "git", "symbolic-ref", "HEAD").out.trim()).toBe("refs/heads/keel/x");
    expect(t.sh("git commit -q --allow-empty -m c").code).toBe(0);
    expect(t.owner("rev-parse", "release/1")).toBe(was);
    // Its own and one it makes are not refused.
    expect(t.sh("git checkout -q -b keel/new && git checkout -q keel/x").code).toBe(0);
  } finally { t.done(); }
});

test.skipIf(!hasGit)("no write to the old list of made branches, or to the pad, makes a branch the worktree's own", async () => {
  const t = scratch();
  try {
    t.owner("branch", "release/1");
    const now = (await checkoutsOfAsync(t.agent, "keel/x", "main", [], true))!;
    // The gate refuses the writes it can read, git's --output among them; a script writes the files at once.
    for (const f of [join(t.s.gitDir, PAD), join(t.s.gitDir, `${PAD}.123`)]) {
      expect(sharedRefusal(`git log --output=${f}`, t.agent, t.dir, now)).not.toBeNull();
    }
    expect(sharedRefusal(`git log --output=${join(t.agent, "log.txt")}`, t.agent, t.dir, now)).toBeNull();
    // A name with an expansion is not read, as for a branch name.
    for (const l of ["git log -1 --output=$PADX", "git log -1 --output ${PADX}", "git show --output=.git/keel-made-p* HEAD"]) expect([l, sharedRefusal(l, t.agent, t.dir, now)?.includes("expansion")]).toEqual([l, true]);
    const line = t.owner("log", "-g", "--format=%H", "release/1").length ? readFileSync(join(t.s.common, "logs/refs/heads/release/1"), "utf8").split("\n")[0]! : "";
    t.sh(`printf 'refs/heads/release/1 %s\\n' ${JSON.stringify(line)} > ${join(t.s.gitDir, "keel-made-branches")}`);
    expect(t.sh("git branch -D release/1").code).not.toBe(0);
    // The ledger is Keel's folder, not the worktree's: nothing in the git directory is read as one after the command.
    expect(ledgerOf(t.s.gitDir).startsWith(refGuardRoot())).toBe(true);
    t.sh(`printf 'refs/heads/release/1 %s\\n' ${JSON.stringify(line)} > ${join(t.s.gitDir, PAD)}`);
    await settleMade(t.s.common, t.s.gitDir, Date.now());
    expect(ledgerSync(t.s.gitDir)).toEqual([]);
    expect(t.sh("git branch -D release/1").code).not.toBe(0);
  } finally { t.done(); }
});

test.skipIf(!hasGit)("the checkouts read off the loop are the ones read on it", async () => {
  const t = scratch();
  try {
    t.owner("branch", "release/1");
    t.owner("remote", "add", "o", "https://example.test/r.git");
    const a = checkoutsOf(t.agent, "keel/x", "main", ["keel/kid"])!;
    const b = (await checkoutsOfAsync(t.agent, "keel/x", "main", ["keel/kid"], true))!;
    const plain = (x: typeof a) => JSON.stringify({ ...x, out: [...x.out], remotes: x.remotes && [...x.remotes], foreign: [...x.foreign!()].sort(), real: undefined });
    expect(plain(b)).toBe(plain(a));
  } finally { t.done(); }
});
