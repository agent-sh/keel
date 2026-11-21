import { expect, test } from "bun:test";
import { changed, closed, type RefState } from "./refwatch.ts";

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

test("git's words for what a worktree's profile closes get one sentence, and other errors none", () => {
  for (const said of [
    "error: could not delete reference refs/heads/old: unable to create file /r/.git/keel-sandbox/packed-refs.5.new: File exists",
    "fatal: Unable to create '/r/.git/gc.pid.lock': Read-only file system",
    "fatal: Unable to create '/r/.git/shallow.lock': Read-only file system",
    "error: could not lock config file /r/.git/config: Read-only file system",
    "fatal: could not create directory of '/r/.git/worktrees/x': Read-only file system",
  ]) expect(closed(`some output\n${said}\n`)).toContain("keeps the top of the repository's git directory read-only");
  expect(closed("touch: cannot touch '/etc/x': Read-only file system")).toBeUndefined();
  expect(closed("fatal: Unable to create '/r/.git/worktrees/wt/index.lock': File exists.")).toBeUndefined();
});
