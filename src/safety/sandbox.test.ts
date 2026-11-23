import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confine, gitShut, linkedGitBinds, sandboxStatus, sandboxTopsDir } from "./sandbox.ts";

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Error(r.stderr.toString());
};
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "keel-sandbox-")));
// A repository with a main checkout and two linked worktrees beside it.
function repo(root: string, init: string[] = []) {
  const main = join(root, "repo"), wt = join(root, "wt"), other = join(root, "other");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main", ...init);
  git(main, "commit", "-q", "--allow-empty", "-m", "first");
  git(main, "worktree", "add", "-q", "-b", "a", wt);
  git(main, "worktree", "add", "-q", "-b", "b", other);
  return { main, wt, other, common: join(main, ".git") };
}

// The pointer to a linked worktree's git directory is a file a command let
// out of the sandbox can rewrite. It opens nothing unless git's own layout
// confirms it.
test("a linked worktree's git directories are writable only when the layout confirms the pointer", () => {
  const root = scratch();
  try {
    const { main, wt, common } = repo(root);
    const prize = join(root, "prize");

    // The real worktree: the pointer read-only; in place of the common
    // directory's top a folder of Keel's own that holds a link for each plain
    // file there (read where it is, through one read-only bind of the top)
    // and the place of each folder (the shared stores bound writable, the rest
    // read-only); its own directory writable but for the files that say where
    // it is; and the top closed last.
    const b = linkedGitBinds(wt);
    const has = (...run: string[]) => b.some((_, i) => run.every((a, j) => b[i + j] === a));
    expect(b.slice(0, 4)).toEqual(["--ro-bind", join(wt, ".git"), join(wt, ".git"), "--bind"]);
    const top = b[4]!;
    expect([top.startsWith(sandboxTopsDir()), b[5]]).toEqual([true, common]);
    for (const store of ["objects", "refs", "logs/refs"]) expect(has("--bind", join(common, store), join(common, store))).toBe(true);
    // (The logs folder itself is the real one, read-only: the main checkout's own HEAD log is a file git's walks read.)
    for (const closed of ["hooks", "info", "worktrees", "logs"]) expect(has("--ro-bind", join(common, closed), join(common, closed))).toBe(true);
    expect(b.indexOf(join(common, "logs"))).toBeLessThan(b.indexOf(join(common, "logs/refs")));
    // A file git keeps at the top by name is linked also when it is not there yet.
    expect([existsSync(join(common, "MERGE_HEAD")), readlinkSync(join(top, "MERGE_HEAD")), readlinkSync(join(top, "shallow"))]).toEqual([false, "keel-sandbox/top/MERGE_HEAD", "keel-sandbox/top/shallow"]);
    expect(has("--bind", join(common, "worktrees/wt"), join(common, "worktrees/wt"))).toBe(true);
    for (const f of ["config.worktree", "gitdir", "commondir"]) expect(has("--ro-bind", join(common, "worktrees/wt", f), join(common, "worktrees/wt", f))).toBe(true);
    // No argument names a plain file of the top: each is a link in the folder.
    for (const f of ["config", "HEAD", "description", "index", "packed-refs"]) expect(b.includes(join(common, f))).toBe(false);
    expect(["config", "HEAD", "description", "packed-refs"].map((f) => readlinkSync(join(top, f)))).toEqual(["keel-sandbox/top/config", "keel-sandbox/top/HEAD", "keel-sandbox/top/description", "keel-sandbox/packed-refs.1"]);
    expect(has("--ro-bind", common, join(common, "keel-sandbox/top"))).toBe(true);
    expect(b.slice(-2)).toEqual(["--remount-ro", common]);
    // Three thousand files at the top cost no argument (bubblewrap takes 9,000).
    for (let i = 0; i < 3000; i++) writeFileSync(join(common, `sharedindex.${i}`), "");
    expect(linkedGitBinds(wt)).toHaveLength(b.length);
    expect(readlinkSync(join(top, "sharedindex.2999"))).toBe("keel-sandbox/top/sharedindex.2999");
    for (let i = 0; i < 3000; i++) rmSync(join(common, `sharedindex.${i}`));
    linkedGitBinds(wt);
    expect(existsSync(join(top, "sharedindex.0"))).toBe(false);
    expect(gitShut(wt)).toBeUndefined();
    // Three thousand folders there are past what a sandbox binds: nothing of git is opened, and the session is told why.
    for (let i = 0; i < 3000; i++) mkdirSync(join(common, `odd-${i}`));
    expect(linkedGitBinds(wt)).toEqual([]);
    expect(gitShut(wt)).toContain("the sandbox could not open this worktree's git directories");
    for (let i = 0; i < 3000; i++) rmSync(join(common, `odd-${i}`), { recursive: true });
    // A session in a folder inside a repository: the git directory is above it.
    mkdirSync(join(main, "pkg/deep"), { recursive: true });
    expect(gitShut(join(main, "pkg/deep"))).toContain(`this session's folder is inside the repository at ${main}`);
    // The main checkout: its git directory is read-only as a whole, and the session is told so.
    expect(gitShut(main)).toContain("this session's folder is the repository's main checkout, and its git directory is read-only in the sandbox as a whole");
    expect(gitShut(root)).toBeUndefined();
    // Only the worktree's own config.worktree is made (empty): nothing is added to the shared directory.
    expect(readFileSync(join(common, "worktrees/wt/config.worktree"), "utf8")).toBe("");
    for (const absent of ["config.worktree", "modules", "keel-sandbox"]) expect(existsSync(join(common, absent))).toBe(false);
    // The main checkout keeps git's files inside its folder: nothing here.
    expect(linkedGitBinds(main)).toEqual([]);

    // A pointer at another worktree's directory: it does not point back here.
    writeFileSync(join(wt, ".git"), `gitdir: ${join(common, "worktrees/other")}\n`);
    expect(linkedGitBinds(wt)).toEqual([]);
    // A pointer at a folder outside that is no repository of this worktree.
    mkdirSync(prize);
    writeFileSync(join(wt, ".git"), `gitdir: ${prize}\n`);
    expect(linkedGitBinds(wt)).toEqual([]);
    // A forged directory inside the workspace that names the prize as its
    // common directory: the common directory is taken from the layout, never
    // from that file.
    const fake = join(wt, "fake/worktrees/x");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "gitdir"), `${join(wt, ".git")}\n`);
    writeFileSync(join(fake, "commondir"), `${prize}\n`);
    writeFileSync(join(wt, ".git"), `gitdir: ${fake}\n`);
    expect(linkedGitBinds(wt)).toEqual([]);
    // The real directory with its commondir rewritten: refused as well.
    writeFileSync(join(wt, ".git"), `gitdir: ${join(common, "worktrees/wt")}\n`);
    writeFileSync(join(common, "worktrees/wt/commondir"), `${prize}\n`);
    expect(linkedGitBinds(wt)).toEqual([]);
    // A hooks folder that is a link could lead into the writable folder:
    // nothing is opened. The same for a store that is no plain folder.
    writeFileSync(join(common, "worktrees/wt/commondir"), "../..\n");
    expect(linkedGitBinds(wt)).not.toEqual([]);
    rmSync(join(common, "hooks"), { recursive: true });
    symlinkSync(prize, join(common, "hooks"));
    expect(linkedGitBinds(wt)).toEqual([]);
    rmSync(join(common, "hooks"));
    expect(linkedGitBinds(wt)).not.toEqual([]);
    mkdirSync(join(common, "keel-sandbox"));
    expect(linkedGitBinds(wt)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The profile also opens the temporary folder, and these scratch repositories
// live under it: for the run it is a folder of its own, so only what the
// profile opens for the workspace is writable.
const run = (ws: string, script: string) => {
  const tmp = process.env.TMPDIR;
  process.env.TMPDIR = mkdtempSync(join(tmpdir(), "keel-sandbox-tmp-"));
  try {
    const r = Bun.spawnSync(confine(["bash", "-c", script], { sandbox: "workspace-write", network: false }, ws), { cwd: ws, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  } finally {
    rmSync(process.env.TMPDIR!, { recursive: true, force: true });
    process.env.TMPDIR = tmp;
  }
};
const commit = "git -c user.name=k -c user.email=k@k commit -q --allow-empty -m more && echo committed";

// What a repository's files run outside the sandbox later is read-only for a
// confined command, in a linked worktree and in a normal clone: the hooks
// (also when the folder was missing), the config, and every config.worktree
// (also before the repository turns per-worktree config on). A normal clone's
// git directory is read-only as a whole.
test.skipIf(!sandboxStatus().available)("a confined command cannot plant code for git to run outside the sandbox", () => {
  const root = scratch();
  try {
    // A repository made without a hooks folder.
    const { main, wt, common } = repo(root, ["--template="]);
    expect(existsSync(join(common, "hooks"))).toBe(false);
    const plant = (dir: string) => [
      `mkdir -p ${dir}/hooks && echo '#!/bin/sh' > ${dir}/hooks/post-checkout`,
      `echo '[core]' >> ${dir}/config`,
      `echo '[core]' > ${dir}/config.worktree`,
      `echo '[core]' > ${dir}/worktrees/other/config.worktree`,
      `echo ref: refs/heads/x > ${dir}/worktrees/other/HEAD`,
      `mkdir -p ${dir}/modules/sub/hooks`,
    ];
    for (const from of [wt, main]) {
      const r = run(from, [commit, ...plant(common).map((c, i) => `(${c}) 2>/dev/null || echo refused-${i}`)].join("; "));
      // A worktree commits; the main checkout's git directory is read-only as a whole (its config is in it).
      expect([from, r.out.includes("committed")]).toEqual([from, from === wt]);
      for (let i = 0; i < 6; i++) expect(r.out).toContain(`refused-${i}`);
      // Nothing was made at the top, a hooks folder included.
      for (const absent of ["hooks", "config.worktree", "modules"]) expect(existsSync(join(common, absent))).toBe(false);
    }
    expect(existsSync(join(common, "worktrees/other/config.worktree"))).toBe(false); // that whole directory is read-only
    // The worktree's own pointer, its own config.worktree and where it says it is.
    const own = run(wt, `(echo x > .git) 2>/dev/null || echo refused-pointer; for f in config.worktree gitdir commondir; do (echo x > ${common}/worktrees/wt/$f) 2>/dev/null || echo refused-$f; done`);
    for (const f of ["pointer", "config.worktree", "gitdir", "commondir"]) expect(own.out).toContain(`refused-${f}`);
    // Nor can the pointer be moved away, removed, or swapped for a repository
    // the session made (the daemon would then push from, and read, that one).
    const pointer = readFileSync(join(wt, ".git"), "utf8");
    const swapped = run(wt, "git init -q fake; (mv .git gone) 2>/dev/null || echo refused-move; (rm -f .git) 2>/dev/null || echo refused-remove; (mv -T fake/.git .git) 2>/dev/null || echo refused-swap; (ln -sf fake/.git .git) 2>/dev/null || echo refused-link; rm -rf fake gone");
    expect(swapped.out).toBe("refused-move\nrefused-remove\nrefused-swap\nrefused-link\n");
    expect(readFileSync(join(wt, ".git"), "utf8")).toBe(pointer);

    // A normal clone's git directory cannot be swapped for a copy, replaced by
    // a repository the session made, or removed as a folder; nothing in it moves.
    const config = readFileSync(join(main, ".git/config"), "utf8");
    const swap = run(main, "mv .git old 2>&1; mv .git/worktrees .git/w2 2>&1; ls -d .git/worktrees");
    expect(swap.out).toContain(".git/worktrees");
    expect(swap.out.match(/Device or resource busy|Read-only file system/g)).toEqual(["Device or resource busy", "Read-only file system"]);
    expect(existsSync(join(main, "old"))).toBe(false);
    const replaced = run(main, "git init -q fake; (mv -T fake/.git .git) 2>/dev/null || echo refused-swap; (mv .git/config .git/config2) 2>/dev/null || echo refused-config; (rmdir .git) 2>/dev/null || echo refused-rmdir; rm -rf fake copy");
    expect(replaced.out).toBe("refused-swap\nrefused-config\nrefused-rmdir\n");
    expect(readFileSync(join(main, ".git/config"), "utf8")).toBe(config);
    // No worktree is made from the main checkout (its directory would be under
    // the read-only one), and the one beside the folder is not removed.
    expect(run(main, "git worktree add -q -b inner inner >/dev/null 2>&1 || echo refused").out).toBe("refused\n");
    expect(existsSync(join(common, "worktrees/inner"))).toBe(false);
    expect(run(main, `git worktree remove --force ${join(root, "other")} >/dev/null 2>&1 || echo refused`).out).toBe("refused\n");
    expect(existsSync(join(common, "worktrees/other/HEAD"))).toBe(true);

    // A `.git` that is a link to another repository's: the commands still
    // run, and what they write there fails as any write outside the folder.
    const linked = join(root, "linked");
    mkdirSync(linked);
    symlinkSync(common, join(linked, ".git"));
    const l = run(linked, "echo ran; (echo x >> .git/config) 2>/dev/null || echo refused-config; (: > .git/refs/heads/zz) 2>/dev/null || echo refused-ref");
    expect(l.out).toBe("ran\nrefused-config\nrefused-ref\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// git rewrites a config by writing a new file and renaming it into place. A
// command that was already running when git outside did that (a terminal, a
// dev server) still cannot write the config or add a hook: in a main checkout,
// in a linked worktree, and in a submodule's git directory.
test.skipIf(!sandboxStatus().available)("the config and the hooks stay read-only for a running command after git outside rewrites the config", async () => {
  const root = scratch();
  const tmp = process.env.TMPDIR;
  process.env.TMPDIR = mkdtempSync(join(tmpdir(), "keel-sandbox-tmp-"));
  try {
    const { main, wt, common } = repo(root);
    writeFileSync(join(main, "f"), "one\n");
    git(main, "add", "f");
    git(main, "commit", "-q", "-m", "a file");
    writeFileSync(join(main, "f"), "two\n");
    const sub = join(root, "sub");
    mkdirSync(sub);
    git(sub, "init", "-q", "-b", "main");
    git(sub, "commit", "-q", "--allow-empty", "-m", "first");
    git(main, "submodule", "add", "-q", sub, "libs/sub");
    const subDir = join(common, "modules/libs/sub");
    const inode = (f: string) => Bun.spawnSync(["stat", "-c", "%i", f], { stdout: "pipe" }).stdout.toString().trim();
    // The command starts, git outside sets a value (each config is a new file then), and the command goes on.
    const during = async (ws: string, inside: string) => {
      rmSync(join(ws, "go"), { force: true });
      rmSync(join(ws, "ready"), { force: true });
      const p = Bun.spawn(confine(["bash", "-c", `: > ready; while [ ! -e go ]; do sleep 0.05; done; ${inside}`], { sandbox: "workspace-write", network: false }, ws), { cwd: ws, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      for (let i = 0; i < 200 && !existsSync(join(ws, "ready")); i++) await Bun.sleep(25);
      const was = [inode(join(common, "config")), inode(join(subDir, "config"))];
      git(main, "config", "keel.test", "outside");
      git(join(main, "libs/sub"), "config", "keel.test", "outside");
      expect([inode(join(common, "config")), inode(join(subDir, "config"))].map((n, i) => n !== was[i])).toEqual([true, true]);
      writeFileSync(join(ws, "go"), "");
      const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      return out;
    };
    const plant = (dir: string) => `(echo '[core]' >> ${dir}/config) 2>/dev/null || echo refused-config; (echo '#!/bin/sh' > ${dir}/hooks/post-checkout) 2>/dev/null || echo refused-hook`;
    // The main checkout: closed, its submodule's too, and git still reads it.
    const inMain = await during(main, `${plant(common)}; ${plant(subDir)}; git status --short -uno; git diff --stat | tail -1; git log --oneline | wc -l; git config keel.test`);
    expect(inMain).toBe("refused-config\nrefused-hook\nrefused-config\nrefused-hook\nA  .gitmodules\n M f\nA  libs/sub\n 1 file changed, 1 insertion(+), 1 deletion(-)\n2\noutside\n");
    // A linked worktree: the repository's config and hooks are closed, and it still commits.
    const inWt = await during(wt, `${plant(common)}; ${commit}`);
    expect(inWt).toBe("refused-config\nrefused-hook\ncommitted\n");
    for (const dir of [common, subDir]) {
      expect(readFileSync(join(dir, "config"), "utf8")).not.toContain("[core]\n[core]");
      expect(readFileSync(join(dir, "config"), "utf8").trimEnd().endsWith("test = outside")).toBe(true);
      expect(existsSync(join(dir, "hooks/post-checkout"))).toBe(false);
    }
  } finally {
    rmSync(process.env.TMPDIR!, { recursive: true, force: true });
    process.env.TMPDIR = tmp;
    rmSync(root, { recursive: true, force: true });
  }
});

// The top of the common directory is the main checkout's git directory: the
// state of its merge or rebase lives there, and a planted one runs or commits
// for the owner later. A linked worktree keeps its own under its own
// directory, so nothing it does needs the top.
test.skipIf(!sandboxStatus().available)("a linked worktree cannot plant an operation in progress for the main checkout, and its own still work", async () => {
  const root = scratch();
  try {
    const { main, wt, common } = repo(root);
    const own = join(common, "worktrees/wt");
    writeFileSync(join(main, "f"), "one\n");
    git(main, "add", "f");
    git(main, "commit", "-q", "-m", "a file");
    git(main, "branch", "packed");
    git(main, "pack-refs", "--all");
    git(wt, "reset", "-q", "--hard", "main");
    const marker = join(root, "MARK");
    // The reproduction: a rebase state whose todo holds an exec line.
    const state = `${common}/rebase-merge`;
    const planted = run(wt, [
      `mkdir ${state} && cd ${state} && echo refs/heads/main > head-name && git -C ${wt} rev-parse main > onto && cp onto orig-head && : > interactive && : > done && echo 1 > end && echo 0 > msgnum && echo 'exec touch ${marker}' > git-rebase-todo`,
      `echo made-$?`,
    ].join("; "));
    expect(planted.out).toContain("Read-only file system");
    expect(planted.out).not.toContain("made-0");
    expect(existsSync(state)).toBe(false);
    const cont = Bun.spawnSync(["git", "-c", "core.editor=true", "rebase", "--continue"], { cwd: main, stdout: "pipe", stderr: "pipe" });
    expect(cont.stderr.toString().toLowerCase()).toContain("no rebase in progress");
    expect(existsSync(marker)).toBe(false);
    // Every name of an operation in progress, and what else is the main checkout's.
    const names = ["rebase-merge", "rebase-apply", "sequencer", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "MERGE_AUTOSTASH", "CHERRY_PICK_HEAD", "REVERT_HEAD", "AUTO_MERGE", "BISECT_LOG", "BISECT_START", "BISECT_TERMS", "BISECT_EXPECTED_REV", "BISECT_NAMES", "BISECT_RUN", "ORIG_HEAD", "FETCH_HEAD", "COMMIT_EDITMSG", "SQUASH_MSG", "REBASE_HEAD"];
    const made = run(wt, names.map((n) => `(mkdir ${common}/${n} || : > ${common}/${n}) 2>/dev/null && echo made-${n}`).join("; ") + `; (echo x >> ${common}/HEAD) 2>/dev/null && echo made-HEAD; (echo x >> ${common}/index) 2>/dev/null && echo made-index; echo done`);
    expect(made.out).toBe("done\n");
    for (const n of names) if (n !== "COMMIT_EDITMSG") expect(existsSync(join(common, n))).toBe(false);

    // Its own: a conflicting merge and a conflicting cherry-pick keep their
    // state in its own directory and end clean; a rebase runs its exec line.
    const c = "git -c user.name=k -c user.email=k@k -c core.editor=true";
    const work = run(wt, [
      `echo wt > f && ${c} commit -qam mine && ${c} checkout -q -b side main && echo side > f && ${c} commit -qam theirs && ${c} checkout -q a`,
      `${c} merge side >/dev/null 2>&1; test -e ${own}/MERGE_HEAD && echo merge-in-own`,
      `echo both > f && ${c} add f && ${c} commit -qm merged && test ! -e ${own}/MERGE_HEAD && echo merge-done`,
      `${c} checkout -q -b pick main && echo pick > f && ${c} commit -qam pick && ${c} checkout -q a`,
      `${c} cherry-pick pick >/dev/null 2>&1; test -e ${own}/CHERRY_PICK_HEAD && echo pick-in-own`,
      `echo all > f && ${c} add f && ${c} cherry-pick --continue >/dev/null && test ! -e ${own}/CHERRY_PICK_HEAD && echo pick-done`,
      `GIT_SEQUENCE_EDITOR="sed -i '1a exec touch ${wt}/ran'" ${c} rebase -q -i HEAD~1 && test -e ran && test ! -e ${own}/rebase-merge && echo rebase-done`,
      `echo more >> f && ${c} stash -q && ${c} stash pop -q && ${c} tag t1 && ${c} tag -d t1 >/dev/null && ${c} branch -D pick side >/dev/null && echo refs-done`,
    ].join("; "));
    // (Besides git's own words: a deleted branch's section cannot be taken out of the read-only config.)
    expect(work.out.split("\n").filter((l) => /-(in-own|done)$/.test(l))).toEqual(["merge-in-own", "merge-done", "pick-in-own", "pick-done", "rebase-done", "refs-done"]);
    // What the read-only top closes fails before anything changed: a packed
    // branch stays, and the refs are not packed (which would drop the loose ones).
    const shut = run(wt, `git branch -D packed; echo branch-$?; git pack-refs --all; echo pack-$?; git gc -q; echo gc-$?`);
    expect(shut.out).toContain("branch-1");
    expect(shut.out).toContain("pack-128");
    expect(shut.out).toContain("gc-128");
    git(main, "rev-parse", "--verify", "-q", "refs/heads/packed");
    git(main, "rev-parse", "--verify", "-q", "refs/heads/a");
    git(main, "fsck", "--no-dangling");

    // The refs another checkout packs while a command runs are read as they
    // are now: the worktree's branch is still there, and its next commit has a parent.
    const before = Bun.spawnSync(["git", "rev-list", "--count", "a"], { cwd: main, stdout: "pipe" }).stdout.toString().trim();
    const tmp = process.env.TMPDIR;
    process.env.TMPDIR = mkdtempSync(join(tmpdir(), "keel-sandbox-tmp-"));
    try {
      const p = Bun.spawn(confine(["bash", "-c", `: > ready; while [ ! -e go ]; do sleep 0.05; done; ${commit}; git rev-list --count HEAD`], { sandbox: "workspace-write", network: false }, wt), { cwd: wt, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      for (let i = 0; i < 200 && !existsSync(join(wt, "ready")); i++) await Bun.sleep(25);
      git(main, "pack-refs", "--all");
      expect(existsSync(join(common, "refs/heads/a"))).toBe(false); // packed, and the loose file pruned
      writeFileSync(join(wt, "go"), "");
      const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      expect(out).toBe(`committed\n${Number(before) + 1}\n`);
    } finally {
      rmSync(process.env.TMPDIR!, { recursive: true, force: true });
      process.env.TMPDIR = tmp;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The main checkout changes under a running command. The worktree's git reads
// the top's files where they are, so what it decides from them holds: a
// prune keeps what was staged meanwhile, and a branch the main checkout
// switched to is not deleted.
test.skipIf(!sandboxStatus().available)("a command in a worktree reads the main checkout's index and HEAD as they are now", async () => {
  const root = scratch();
  const tmp = process.env.TMPDIR;
  process.env.TMPDIR = mkdtempSync(join(tmpdir(), "keel-sandbox-tmp-"));
  try {
    const { main, wt, common } = repo(root);
    git(main, "branch", "elsewhere");
    const during = async (inside: string, outside: () => void) => {
      rmSync(join(wt, "ready"), { force: true });
      rmSync(join(wt, "go"), { force: true });
      const p = Bun.spawn(confine(["bash", "-c", `: > ready; while [ ! -e go ]; do sleep 0.05; done; ${inside}`], { sandbox: "workspace-write", network: false }, wt), { cwd: wt, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      for (let i = 0; i < 200 && !existsSync(join(wt, "ready")); i++) await Bun.sleep(25);
      outside();
      writeFileSync(join(wt, "go"), "");
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return out + err;
    };
    // Staged in the main checkout while the command waits, then changed on disk: the blob is only in the index.
    await during("git prune; echo pruned-$?", () => { writeFileSync(join(main, "staged"), "only in the index\n"); git(main, "add", "staged"); writeFileSync(join(main, "staged"), "changed since\n"); });
    expect(Bun.spawnSync(["git", "show", ":staged"], { cwd: main, stdout: "pipe" }).stdout.toString()).toBe("only in the index\n");
    git(main, "fsck", "--no-dangling");
    // The main checkout switches to a branch while the command waits: that branch is in use, and stays.
    const said = await during("git branch -D elsewhere; echo deleted-$?", () => git(main, "checkout", "-q", "elsewhere"));
    expect(said).toContain("deleted-1");
    expect(said).toMatch(/used by worktree|checked out at/);
    git(main, "rev-parse", "--verify", "-q", "refs/heads/elsewhere");

    // A clone made without a checkout has no index yet. It gets one while the
    // command waits, with a blob only it holds: the command's prune sees it.
    git(root, "clone", "-q", "--no-checkout", main, "nc");
    const nc = join(root, "nc"), ncw = join(root, "ncw");
    git(nc, "worktree", "add", "-q", "-b", "w", ncw, "HEAD");
    expect(existsSync(join(nc, ".git/index"))).toBe(false);
    const late = async () => {
      const p = Bun.spawn(confine(["bash", "-c", `: > ready; while [ ! -e go ]; do sleep 0.05; done; git prune; echo pruned-$?; (echo x > ${nc}/.git/index) 2>/dev/null || echo index-closed`], { sandbox: "workspace-write", network: false }, ncw), { cwd: ncw, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
      for (let i = 0; i < 200 && !existsSync(join(ncw, "ready")); i++) await Bun.sleep(25);
      git(nc, "checkout", "-q", "main");
      writeFileSync(join(nc, "late"), "only in the new index\n");
      git(nc, "add", "late");
      writeFileSync(join(nc, "late"), "changed since\n");
      writeFileSync(join(ncw, "go"), "");
      const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
      return out;
    };
    expect(await late()).toBe("pruned-0\nindex-closed\n");
    expect(Bun.spawnSync(["git", "show", ":late"], { cwd: nc, stdout: "pipe" }).stdout.toString()).toBe("only in the new index\n");

    // The patterns, attributes and sparse list that steer the main checkout's own git, and its HEAD log: read-only.
    const steer = run(wt, `for f in exclude attributes sparse-checkout grafts; do (echo '*' > ${common}/info/$f) 2>/dev/null && echo wrote-$f; done; (echo x >> ${common}/logs/HEAD) 2>/dev/null && echo wrote-log; (echo x > ${common}/logs/NEW) 2>/dev/null && echo made-log; test -s ${common}/logs/HEAD && echo read-log; echo done`);
    expect(steer.out).toBe("read-log\ndone\n");
    // A new branch from a remote-tracking one: made, with no upstream to write.
    git(main, "update-ref", "refs/remotes/origin/main", "HEAD");
    const made = run(wt, `git checkout -q -b from-remote origin/main && git rev-parse --abbrev-ref HEAD && ${commit}`);
    expect(made.out).toBe("from-remote\ncommitted\n");
    // The settings come after the ones the command's own environment carries, which still hold.
    const own = Bun.spawnSync(confine(["bash", "-c", "git config user.name; git config alias.hi; git config gc.auto; git config branch.autoSetupMerge; echo $GIT_CONFIG_COUNT"], { sandbox: "workspace-write", network: false }, wt), {
      cwd: wt, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "From The Command", GIT_CONFIG_KEY_1: "alias.hi", GIT_CONFIG_VALUE_1: "status" },
    });
    expect(own.stdout.toString()).toBe("From The Command\nstatus\n0\nfalse\n7\n");
    // A session in the main checkout can gc, and is not told otherwise; a new branch still records no upstream.
    expect(run(main, "git config gc.auto; git config maintenance.auto; git config branch.autoSetupMerge; echo $GIT_CONFIG_COUNT").out).toBe("false\n1\n");
    // A commit starts no gc it could not run, and fsck is not told that packed-refs is a link.
    git(main, "pack-refs", "--all");
    // (And a repack does not try to write the server info under the read-only info folder.)
    const quiet = run(wt, `git -c user.name=t -c user.email=t@t -c gc.autoDetach=false commit -q --allow-empty -m more 2>&1; git repack -ad -q 2>&1; git fsck --no-dangling 2>&1; echo quiet-$?`);
    expect(quiet.out).toBe("quiet-0\n");
  } finally {
    rmSync(process.env.TMPDIR!, { recursive: true, force: true });
    process.env.TMPDIR = tmp;
    rmSync(root, { recursive: true, force: true });
  }
});

// A prune or a repack run in a worktree decides what to keep from what every
// checkout of the repository holds: git reads the main checkout's HEAD, HEAD
// log, index and stash, and the other worktrees' own, from the worktree. The
// view of the top must not hide any of it: an object the same commands keep
// when they run unconfined is kept when they run confined.
test.skipIf(!sandboxStatus().available)("a prune or a repack in a worktree keeps what every other checkout holds", () => {
  const sh = (cwd: string, script: string) => {
    const r = Bun.spawnSync(["bash", "-c", script], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (r.exitCode !== 0) throw new Error(`${script}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  // A commit on a branch of its own, made in `dir`, with the branch gone: only `keep` holds it afterwards.
  const lone = (dir: string, name: string) => sh(dir, `git checkout -q -b ${name} && echo ${name} > ${name}.txt && git add ${name}.txt && git commit -qm ${name} && git rev-parse HEAD`);
  const forget = "git reflog expire --expire=now --all";
  // Each: what the owner did in the main checkout (or the other worktree), and the object that only that state holds.
  const cases: Record<string, (r: ReturnType<typeof repo>) => string> = {
    "the main checkout's HEAD log": ({ main }) => { const c = lone(main, "side"); sh(main, "git checkout -q main && git branch -q -D side"); return c; },
    "the main checkout's HEAD log, after its own gc": ({ main }) => { const c = lone(main, "side"); sh(main, "git checkout -q main && git branch -q -D side && git gc -q"); return c; },
    "the main checkout's HEAD, detached": ({ main }) => { const c = lone(main, "side"); sh(main, `git checkout -q --detach && git branch -q -D side && ${forget}`); return c; },
    "the main checkout's index": ({ main }) => { sh(main, "echo staged > staged.txt && git add staged.txt && echo changed > staged.txt"); return sh(main, "git rev-parse :staged.txt"); },
    "the main checkout's stash, the entry below the newest": ({ main }) => { sh(main, "echo one > f && git add f && git stash -q && echo two > f && git add f && git stash -q"); return sh(main, "git rev-parse 'stash@{1}'"); },
    "the main checkout's ORIG_HEAD": ({ main }) => { const c = lone(main, "side"); sh(main, `git reset -q --hard HEAD~1 && git checkout -q main && git branch -q -D side && ${forget}`); return c; },
    "the main checkout's MERGE_HEAD": ({ main }) => { const c = lone(main, "side"); sh(main, `git checkout -q main && git merge -q --no-ff --no-commit side && git branch -q -D side && ${forget}`); return c; },
    "the main checkout's CHERRY_PICK_HEAD": ({ main }) => { const c = lone(main, "side"); sh(main, `git checkout -q main && git rev-parse side > .git/CHERRY_PICK_HEAD && git branch -q -D side && ${forget}`); return c; },
    "a rebase stopped in the main checkout": ({ main }) => {
      sh(main, "echo base > r.txt && git add r.txt && git commit -qm base && git checkout -q -b topic && echo topic > r.txt && git commit -qam topic && echo more > m.txt && git add m.txt && git commit -qm more && git checkout -q main && echo main > r.txt && git commit -qam main");
      const c = sh(main, "git rev-parse topic");
      sh(main, `git checkout -q topic && (git rebase -q main >/dev/null 2>&1 || true) && test -d .git/rebase-merge && git update-ref -d refs/heads/topic && ${forget}`);
      return c;
    },
    "a bisect in the main checkout": ({ main }) => { const c = lone(main, "side"); sh(main, `git checkout -q main && git bisect start -q >/dev/null 2>&1; git bisect bad side >/dev/null 2>&1; git bisect good main >/dev/null 2>&1; git checkout -q main 2>/dev/null; git branch -q -D side && ${forget}`); return c; },
    "another worktree's HEAD, detached": ({ other }) => { const c = lone(other, "side"); sh(other, `git checkout -q --detach && git branch -q -D side && ${forget}`); return c; },
    "another worktree's index": ({ other }) => { sh(other, "echo staged > o.txt && git add o.txt && echo changed > o.txt"); return sh(other, "git rev-parse :o.txt"); },
  };
  const sweep = "git repack -ad -q 2>&1; git prune 2>&1; git gc -q --prune=now 2>&1; true";
  const kept: Record<string, [boolean, boolean]> = {};
  for (const [name, setup] of Object.entries(cases)) {
    const held = [false, true].map((confined) => {
      const root = scratch();
      try {
        const r = repo(root);
        const object = setup(r);
        if (confined) run(r.wt, sweep); else sh(r.wt, sweep);
        return Bun.spawnSync(["git", "cat-file", "-e", object], { cwd: r.main, stderr: "ignore" }).exitCode === 0;
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    kept[name] = [held[0]!, held[1]!];
  }
  // Confined keeps whatever unconfined keeps.
  expect(Object.entries(kept).filter(([, [plain, confined]]) => plain && !confined).map(([name]) => name)).toEqual([]);
  // And what git itself keeps an object by is kept: a log, a HEAD, an index, a stash, of any checkout.
  for (const name of ["the main checkout's HEAD log", "the main checkout's HEAD log, after its own gc", "the main checkout's HEAD, detached", "the main checkout's index", "the main checkout's stash, the entry below the newest", "another worktree's HEAD, detached", "another worktree's index"]) {
    expect([name, kept[name]]).toEqual([name, [true, true]]);
  }
}, 120_000);

// A bare repository has no log folder until a worktree of it commits, and
// nothing can be made at its top from inside the sandbox.
test.skipIf(!sandboxStatus().available)("a worktree of a bare repository commits, branches and stashes", () => {
  const root = scratch();
  try {
    const seed = join(root, "seed"), bare = join(root, "bare.git"), wt = join(root, "bw");
    mkdirSync(seed);
    git(seed, "init", "-q", "-b", "main");
    git(seed, "commit", "-q", "--allow-empty", "-m", "first");
    git(root, "clone", "-q", "--bare", seed, bare);
    rmSync(join(bare, "logs"), { recursive: true, force: true });
    git(bare, "worktree", "add", "-q", "-b", "a", wt);
    // No HEAD log is made for the bare repository, here or from inside.
    const r = run(wt, `${commit}; git checkout -q -b topic && echo x > x && git add x && git stash -q && git stash pop -q && echo stashed; (: > ${bare}/logs/HEAD) 2>/dev/null && echo made-log`);
    expect(r.out).toBe("committed\nstashed\n");
    expect(existsSync(join(bare, "logs/HEAD"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A submodule's git directory holds its config and hooks at its top, as a
// clone's does: read-only as a whole, from the main checkout that holds it and
// from a worktree whose own directory holds it. The worktree still commits.
test.skipIf(!sandboxStatus().available)("a submodule's hooks and config are read-only from the checkout that holds it", () => {
  const root = scratch();
  try {
    const sub = join(root, "sub"), top = join(root, "top"), wt = join(root, "top-wt");
    mkdirSync(sub);
    git(sub, "init", "-q", "-b", "main");
    git(sub, "commit", "-q", "--allow-empty", "-m", "first");
    mkdirSync(top);
    git(top, "init", "-q", "-b", "main");
    git(top, "submodule", "add", "-q", sub, "libs/sub");
    git(top, "commit", "-q", "-m", "with a submodule");
    git(top, "worktree", "add", "-q", "-b", "w", wt);
    git(wt, "submodule", "update", "-q", "--init");
    for (const [from, dir] of [[top, join(top, ".git/modules/libs/sub")], [wt, join(top, ".git/worktrees/top-wt/modules/libs/sub")]] as const) {
      expect(existsSync(join(dir, "HEAD"))).toBe(true);
      const r = run(from, `(cd libs/sub && ${commit}) >/dev/null 2>&1 || echo refused-commit; (echo '[core]' >> ${dir}/config) 2>/dev/null || echo refused-config; (: > ${dir}/hooks/post-checkout) 2>/dev/null || echo refused-hook; mv ${dir} ${dir}-x 2>/dev/null || echo refused-move; (${commit}) 2>/dev/null`);
      expect([from, r.out]).toEqual([from, `refused-commit\nrefused-config\nrefused-hook\nrefused-move\n${from === wt ? "committed\n" : ""}`]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
