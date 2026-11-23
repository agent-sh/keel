import { expect, test } from "bun:test";
import { changed, sandboxSaid, type RefState } from "./refwatch.ts";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const state = (refs: Record<string, string>, branch = "refs/heads/mine"): RefState => ({ refs: new Map(Object.entries(refs)), branch });

test("what changed outside the session's own branch is named; its own work is not", () => {
  const before = state({ "refs/heads/mine": A, "refs/heads/main": A, "refs/heads/c": A, "refs/tags/v1": A, "refs/remotes/origin/main": A, "refs/stash": A });
  // Its own commits, a new branch and tag, a fetch: nothing to say.
  expect(changed(before, state({ ...Object.fromEntries(before.refs), "refs/heads/mine": B, "refs/heads/new": B, "refs/tags/v2": B, "refs/remotes/origin/main": B }))).toBeUndefined();
  // It switched to a branch and committed there: that is its branch now.
  expect(changed(before, state({ ...Object.fromEntries(before.refs), "refs/heads/c": B }, "refs/heads/c"))).toBeUndefined();
  // Another checkout's branch moved, a branch and a tag gone, the stash moved.
  const after = state({ "refs/heads/mine": B, "refs/heads/main": B, "refs/remotes/origin/main": A, "refs/stash": C });
  expect(changed(before, after)).toBe(
    "While this command ran, what this worktree shares with the repository's other checkouts changed: moved branch main (aaaaaaa to bbbbbbb), refs/stash (aaaaaaa to ccccccc); deleted branch c, tag v1.",
  );
  // A branch another checkout has out, at the commit that checkout's own log ends at, is its own commit.
  expect(changed(before, after, new Map([["refs/heads/main", B]]))).toContain("moved refs/stash (aaaaaaa to ccccccc); deleted");
  expect(changed(before, after, new Map([["refs/heads/main", C]]))).toContain("moved branch main");
});

test("a long list is cut, with the count", () => {
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`refs/heads/b${i}`, A]));
  expect(changed(state({ "refs/heads/mine": A, ...many }), state({ "refs/heads/mine": A }))).toEndWith("deleted branch b0, branch b1, branch b2, branch b3, branch b4, branch b5 and 3 more.");
});

test("a ref made where other checkouts read from, and a name pointed at another ref, are said; the session's own are not", () => {
  const before = state({ "refs/heads/mine": A, "refs/heads/main": A, "refs/heads/c": B });
  const all = (more: Record<string, string>) => state({ ...Object.fromEntries(before.refs), ...more });
  // A replacement of a commit and a note change what the main checkout reads.
  expect(changed(before, all({ "refs/replace/aaaa": B, "refs/notes/commits": C, "refs/other/x": C }))).toBe(
    "While this command ran, what this worktree shares with the repository's other checkouts changed: created refs/replace/aaaa, refs/notes/commits, refs/other/x.",
  );
  // A branch, a tag, a stash, what a bisect or a rebase keeps: ordinary work.
  expect(changed(before, all({ "refs/heads/new": B, "refs/tags/v1": B, "refs/stash": B, "refs/bisect/bad": B, "refs/rewritten/x": B }))).toBeUndefined();
  // One of Keel's own (a parked worktree's state is kept under refs/keel/): said.
  expect(changed(before, all({ "refs/keel/parked/s": B }))).toContain("created refs/keel/parked/s");
  // main made a name for c, at the same commit or not; a new branch that only names another.
  expect(changed(before, all({ "refs/heads/main": `${B} refs/heads/c` }))).toContain("changed what branch main (now a name for branch c) points at");
  expect(changed(state({ "refs/heads/mine": A, "refs/heads/main": `${B} refs/heads/c`, "refs/heads/c": B }), before)).toContain("changed what branch main (now a ref of its own) points at");
  expect(changed(before, all({ "refs/heads/alias": `${A} refs/heads/main` }))).toContain("created branch alias (a name for branch main)");
  // What the session's own commands made this turn: deleted or moved again without a word.
  const own = new Set(["refs/heads/topic"]);
  const with_topic = all({ "refs/heads/topic": B });
  expect(changed(with_topic, before, undefined, own)).toBeUndefined();
  expect(changed(with_topic, before)).toContain("deleted branch topic");
});

