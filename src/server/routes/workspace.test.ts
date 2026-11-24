import { expect, test } from "bun:test";
import { notManaged } from "./workspace.ts";

test("the folders sessions used leave out the worktrees Keel made for agents", () => {
  const state = "/home/a/.local/share/keel/state";
  const used = ["/home/a/code/repo", `${state}/worktrees/keel-repo-1a2b3c`, `${state}/worktrees`, `${state}/artifacts/x`, "/home/a/code/worktrees-notes"];
  expect(notManaged(used, state)).toEqual(["/home/a/code/repo", `${state}/artifacts/x`, "/home/a/code/worktrees-notes"]);
});
