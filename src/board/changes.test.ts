// What git says a diff changes, as the board's cards read it.
import { expect, test } from "bun:test";
import { shortstat } from "./board.ts";
import { changeWords } from "./rules.ts";

test("git's one line of a diff is files and lines, and no line is no change", () => {
  expect(shortstat(" 3 files changed, 12 insertions(+), 4 deletions(-)\n")).toEqual({ files: 3, added: 12, removed: 4 });
  expect(shortstat(" 1 file changed, 1 insertion(+)\n")).toEqual({ files: 1, added: 1, removed: 0 });
  expect(shortstat(" 2 files changed, 5 deletions(-)\n")).toEqual({ files: 2, added: 0, removed: 5 });
  expect(shortstat("")).toBeNull();
  expect(changeWords({ files: 1, added: 2, removed: 0 })).toBe("1 file +2 -0");
  expect(changeWords({ files: 200, added: 9, removed: 1, more: true })).toBe("200+ files +9 -1");
});
