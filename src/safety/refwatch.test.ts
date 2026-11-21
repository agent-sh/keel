import { expect, test } from "bun:test";
import { changed, type RefState } from "./refwatch.ts";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const state = (refs: Record<string, string>, top: string[] = ["HEAD", "config", "objects", "refs"], branch = "refs/heads/mine"): RefState =>
  ({ refs: new Map(Object.entries(refs)), top: new Set(top), branch });

test("what changed outside the session's own branch is named; its own work is not", () => {
  const before = state({ "refs/heads/mine": A, "refs/heads/main": A, "refs/heads/c": A, "refs/tags/v1": A, "refs/remotes/origin/main": A, "refs/stash": A });
  // Its own commits, a new branch and tag, a fetch: nothing to say.
  expect(changed(before, state({ ...Object.fromEntries(before.refs), "refs/heads/mine": B, "refs/heads/new": B, "refs/tags/v2": B, "refs/remotes/origin/main": B }))).toBeUndefined();
  // It switched to a branch and committed there: that is its branch now.
  expect(changed(before, state({ ...Object.fromEntries(before.refs), "refs/heads/c": B }, undefined, "refs/heads/c"))).toBeUndefined();
  // Another checkout's branch moved, a branch and a tag gone, the stash moved.
  const after = state({ "refs/heads/mine": B, "refs/heads/main": B, "refs/remotes/origin/main": A, "refs/stash": C });
  expect(changed(before, after)).toBe(
    "While this command ran, what this worktree shares with the repository's other checkouts changed: moved branch main (aaaaaaa to bbbbbbb), refs/stash (aaaaaaa to ccccccc); deleted branch c, tag v1.",
  );
  // A branch another checkout has out, at the commit that checkout's own log ends at, is its own commit.
  expect(changed(before, after, new Map([["refs/heads/main", B]]))).toContain("moved refs/stash (aaaaaaa to ccccccc); deleted");
  expect(changed(before, after, new Map([["refs/heads/main", C]]))).toContain("moved branch main");
});

test("a new entry at the top of the git directory is named unless a linked worktree's git makes it there", () => {
  const before = state({ "refs/heads/mine": A });
  expect(changed(before, state({ "refs/heads/mine": B }, ["HEAD", "config", "objects", "refs", "packed-refs", "gc.log", "index.lock", "modules"]))).toBeUndefined();
  expect(changed(before, state({ "refs/heads/mine": B }, ["HEAD", "config", "objects", "refs", "rebase-merge", "MERGE_HEAD"]))).toBe(
    "While this command ran, what this worktree shares with the repository's other checkouts changed: new at the top of the repository's git directory, where the main checkout keeps its own state: MERGE_HEAD, rebase-merge.",
  );
  // A long list is cut, with the count.
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`refs/heads/b${i}`, A]));
  expect(changed(state({ "refs/heads/mine": A, ...many }), state({ "refs/heads/mine": A }))).toEndWith("deleted branch b0, branch b1, branch b2, branch b3, branch b4, branch b5 and 3 more.");
});
