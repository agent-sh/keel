import { describe, expect, test } from "bun:test";
import { areasOf, folderOf, inOrder, Keep, landOrder, namesLine, overlapsOf, pairsOf, parseDiff, wordsOf, type BranchDiff } from "./tree.ts";
import { MERGES_KEPT } from "./tree-review.ts";

describe("areas", () => {
  test("a path's folder area: two folders, one further under a sources folder", () => {
    expect(folderOf("README.md")).toBe(".");
    expect(folderOf("docs/guide.md")).toBe("docs");
    expect(folderOf("src/board/rules.ts")).toBe("src/board");
    expect(folderOf("src/server/routes/board.ts")).toBe("src/server");
    expect(folderOf("ui/src/components/WorkBoard.tsx")).toBe("ui/src/components");
    expect(folderOf("packages/core/src/index.ts")).toBe("packages/core");
  });

  test("a name's words split camel case and separators", () => {
    expect(wordsOf("WorkBoard.tsx")).toEqual(["work", "board"]);
    expect(wordsOf("work-board.spec.ts")).toEqual(["work", "board", "spec"]);
  });

  test("files of shared folders join the feature they name; the rest keep their folder", () => {
    const paths = [
      "src/board/rules.ts", "src/board/tree.ts", "src/landing/queue.ts",
      "src/server/routes/board.ts", "src/server/routes/landing.ts", "src/server/app.ts",
      "ui/src/components/WorkBoard.tsx", "ui/src/components/Composer.tsx",
      "test/e2e/work-board.spec.ts", "test/e2e/landing.spec.ts", "test/e2e/chat.spec.ts",
      "src/board/sub/landing-facts.ts", "README.md",
    ];
    const a = areasOf(paths);
    expect(a.get("src/board/rules.ts")).toBe("src/board");
    expect(a.get("src/server/routes/board.ts")).toBe("src/board");
    expect(a.get("src/server/routes/landing.ts")).toBe("src/landing");
    expect(a.get("ui/src/components/WorkBoard.tsx")).toBe("src/board");
    expect(a.get("test/e2e/work-board.spec.ts")).toBe("src/board");
    expect(a.get("test/e2e/landing.spec.ts")).toBe("src/landing");
    // Nothing named: its own folder.
    expect(a.get("ui/src/components/Composer.tsx")).toBe("ui/src/components");
    expect(a.get("test/e2e/chat.spec.ts")).toBe("test/e2e");
    expect(a.get("src/server/app.ts")).toBe("src/server");
    // A file of a feature's own folder stays there, whatever its name says.
    expect(a.get("src/board/sub/landing-facts.ts")).toBe("src/board");
    expect(a.get("README.md")).toBe(".");
  });

  test("a feature only exists when its folder changed, and plural names match", () => {
    expect(areasOf(["ui/src/components/WorkBoard.tsx"]).get("ui/src/components/WorkBoard.tsx")).toBe("ui/src/components");
    expect(areasOf(["src/agents/x.ts", "test/e2e/agent.spec.ts"]).get("test/e2e/agent.spec.ts")).toBe("src/agents");
  });
});

const diff = (path: string, hunks: string[]) => `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n${hunks.join("\n")}\n`;

describe("diffs and overlaps", () => {
  test("a diff parses to files, hunks and counts; past the kept lines hunks keep their places", () => {
    const text = diff("a.txt", ["@@ -1,2 +1,2 @@", "-one", "+ONE", " two", "@@ -10 +10,2 @@", " ten", "+eleven"])
      + "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hi\n";
    const p = parseDiff(text);
    expect(p.files.map((f) => [f.path, f.status, f.added, f.removed, f.hunks.length])).toEqual([["a.txt", "M", 2, 1, 2], ["new.txt", "A", 1, 0, 1]]);
    expect(p.files[0]!.hunks[0]).toMatchObject({ old: 1, oldN: 2, new: 1, newN: 2, lines: ["-one", "+ONE", " two"] });
    const cut = parseDiff(text, 3);
    expect(cut.cut).toBe(true);
    expect(cut.files[0]!.hunks[1]!.lines).toEqual([]);
    expect(cut.files[0]!.added).toBe(2);
  });

  const b = (branch: string, mb: string, path: string, hunks: string[]): BranchDiff => ({ branch, mergeBase: mb, files: parseDiff(diff(path, hunks)).files });

  test("hunks of two branches that change the same base lines meet; ones apart do not", () => {
    const ds = [
      b("alpha", "m", "notes.md", ["@@ -3,2 +3,2 @@", "-c", "-d", "+C", "+D", "@@ -20 +20 @@", "-t", "+T"]),
      b("beta", "m", "notes.md", ["@@ -4 +4 @@", "-d", "+dd"]),
      b("gamma", "m", "notes.md", ["@@ -30 +30 @@", "-x", "+X"]),
      b("delta", "n", "other.md", ["@@ -1 +1 @@", "-a", "+A"]),
    ];
    const ov = overlapsOf(ds);
    expect(ov).toEqual([{ id: "notes.md#0", path: "notes.md", hunks: [{ branch: "alpha", index: 0 }, { branch: "beta", index: 0 }], branches: ["alpha", "beta"], approx: false }]);
    expect(pairsOf(ov)).toEqual([{ a: "alpha", b: "beta", files: ["notes.md"] }]);
    // Different merge bases: the lines are each side's own.
    expect(overlapsOf([ds[0]!, { ...ds[1]!, mergeBase: "other" }])[0]!.approx).toBe(true);
  });

  test("an insertion next to a change meets it, as git's merge does", () => {
    const ov = overlapsOf([b("a", "m", "f", ["@@ -5 +5 @@", "-e", "+E"]), b("b", "m", "f", ["@@ -5,0 +6 @@", "+new"])]);
    expect(ov.length).toBe(1);
  });
});

