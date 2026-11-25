import { describe, expect, test } from "bun:test";
import { parsePatch } from "../../../src/safety/patch.ts";
import { diffKey, hashText, viewedPaths } from "./viewed.ts";

const patch = (a: string, b: string) => `diff --git a/a.txt b/a.txt
index 1..2 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-${a}
+${b}
 three
diff --git a/b.txt b/b.txt
index 1..2 100644
--- a/b.txt
+++ b/b.txt
@@ -1 +1 @@
-x
+y
`;
const file = (path: string) => ({ path, status: "M", added: 1, removed: 1 });
const keysOf = (text: string) => {
  const by = new Map(parsePatch(text).map((p) => [p.path, p]));
  return new Map(["a.txt", "b.txt"].map((p) => [p, diffKey(file(p), by.get(p))]));
};

describe("a file's viewed mark", () => {
  test("the same diff gives the same key", () => {
    expect(keysOf(patch("two", "TWO")).get("a.txt")).toBe(keysOf(patch("two", "TWO")).get("a.txt"));
    expect(hashText("a")).not.toBe(hashText("b"));
  });
  test("a changed hunk drops the mark of that file only", () => {
    const marked = Object.fromEntries(keysOf(patch("two", "TWO")));
    const now = viewedPaths(marked, keysOf(patch("two", "TWO again")));
    expect([...now]).toEqual(["b.txt"]);
  });
  test("a file that is not in the diff any more is not counted", () => {
    const marked = { ...Object.fromEntries(keysOf(patch("two", "TWO"))), "gone.txt": "k" };
    expect(viewedPaths(marked, keysOf(patch("two", "TWO"))).size).toBe(2);
  });
  test("a file cut out of the patch is keyed by the list's facts", () => {
    expect(diffKey(file("c.txt"))).toBe(diffKey(file("c.txt")));
    expect(diffKey(file("c.txt"))).not.toBe(diffKey({ ...file("c.txt"), added: 2 }));
  });
});
