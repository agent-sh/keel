// Which blocks of a transcript are drawn, and what a block that is not drawn says.
import { expect, test } from "bun:test";
import { plain, windowOf, type Span } from "./window.ts";

// Ten blocks of 500 px each, the first at 0.
const spans: Span[] = Array.from({ length: 10 }, (_, i) => ({ key: i, top: i * 500, bottom: (i + 1) * 500 }));
const none = new Set<number>();

test("the blocks within a view of the view are drawn, and the newest two always", () => {
  // A view of 400 px over block 4.
  const got = windowOf(spans, { top: 2100, bottom: 2500 }, null, none);
  expect([...got].sort((a, b) => a - b)).toEqual([3, 4, 5, 8, 9]);
});

test("a drawn block leaves only when it is three views away, and a pinned one stays", () => {
  const was = new Set([0, 1, 2, 3, 8, 9]);
  // The view moved down to block 5: block 3 is within two views, blocks 0 to 2 are not.
  const got = windowOf(spans, { top: 2600, bottom: 3000 }, was, new Set([0]));
  expect([...got].sort((a, b) => a - b)).toEqual([0, 3, 4, 5, 6, 8, 9]);
});

test("Find looks for the words, not for the marks around them", () => {
  expect(plain("The change is in `notes/plan.md` and **keeps the public surface**.")).toBe("The change is in notes/plan.md and keeps the public surface.");
  expect(plain("See [the guide](https://example.com/x) now")).toBe("See the guide now");
  expect(plain("## Steps\n- one\n- two")).toBe("Steps\none\ntwo");
  expect(plain("| File | Change |\n| --- | --- |\n| a.ts | +4 |").replace(/\s+/g, " ").trim()).toBe("File Change a.ts +4");
});