describe("the order to land in", () => {
  const br = (branch: string, o: Partial<{ ready: boolean; baseConflict: boolean; size: number }> = {}) => ({ branch, ready: false, baseConflict: false, size: 10, ...o });

  test("branches that meet nothing land together first; of two that conflict the ready one lands first", () => {
    const o = landOrder([br("a"), br("b", { ready: true }), br("c"), br("d")], [{ a: "a", b: "b", files: ["x.ts"], conflict: true }]);
    expect(o.steps.map((s) => s.branches)).toEqual([["b", "c", "d"], ["a"]]);
    expect(o.why.a).toContain("after b");
    expect(o.why.c).toBe("meets no other branch");
  });

  test("a pair git merges clean needs no order", () => {
    const o = landOrder([br("a"), br("b")], [{ a: "a", b: "b", files: ["x.ts"], conflict: false }]);
    expect(o.steps.map((s) => s.branches)).toEqual([["a", "b"]]);
  });

  test("a hub lands before the branches it meets, a base conflict after the rest, the larger first on a tie", () => {
    const o = landOrder([br("leaf1"), br("hub", { size: 5 }), br("leaf2", { size: 50 }), br("based", { baseConflict: true })], [
      { a: "hub", b: "leaf1", files: ["f"], conflict: true },
      { a: "hub", b: "leaf2", files: ["g"], conflict: null },
    ]);
    expect(o.steps.map((s) => s.branches)).toEqual([["hub", "based"], ["leaf2", "leaf1"]]);
    expect(o.why.based).toContain("conflicts with the base");
    expect(inOrder(o, ["leaf1", "based", "hub"])).toEqual(["hub", "based", "leaf1"]);
  });

  test("a chain goes one step a link", () => {
    const o = landOrder([br("a", { size: 30 }), br("b", { size: 20 }), br("c", { size: 10 })], [
      { a: "a", b: "b", files: ["f"], conflict: true },
      { a: "b", b: "c", files: ["g"], conflict: true },
    ]);
    // b meets two: it lands first; a and c meet only b, so they go together after it.
    expect(o.steps.map((s) => s.branches)).toEqual([["b"], ["a", "c"]]);
  });
});

describe("what the review keeps", () => {
  test("a read keeps an entry: the one read longest ago goes first", () => {
    const k = new Keep<string, number>(3);
    k.set("a", 1); k.set("b", 2); k.set("c", 3);
    expect(k.get("a")).toBe(1);
    k.set("d", 4);
    expect([...k.keys()]).toEqual(["c", "a", "d"]);
    expect(k.get("b")).toBeUndefined();
  });
  test("a tree of 30 branches has its pairs' merges kept twice over", () => {
    // 30 branches that all meet: 435 pairs and 30 merges with the base a view.
    expect(MERGES_KEPT).toBeGreaterThanOrEqual(1024);
    expect(MERGES_KEPT).toBeGreaterThanOrEqual(2 * (30 * 29 / 2 + 30));
  });
  test("a list past five names says how many more", () => {
    expect(namesLine(["a", "b"])).toBe("a, b");
    expect(namesLine(["a", "b", "c", "d", "e", "f", "g"])).toBe("a, b, c, d, e (+2 more)");
  });
});
