import { expect, test } from "bun:test";
import { capPatch, hunkPatch, parsePatch } from "./patch.ts";

test("a quoted path, a path with spaces and a Hebrew path all keep their hunk", () => {
  const p = [
    'diff --git "a/notes \\"draft\\".txt" "b/notes \\"draft\\".txt"', "index 1..2 100644", '--- "a/notes \\"draft\\".txt"', '+++ "b/notes \\"draft\\".txt"', "@@ -1 +1 @@", "-old", "+sentinel",
    "diff --git a/my notes.txt b/my notes.txt", "@@ -1 +1 @@", "-old", "+sentinel",
    "diff --git a/סיכום.txt b/סיכום.txt", "@@ -1 +1 @@", "-old", "+sentinel",
    'diff --git "a/\\327\\251.txt" "b/\\327\\251.txt"', "@@ -1 +1 @@", "-old", "+sentinel", "",
  ].join("\n");
  const files = parsePatch(p);
  expect(files.map((f) => f.path)).toEqual(['notes "draft".txt', "my notes.txt", "סיכום.txt", "ש.txt"]);
  for (const f of files) expect(f.lines.map((l) => l.text)).toEqual(["@@ -1 +1 @@", "old", "sentinel"]);
  expect(hunkPatch(p, 'notes "draft".txt', 0, "@@ -1 +1 @@")).toContain("+sentinel");
});

test("a mode change and a final newline are kept as what they are", () => {
  const mode = (a: string, b: string) => parsePatch(`diff --git a/run.sh b/run.sh\nold mode ${a}\nnew mode ${b}\n`)[0]!;
  expect(mode("100644", "100755")).toMatchObject({ oldMode: "100644", newMode: "100755", lines: [] });
  expect(mode("100755", "100644")).toMatchObject({ oldMode: "100755", newMode: "100644" });
  const eol = (a: string, b: string) => parsePatch(`diff --git a/f b/f\n@@ -1 +1 @@\n${a}\n${b}\n`)[0]!.lines.map((l) => [l.kind, l.new ?? l.old, !!l.noEol]);
  expect(eol("-same\n\\ No newline at end of file", "+same")).toEqual([["hunk", undefined, false], ["del", 1, true], ["add", 1, false]]);
  expect(eol("-same", "+same\n\\ No newline at end of file")).toEqual([["hunk", undefined, false], ["del", 1, false], ["add", 1, true]]);
});

test("the size cap keeps whole lines and characters, and names the file it cuts", () => {
  const head = "diff --git a/a b/a\n@@ -1 +1 @@\n";
  const p = `${head}-x\n+${"é".repeat(10)}😀 END\ndiff --git a/z b/z\n@@ -1 +1 @@\n-1\n+2\n`;
  const cut = capPatch(p, new TextEncoder().encode(head).length + 3 + 25);
  expect(cut).toEqual({ diff: `${head}-x\n`, truncated: true, partial: "a" });
  // One line longer than the cap: a prefix, never half of a character.
  const one = capPatch(`${"😀".repeat(5)}\n`, 6);
  expect(one.diff).toBe("😀");
  expect(capPatch(p, 1e6)).toEqual({ diff: p, truncated: false });
  // Cut at a file boundary: nothing partial.
  expect(capPatch(p, new TextEncoder().encode(p.slice(0, p.indexOf("diff --git a/z"))).length + 2).partial).toBeUndefined();
});
