import { describe, expect, test } from "bun:test";
import { clashes, decide, forecastNote, linesSay, NOTE_CHARS, pairKey, pairsOf, parseHunks, parseMergeTree, splitDiff, waiting } from "./overlap.ts";

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
  const other = { branch: "keel/b", tip: "2222222222222222", who: 'session "Fix it" s2' };
  const base = { branch: "main", tip: "3333333333", who: "the base" };
  test("one line a branch: each other branch and the files, never the lines", () => {
    const t = forecastNote([{ mine, other, files: ["src/x.ts", "img.png"], all: 2, base: false }, { mine, other: base, files: ["f"], all: 1, base: true }], []);
    expect(t).toContain('- Your branch keel/a would conflict with the base main: f; with keel/b (session "Fix it" s2): src/x.ts, img.png.');
    expect(t).toStartWith("[harness] Overlap forecast (git merge-tree; no branch was touched).");
    expect(t).not.toMatch(/line \d/);
  });
  test("a parent hears of its agents' branches, grouped", () => {
    const lane = { ...mine, who: 'your agent "Lane" s1' };
    const t = forecastNote([{ mine: lane, other, files: ["f"], all: 1, base: false }, { mine: lane, other: base, files: ["g"], all: 1, base: true }], []);
    expect(t.split("\n").filter((l) => l.startsWith("- "))).toEqual(['- keel/a (your agent "Lane" s1) would conflict with the base main: g; with keel/b (session "Fix it" s2): f.']);
  });
  test("files past a few, and files told before, are counts", () => {
    const files = Array.from({ length: 7 }, (_, i) => `f${i}`);
    expect(forecastNote([{ mine, other, files, all: 9, base: false }], [])).toContain("f0, f1, f2, f3 (+3 more, 2 told before)");
  });
  test("many agents' pairs stay within the budget and are counted", () => {
    const told = Array.from({ length: 300 }, (_, i) => ({ mine: { branch: `keel/lane-${i % 25}`, tip: "1", who: `your agent "Lane ${i % 25}" s${i % 25}` }, other: { branch: `keel/other-${i}`, tip: "2", who: `your agent "Other ${i}" o${i}` }, files: ["src/engine/turn.ts", "ui/src/bridge.css"], all: 2, base: false }));
    const t = forecastNote(told, []);
    expect(t.length).toBeLessThanOrEqual(NOTE_CHARS);
    expect(t).toMatch(/\d+ more pairs are not listed here; check one with git merge-tree/);
  });
  test("every pair is named or counted, also on a branch too long for its line", () => {
    for (const len of [5, 40, 120, 300]) for (const n of [3, 10, 100]) {
      const lane = { branch: `keel/${"x".repeat(len)}`, tip: "1", who: 'your agent "Lane" s1' };
      const told = Array.from({ length: n }, (_, i) => ({ mine: lane, other: { branch: `keel/o${i}-${"y".repeat(len)}`, tip: "2", who: `session "O${i}" o${i}` }, files: ["src/a.ts"], all: 1, base: false }));
      const t = forecastNote(told, []);
      const named = (t.match(/with keel\//g) ?? []).length;
      const more = Number(/\(and (\d+) more\)/.exec(t)?.[1] ?? 0) + Number(/(\d+) more pairs? (is|are) not listed/.exec(t)?.[1] ?? 0);
      expect(named + more).toBe(n);
      expect(t.length).toBeLessThanOrEqual(NOTE_CHARS);
    }
  });
  test("gone", () => {
    const t = forecastNote([], [{ mine, other, base: false }]);
    expect(t).toBe("[harness] Overlap forecast (git merge-tree; no branch was touched).\n- No longer conflicting: keel/a with keel/b.");
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

test("a pair conflict waits while one of its sides conflicts with the base", () => {
  const base = (a: string, conflict: boolean) => ({ a, b: "main", base: true, conflict });
  const pair = (a: string, b: string, conflict = true) => ({ a, b, base: false, conflict });
  const before = waiting([base("x", true), base("y", false), base("z", false), pair("x", "y"), pair("x", "z"), pair("y", "z", false)]);
  expect([...before]).toEqual([pairKey("x", "y"), pairKey("x", "z")]);
  // X rebased: its pairs are told as they are.
  expect(waiting([base("x", false), pair("x", "y"), pair("x", "z", false)]).size).toBe(0);
});
