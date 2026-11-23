import { describe, expect, test } from "bun:test";
import { clashes, clearedNote, conflictNote, decide, linesSay, pairsOf, parseHunks, parseMergeTree, splitDiff } from "./overlap.ts";

describe("merge-tree output", () => {
  test("clean, conflicted, and git failing", () => {
    expect(parseMergeTree("1367222177d964ca85aed1c739258763d3494660\0", 0)).toEqual({ conflict: false });
    expect(parseMergeTree("1367222177d964ca85aed1c739258763d3494660\0del.txt\0f.txt\0\0", 1)).toEqual({ conflict: true, files: ["del.txt", "f.txt"] });
    // A conflict that names no file (a directory rename) is still a conflict.
    expect(parseMergeTree("1367222177d964ca85aed1c739258763d3494660\0\0", 1)).toEqual({ conflict: true, files: [] });
    // Unrelated histories and the like are never read as clean.
    expect(parseMergeTree("", 128, "fatal: refusing to merge unrelated histories\n")).toEqual({ error: "fatal: refusing to merge unrelated histories" });
  });
});

describe("where two changes meet", () => {
  const hunks = (s: string) => parseHunks(s);
  test("hunk heads, with and without counts", () => {
    expect(hunks("diff --git a/f b/f\n@@ -2 +2 @@\n-b\n+bA\n@@ -7,0 +8,2 @@\n+x\n+y\n@@ -10,3 +11,0 @@\n")).toEqual([
      { old: 2, oldN: 1, new: 2, newN: 1 }, { old: 7, oldN: 0, new: 8, newN: 2 }, { old: 10, oldN: 3, new: 11, newN: 0 },
    ]);
  });
  test("the same line on both sides", () => {
    expect(clashes(hunks("@@ -2 +2 @@"), hunks("@@ -2 +2 @@"))).toEqual([{ a: [2, 2], b: [2, 2] }]);
  });
  test("adjacent lines meet, as git's merge conflicts on them", () => {
    expect(clashes(hunks("@@ -2 +2 @@"), hunks("@@ -3 +3 @@"))).toEqual([{ a: [2, 2], b: [3, 3] }]);
    // An insertion after line 2 meets a change of line 3.
    expect(clashes(hunks("@@ -2,0 +3,2 @@"), hunks("@@ -3 +3 @@"))).toEqual([{ a: [3, 4], b: [3, 3] }]);
  });
  test("changes a line apart do not meet", () => {
    expect(clashes(hunks("@@ -2 +2 @@"), hunks("@@ -4 +4 @@"))).toEqual([]);
    expect(clashes(hunks("@@ -2 +2 @@\n@@ -9 +9 @@"), hunks("@@ -5 +5 @@"))).toEqual([]);
  });
  test("each side's lines are its own file's, after its earlier changes", () => {
    // Side a added 3 lines near the top, then both changed base line 20.
    expect(clashes(hunks("@@ -1,0 +2,3 @@\n@@ -20 +23 @@"), hunks("@@ -20,2 +20,4 @@"))).toEqual([{ a: [23, 23], b: [20, 23] }]);
  });
  test("a chain of touching hunks is one meeting", () => {
    expect(clashes(hunks("@@ -2 +2 @@\n@@ -4 +4 @@"), hunks("@@ -3 +3 @@"))).toEqual([{ a: [2, 4], b: [3, 3] }]);
  });
  test("lines removed on one side", () => {
    const [c] = clashes(hunks("@@ -5,2 +4,0 @@"), hunks("@@ -5 +5 @@"));
    expect(c).toEqual({ a: [5, 4], b: [5, 5] });
    expect(linesSay(c!.a)).toBe("lines removed after line 4");
    expect(linesSay([3, 3])).toBe("line 3");
    expect(linesSay([3, 9])).toBe("lines 3-9");
  });
});