test("what a confined command ran into gets one sentence each, in the tool's own words for leaving the sandbox", () => {
  const escape = "ESCAPE.";
  const at = { linked: true, network: false, escape };
  for (const said of [
    "error: could not delete reference refs/heads/old: unable to create file /r/.git/keel-sandbox/packed-refs.5.new: File exists",
    "fatal: Unable to create '/r/.git/gc.pid.lock': Read-only file system",
    "fatal: Unable to create '/r/.git/shallow.lock': Read-only file system",
    "fatal: Unable to create '/r/.git/keel-sandbox/top/packed-refs.lock': Read-only file system",
    "fatal: could not create directory of '/r/.git/worktrees/x': Read-only file system",
    "fatal: could not create directory '/r/.git/rr-cache'",
    "error: unable to update /r/.git/info/refs: Read-only file system",
    "error: cannot lock ref 'main-worktree/HEAD': Unable to create '/r/.git/HEAD.lock': Read-only file system",
  ]) expect(sandboxSaid(`some output\n${said}\n`, at)).toEqual([expect.stringMatching(/^This worktree's sandbox keeps the top of the repository's git directory read-only.* ESCAPE\.$/)]);
  // The config, in a worktree and in a main checkout alike.
  for (const said of [
    "error: could not lock config file /r/.git/config: Read-only file system",
    "error: could not write config file /r/.git/config: Device or resource busy",
    "error: unable to write upstream branch configuration",
    "fatal: branch is renamed, but update of config-file failed",
  ]) expect(sandboxSaid(said, { ...at, linked: false })).toEqual([expect.stringMatching(/^The repository's config is read-only in a sandboxed session.*git branch -m renames the branch and then exits 128.* ESCAPE\.$/)]);
  // A branch that was deleted, with git's warning about its settings: nothing to add.
  expect(sandboxSaid("error: could not lock config file /r/.git/config: Read-only file system\nwarning: update of config-file failed\nDeleted branch topic (was 1234567).", at)).toEqual([]);
  // The network: off says so; on, a command that did not go through the proxy is told how the sandbox's network works.
  const lost = "fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com";
  expect(sandboxSaid(lost, at)).toEqual([expect.stringMatching(/^This session's network is off.*The owner turns it on in the session's permissions \("Network in the sandbox"\)\. ESCAPE\.$/)]);
  expect(sandboxSaid(lost, { ...at, network: true })).toEqual([expect.stringMatching(/^This session's sandbox has a network of its own\..* ESCAPE\.$/)]);
  expect(sandboxSaid("Everything up-to-date", { ...at, network: true })).toEqual([]);
  expect(sandboxSaid("ssh: Could not resolve hostname github.com: Temporary failure in name resolution", at)).toHaveLength(1);
  // A session none of git's files is open to (its folder is inside a repository, or its worktree could not be opened): why, and nothing else about git.
  const shut = { ...at, shut: () => "this session's folder is inside the repository at /r, and so on" };
  expect(sandboxSaid("fatal: Unable to create '/r/.git/index.lock': Read-only file system", shut)).toEqual(["git could not write here: this session's folder is inside the repository at /r, and so on. ESCAPE."]);
  expect(sandboxSaid("error: could not lock config file /r/.git/config: Read-only file system", shut)).toHaveLength(1);
  expect(sandboxSaid("ls: cannot access 'x'", shut)).toEqual([]);
  // Not the sandbox's doing.
  expect(sandboxSaid("touch: cannot touch '/etc/x': Read-only file system", at)).toEqual([]);
  expect(sandboxSaid("fatal: Unable to create '/r/.git/worktrees/wt/index.lock': File exists.", at)).toEqual([]);
  expect(sandboxSaid("fatal: Unable to create '/r/.git/gc.pid.lock': Read-only file system", { ...at, linked: false })).toEqual([]);
});

// The checkouts a worktree shares its branches with, read from a real repository: the main checkout and another
// worktree, each with the branch it has out; the worktree's own is not one of them.
test("the checkouts a worktree shares its branches with are read from the repository's files", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { realOf } = await import("../core/paths.ts");
  const { checkoutsOf } = await import("./refwatch.ts");
  const { sharedRefusal } = await import("./shared-branches.ts");
  const dir = realOf(mkdtempSync(join(process.env.TMPDIR ?? ".", "shared-")));
  const git = (cwd: string, ...args: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, env: { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  try {
    const main = join(dir, "main"), agent = join(dir, "agent"), other = join(dir, "other");
    git(dir, "init", "-q", main);
    writeFileSync(join(main, "a"), "a\n");
    git(main, "add", "a");
    git(main, "commit", "-qm", "a");
    git(main, "worktree", "add", "-q", "-b", "keel/x", agent);
    git(main, "worktree", "add", "-q", "-b", "keel/y", other);
    const s = checkoutsOf(agent, "keel/x", "main")!;
    expect([...s.out].sort()).toEqual([["keel/y", other], ["main", main]]);
    expect(s.folders.sort()).toEqual([main, other].sort());
    expect(s.root).toBe(agent);
    expect(sharedRefusal("git push . HEAD:main", agent, dir, s)).toBe("pushes into the branch main, which another checkout has out");
    expect(sharedRefusal(`git -C ${main} reset --hard`, agent, dir, s)).toBe(`runs git reset in ${main}, another checkout of this repository`);
    expect(sharedRefusal(`GIT_DIR=${join(main, ".git")} git reset --hard`, agent, dir, s)).toBe(`runs git reset in ${main}, another checkout of this repository`);
    expect(sharedRefusal("git commit -qm b", agent, dir, s)).toBeNull();
    // What a review ran from such a worktree: a symbolic ref over main, env -C, a plain write of the ref.
    expect(sharedRefusal("git symbolic-ref refs/heads/main refs/heads/keel/x", agent, dir, s)).toBe("makes the branch main, which another checkout has out a link to refs/heads/keel/x");
    expect(sharedRefusal(`env -C ${main} git reset --hard`, agent, dir, s)).toBe(`runs git reset in ${main}, another checkout of this repository`);
    expect(sharedRefusal(`echo x > ${main}/.git/refs/heads/main`, agent, dir, s)).toBe(`writes ${main}/.git/refs/heads/main, in the repository's git directory, which every checkout shares`);
    // A remote is read from the repository's config: one that is this repository is local, a server is not.
    git(main, "remote", "add", "loc", main);
    git(main, "remote", "add", "origin", "https://example.com/r.git");
    const r = checkoutsOf(agent, "keel/x", "main")!;
    expect([...r.remotes!]).toEqual([["loc", [main]], ["origin", ["https://example.com/r.git"]]]);
    expect(sharedRefusal("git push loc HEAD:main", agent, dir, r)).toBe("pushes into the branch main, which another checkout has out");
    expect(sharedRefusal("git push origin HEAD:main", agent, dir, r)).toBeNull();
    // Not a linked worktree: nothing to share.
    expect(checkoutsOf(main, "main", null)).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
