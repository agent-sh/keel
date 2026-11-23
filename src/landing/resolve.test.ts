import { expect, test } from "bun:test";
import { afterTask, baseLines, rebaseTask, SUBSTANTIVE, substantive, TRIES } from "./resolve.ts";

test("the base's lines a conflict covers, from the markers git leaves (diff3 and merge style)", () => {
  // The base: a, b, c, d, e. The conflict covers its c-d (lines 3-4).
  const diff3 = ["a", "b", "<<<<<<< HEAD", "c base", "d base", "||||||| parent", "c", "d", "=======", "c mine", ">>>>>>> 1234 (mine)", "e", ""].join("\n");
  expect(baseLines(diff3)).toEqual([[3, 4]]);
  const merge = ["a", "<<<<<<< HEAD", "b base", "=======", "b mine", ">>>>>>> x", "c", "<<<<<<< HEAD", "=======", "added", ">>>>>>> x", "d"].join("\n");
  // Two conflicts: line 2, and a place after line 3 where the base has nothing.
  expect(baseLines(merge)).toEqual([[2, 2], [4, 3]]);
  expect(baseLines("no markers\n")).toEqual([]);
  // A line that only starts like a marker is text.
  expect(baseLines("<<<<<<<<< not one\n")).toEqual([]);
});

test("the rebase task names the branch, the new base tip, the commit it stops at, the files and lines, and the commands", () => {
  const t = rebaseTask({
    branch: "keel/delta-1", tip: "a".repeat(40), base: "main", baseTip: "b".repeat(40), baseSubject: "Change line 5",
    stop: { commit: { sha: "c".repeat(40), subject: "Delta" }, files: [{ path: "notes.md", lines: [[5, 5], [9, 8]] }] },
    try: 1, method: "rebase", checks: ["notes"],
  });
  expect(t).toStartWith("[harness] Landing queue: your branch keel/delta-1 conflicts with main");
  expect(t).toContain(`try 1 of ${TRIES}`);
  expect(t).toContain(`main is now at ${"b".repeat(9)} (Change line 5)`);
  expect(t).toContain(`stops at ${"c".repeat(9)} (Delta)`);
  expect(t).toContain("notes.md: main's lines 5, after 8");
  expect(t).toContain("1. git rebase main");
  expect(t).toContain("GIT_EDITOR=true git rebase --continue");
  expect(t).toContain("the repository's checks (notes)");
  expect(t).toContain(`"${SUBSTANTIVE}"`);
  // A rebase in progress that Keel did not start: left as it is, and no abort is asked for.
  const busy = rebaseTask({ branch: "b", tip: "1", base: "main", baseTip: "2", baseSubject: "s", stop: { files: [] }, try: 2, method: "rebase", checks: [], inProgress: true });
  expect(busy).toContain("already in progress in your worktree, and Keel did not start it: it is left as it is");
  expect(busy).not.toContain("1. git rebase main");
  expect(busy).toContain("Do not run git rebase --abort or git merge --abort on one you did not start");
  expect(rebaseTask({ branch: "b", tip: "1", base: "main", baseTip: "2", baseSubject: "s", stop: { files: [] }, try: 1, method: "merge", checks: [], fresh: true }))
    .toContain("The agent that made b is gone: you take over its branch");
});

test("what follows a rebase task when the agent ends", () => {
  const o = { status: "completed", report: "Rebased.", before: "t1", now: "t2", merges: true, rebasing: false, tries: 1 };
  expect(afterTask(o)).toEqual({ kind: "queue" });
  // Git could not tell: the queue's own build decides.
  expect(afterTask({ ...o, merges: null })).toEqual({ kind: "queue" });
  expect(afterTask({ ...o, now: "t1" })).toEqual({ kind: "again", why: "its agent did not move the branch" });
  expect(afterTask({ ...o, merges: false })).toEqual({ kind: "again", why: "it still conflicts after its agent's rebase" });
  expect(afterTask({ ...o, rebasing: true })).toMatchObject({ kind: "again" });
  // The second failed try goes to the session that started the agent.
  expect(afterTask({ ...o, now: "t1", status: "failed", tries: TRIES })).toEqual({ kind: "parent", why: `its agent did not move the branch (it failed), after ${TRIES} tries` });
  expect(afterTask({ ...o, report: `Both changed the retry count.\n${SUBSTANTIVE}: keep 3 or 5?` })).toEqual({ kind: "parent", why: "its agent found the conflict substantive: keep 3 or 5?" });
  expect(afterTask({ ...o, now: null })).toEqual({ kind: "parent", why: "the branch is gone" });
  expect(afterTask({ ...o, status: "stopped" })).toMatchObject({ kind: "parent" });
  expect(substantive("conflict: SUBSTANTIVE")).toBe("it did not say what must be decided");
  expect(substantive("All settled.")).toBeUndefined();
});