describe("what a check changes for a recipient", () => {
  const clean = { conflict: false } as const;
  const on = (...files: string[]) => ({ conflict: true as const, files });
  test("a clean pair never told says nothing", () => {
    expect(decide(undefined, clean)).toEqual({ fresh: [] });
  });
  test("a new conflict is owed, once", () => {
    expect(decide(undefined, on("a.ts", "b.ts"))).toEqual({ notice: "conflict", fresh: ["a.ts", "b.ts"] });
    expect(decide(["a.ts", "b.ts"], on("a.ts", "b.ts"))).toEqual({ fresh: [] });
    expect(decide(["a.ts", "b.ts"], on("a.ts"))).toEqual({ fresh: [] });
  });
  test("a file newly in the conflict is owed", () => {
    expect(decide(["a.ts"], on("a.ts", "c.ts"))).toEqual({ notice: "conflict", fresh: ["c.ts"] });
  });
  test("a conflict that went is told as gone to whoever was told of it", () => {
    expect(decide(["a.ts"], clean)).toEqual({ notice: "cleared", fresh: [] });
    expect(decide([], clean)).toEqual({ notice: "cleared", fresh: [] });
  });
  test("git failing changes nothing", () => {
    expect(decide(["a.ts"], { error: "fatal" })).toEqual({ fresh: [] });
    expect(decide(undefined, { error: "fatal" })).toEqual({ fresh: [] });
  });
  test("a conflict with no file is told once", () => {
    expect(decide(undefined, on())).toEqual({ notice: "conflict", fresh: [] });
    expect(decide([], on())).toEqual({ fresh: [] });
  });
});

describe("the note", () => {
  const mine = { branch: "keel/a", tip: "1111111111111111", who: "your branch" };
  const other = { branch: "keel/b", tip: "2222222222222222", who: 'the branch of session "Fix it" (s2)' };
  test("names the other branch, its session, the files and the lines", () => {
    const t = conflictNote(mine, other, [{ path: "src/x.ts", clashes: [{ a: [10, 14], b: [10, 16] }] }, { path: "img.png", clashes: [] }], 2, false);
    expect(t).toStartWith("[harness] Overlap forecast: Your branch keel/a would conflict with keel/b, the branch of session \"Fix it\" (s2), in src/x.ts (your lines 10-14 against its lines 10-16), img.png (both changed it;");
    expect(t).toContain("keel/a 111111111 and keel/b 222222222");
    expect(t).toContain("neither branch was touched");
  });
  test("with the base", () => {
    const t = conflictNote(mine, { branch: "main", tip: "3333333333", who: "the base" }, [{ path: "f", clashes: [{ a: [1, 1], b: [1, 2] }] }], 1, true);
    expect(t).toContain("would conflict with the base main, in f (your line 1 against main's lines 1-2)");
    expect(t).toContain("Rebase onto main before landing.");
  });
  test("a parent hears of its agent's branch", () => {
    const t = conflictNote({ ...mine, who: 'the branch of your agent "Lane" (s1)' }, other, [{ path: "f", clashes: [{ a: [1, 1], b: [1, 1] }] }], 1, false);
    expect(t).toContain('The branch of your agent "Lane" (s1) keel/a would conflict');
    expect(t).toContain("keel/a's line 1 against its line 1");
  });
  test("a long list is cut to a count", () => {
    const files = Array.from({ length: 15 }, (_, i) => ({ path: `f${i}`, clashes: [] }));
    expect(conflictNote(mine, other, files, 15, false)).toContain(", and 3 more.");
  });
  test("files told before are counted, not named again", () => {
    expect(conflictNote(mine, other, [{ path: "new.ts", clashes: [] }], 3, false)).toContain("2 more files were told before.");
  });
  test("gone", () => {
    expect(clearedNote(mine, other, false)).toBe("[harness] Overlap forecast: your branch keel/a no longer conflicts with keel/b (checked at 111111111 and 222222222).");
  });
});

test("pairs: every two branches once, in a stable order", () => {
  expect(pairsOf(["c", "a", "b", "a"])).toEqual([["a", "b"], ["a", "c"], ["b", "c"]]);
  expect(pairsOf(["x"])).toEqual([]);
  expect(pairsOf(Array.from({ length: 10 }, (_, i) => `b${i}`))).toHaveLength(45);
});

test("a diff of several files is cut by file", () => {
  const d = "diff --git a/src/a b.ts b/src/a b.ts\nindex 1..2 100644\n--- a/src/a b.ts\n+++ b/src/a b.ts\n@@ -2 +2 @@\n-x\n+y\ndiff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -5,0 +6 @@\n+z\n";
  const parts = splitDiff(d);
  expect([...parts.keys()]).toEqual(["src/a b.ts", "notes.md"]);
  expect(parseHunks(parts.get("notes.md")!)).toEqual([{ old: 5, oldN: 0, new: 6, newN: 1 }]);
  expect(splitDiff('diff --git "a/q\\"x" "b/q\\"x"\n@@ -1 +1 @@\n').size).toBe(0);
});
