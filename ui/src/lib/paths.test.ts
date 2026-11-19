import { expect, test } from "bun:test";
import { inlineMath } from "./mdmath.ts";
import { pathRef } from "./paths.ts";

test("inline code that names a file, with its line", () => {
  expect(pathRef("src/core/store.ts")).toEqual({ path: "src/core/store.ts" });
  expect(pathRef("src/core/store.ts:42")).toEqual({ path: "src/core/store.ts", line: 42 });
  expect(pathRef("src/a.ts:42:7")).toEqual({ path: "src/a.ts", line: 42 });
  expect(pathRef("src/a.ts:10-20")).toEqual({ path: "src/a.ts", line: 10, end: 20 });
  expect(pathRef("src/a.ts#L10-L20")).toEqual({ path: "src/a.ts", line: 10, end: 20 });
  expect(pathRef("store.ts")).toEqual({ path: "store.ts" });
  expect(pathRef("Makefile")).toEqual({ path: "Makefile" });
  expect(pathRef("~/notes/plan.md")).toEqual({ path: "~/notes/plan.md" });
  expect(pathRef("file:///work/x.py:3")).toEqual({ path: "/work/x.py", line: 3 });
});

test("inline code that is code, not a file", () => {
  for (const c of ["this.state", "foo.bar()", "src/**/*.ts", "1.2.3", "a b.ts", "--force", "https://x.dev/a.ts", "x = y.ts", "obj.method", "README.md, notes"]) expect(pathRef(c)).toBeNull();
});

test("inline math follows the dollar rules that keep prices and variables text", () => {
  expect(inlineMath("$O(n)$ time")?.[1]).toBe("O(n)");
  expect(inlineMath("$x$")?.[1]).toBe("x");
  expect(inlineMath("$$T(n) = 2T(n/2)$$ x")).toEqual(["$$T(n) = 2T(n/2)$$", "T(n) = 2T(n/2)", true]);
  expect(inlineMath("\\(a^2\\)")?.[1]).toBe("a^2");
  expect(inlineMath("$5 and $10")).toBeUndefined();
  expect(inlineMath("$ x$")).toBeUndefined();
  expect(inlineMath("$HOME and $PATH")).toBeUndefined();
  expect(inlineMath("$a$5")).toBeUndefined();
});
