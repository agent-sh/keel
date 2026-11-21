import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confine, linkedGitBinds, sandboxStatus } from "./sandbox.ts";

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Error(r.stderr.toString());
};
const pairs = (b: string[]) => b.reduce<string[][]>((out, _, i) => (i % 3 === 0 ? [...out, [b[i]!, b[i + 1]!]] : out), []);
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

    // The real worktree: the pointer pinned, the common directory and its own
    // writable, and read-only in them the code that runs outside the sandbox
    // (also what was missing and is made empty), the other checkouts' files
    // and the files that say where the worktree is.
    expect(pairs(linkedGitBinds(wt))).toEqual([
      ["--ro-bind", join(wt, ".git")],
      ["--bind", common],
      ["--ro-bind", join(common, "hooks")],
      ["--ro-bind", join(common, "config")],
      ["--ro-bind", join(common, "config.worktree")],
      ["--ro-bind", join(common, "worktrees")],
      ["--ro-bind", join(common, "modules")],
      ["--ro-bind", join(common, "HEAD")],
      ["--ro-bind", join(common, "index")],
      ["--bind", join(common, "worktrees/wt")],
      ["--ro-bind", join(common, "worktrees/wt/config.worktree")],
      ["--ro-bind", join(common, "worktrees/wt/gitdir")],
      ["--ro-bind", join(common, "worktrees/wt/commondir")],
    ]);
    for (const made of ["config.worktree", "worktrees/wt/config.worktree"]) expect(readFileSync(join(common, made), "utf8")).toBe("");
    expect(statSync(join(common, "modules")).isDirectory()).toBe(true);
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
    // A hooks folder that is a link cannot be pinned: nothing is opened.
    writeFileSync(join(common, "worktrees/wt/commondir"), "../..\n");
    expect(linkedGitBinds(wt)).not.toEqual([]);
    rmSync(join(common, "hooks"), { recursive: true });
    symlinkSync(prize, join(common, "hooks"));
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
    // A worktree the session makes inside its folder is its own to commit in.
    const nested = run(main, `git worktree add -q -b inner inner 2>&1 && cd inner && ${commit}`);
    expect(nested.out).toContain("committed");
    expect(run(main, `cd inner && ${commit}; (echo '[core]' > ${common}/worktrees/inner/config.worktree) 2>/dev/null || echo refused`).out).toBe("committed\nrefused\n");

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
