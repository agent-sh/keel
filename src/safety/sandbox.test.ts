import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkedGitBinds } from "./sandbox.ts";

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (!r.success) throw new Error(r.stderr.toString());
};
const pairs = (b: string[]) => b.reduce<string[][]>((out, _, i) => (i % 3 === 0 ? [...out, [b[i]!, b[i + 1]!]] : out), []);

// The pointer to a linked worktree's git directory is a file the sandbox can
// rewrite. It opens nothing unless git's own layout confirms it.
test("a linked worktree's git directories are writable only when the layout confirms the pointer", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-sandbox-")));
  try {
    const repo = join(root, "repo"), wt = join(root, "wt"), other = join(root, "other"), prize = join(root, "prize");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "first");
    git(repo, "worktree", "add", "-q", "-b", "a", wt);
    git(repo, "worktree", "add", "-q", "-b", "b", other);
    const common = join(repo, ".git");

    // The real worktree: the common directory and its own, with the code that
    // runs outside the sandbox and the other checkouts' files read-only.
    expect(pairs(linkedGitBinds(wt))).toEqual([
      ["--bind", common],
      ["--ro-bind", join(common, "hooks")],
      ["--ro-bind", join(common, "config")],
      ["--ro-bind", join(common, "worktrees")],
      ["--ro-bind", join(common, "HEAD")],
      ["--ro-bind", join(common, "index")],
      ["--bind", join(common, "worktrees/wt")],
    ]);
    // The main checkout keeps git's files inside its folder: nothing to add.
    expect(linkedGitBinds(repo)).toEqual([]);
    // With per-worktree config on, the worktree's own config is read-only too.
    git(repo, "config", "extensions.worktreeConfig", "true");
    expect(pairs(linkedGitBinds(wt)).at(-1)).toEqual(["--ro-bind", join(common, "worktrees/wt/config.worktree")]);
    expect(readFileSync(join(common, "worktrees/wt/config.worktree"), "utf8")).toBe("");

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
    // The real directory with its commondir rewritten (a confined command can
    // write there): refused as well.
    writeFileSync(join(wt, ".git"), `gitdir: ${join(common, "worktrees/wt")}\n`);
    writeFileSync(join(common, "worktrees/wt/commondir"), `${prize}\n`);
    expect(linkedGitBinds(wt)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
