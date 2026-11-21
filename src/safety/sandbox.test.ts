import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confine, linkedGitBinds, sandboxStatus } from "./sandbox.ts";

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

    // The real worktree: the pointer read-only, a private folder in place of
    // the common directory's top with what the repository has there bound in
    // (the shared stores writable, the rest read-only), its own directory
    // writable but for the files that say where it is, and the top closed last.
    const b = linkedGitBinds(wt);
    const has = (...run: string[]) => b.some((_, i) => run.every((a, j) => b[i + j] === a));
    expect(b.slice(0, 5)).toEqual(["--ro-bind", join(wt, ".git"), join(wt, ".git"), "--tmpfs", common]);
    for (const store of ["objects", "refs", "logs", "info"]) expect(has("--bind", join(common, store), join(common, store))).toBe(true);
    for (const closed of ["hooks", "config", "HEAD", "worktrees", "description"]) expect(has("--ro-bind", join(common, closed), join(common, closed))).toBe(true);
    expect(has("--bind", join(common, "worktrees/wt"), join(common, "worktrees/wt"))).toBe(true);
    for (const f of ["config.worktree", "gitdir", "commondir"]) expect(has("--ro-bind", join(common, "worktrees/wt", f), join(common, "worktrees/wt", f))).toBe(true);
    // packed-refs is a link into the scratch folder, never a bind of the file.
    expect(has("--symlink", "keel-sandbox/packed-refs.1", join(common, "packed-refs"))).toBe(true);
    expect(b.includes(join(common, "index.lock"))).toBe(false);
    expect(b.slice(-2)).toEqual(["--remount-ro", common]);
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
// (also before the repository turns per-worktree config on).
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
      expect(r.out).toContain("committed");
      // (The main checkout may start a submodule: its last line is the one thing it is let do.)
      for (let i = 0; i < (from === wt ? 6 : 5); i++) expect(r.out).toContain(`refused-${i}`);
      // From the worktree nothing was made at the top, a hooks folder included.
      if (from === wt) for (const absent of ["hooks", "config.worktree", "modules"]) expect(existsSync(join(common, absent))).toBe(false);
    }
    expect(existsSync(join(common, "hooks/post-checkout"))).toBe(false);
    expect(readFileSync(join(common, "config.worktree"), "utf8")).toBe("");
    expect(existsSync(join(common, "worktrees/other/config.worktree"))).toBe(false); // that whole directory is read-only
    // The worktree's own pointer, its own config.worktree and where it says it is.
    const own = run(wt, `(echo x > .git) 2>/dev/null || echo refused-pointer; for f in config.worktree gitdir commondir; do (echo x > ${common}/worktrees/wt/$f) 2>/dev/null || echo refused-$f; done`);
    for (const f of ["pointer", "config.worktree", "gitdir", "commondir"]) expect(own.out).toContain(`refused-${f}`);

    // A normal clone's git directory cannot be swapped for a copy: renamed
    // away, the read-only files would stay behind in the old one.
    const swap = run(main, "mv .git old 2>&1; cp -r .git copy && mv .git/hooks .git/hooks2 2>&1; mv .git/worktrees .git/w2 2>&1; ls -d .git/hooks .git/worktrees");
    expect(swap.out).toContain(".git/hooks\n.git/worktrees");
    expect(swap.out.match(/Device or resource busy/g)).toHaveLength(3);
    expect(existsSync(join(main, "old"))).toBe(false);
    // A worktree the session makes inside its folder is its own: to commit
    // in, and to remove in a later command. The one beside the folder is not.
    const nested = run(main, `git worktree add -q -b inner inner 2>&1 && cd inner && ${commit}`);
    expect(nested.out).toContain("committed");
    expect(run(main, `cd inner && ${commit}; cd .. && git worktree remove --force inner && git worktree prune && git worktree list | wc -l`).out).toBe("committed\n3\n");
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

// A submodule's git directory, inside the main checkout's: its code is
// read-only as the repository's own, and commits in the submodule still work.
test.skipIf(!sandboxStatus().available)("a submodule's hooks and config are read-only from the checkout that holds it", () => {
  const root = scratch();
  try {
    const sub = join(root, "sub"), top = join(root, "top");
    mkdirSync(sub);
    git(sub, "init", "-q", "-b", "main");
    git(sub, "commit", "-q", "--allow-empty", "-m", "first");
    mkdirSync(top);
    git(top, "init", "-q", "-b", "main");
    git(top, "submodule", "add", "-q", sub, "libs/sub");
    git(top, "commit", "-q", "-m", "with a submodule");
    const dir = join(top, ".git/modules/libs/sub");
    const r = run(top, `cd libs/sub && ${commit}; (echo '[core]' >> ${dir}/config) 2>/dev/null || echo refused-config; (: > ${dir}/hooks/post-checkout) 2>/dev/null || echo refused-hook; mv ${top}/.git/modules/libs ${top}/.git/modules/x 2>/dev/null || echo refused-move`);
    expect(r.out).toBe("committed\nrefused-config\nrefused-hook\nrefused-move\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
