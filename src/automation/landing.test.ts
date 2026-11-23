import { expect, test } from "bun:test";
import { checksOnTree, landingLines, type Landing } from "./landing.ts";

const base: Landing = { base: "origin/main", tip: "a".repeat(40), behind: 3, dirty: 0, conflict: { state: "clean" }, checks: { state: "none" } };

test("each fact is a line of its own that starts with the same words", () => {
  expect(landingLines(base)).toBe(`\nTip: ${"a".repeat(40)}\nBehind origin/main: 3 commits\nConflicts with origin/main: none, it merges clean\nChecks passed on this tree: none named (the repository names no checks)`);
  const lines = landingLines({ ...base, tip: null, behind: null, conflict: { state: "unknown", why: "no base" }, checks: { state: "unknown", why: "too many files" } }).split("\n").slice(1);
  expect(lines).toEqual(["Tip: not known", "Behind origin/main: not known", "Conflicts with origin/main: not known (no base)", "Checks passed on this tree: not known (too many files)"]);
});

test("a conflict names its files, a few, and says uncommitted files are outside it", () => {
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  expect(landingLines({ ...base, behind: 1, conflict: { state: "conflict", files } })).toContain("\nBehind origin/main: 1 commit\nConflicts with origin/main: yes, 8 files: a, b, c, d, e, f (+2 more)\n");
  expect(landingLines({ ...base, dirty: 2, conflict: { state: "conflict", files: [] } })).toContain("Conflicts with origin/main: yes, in no file git names (a directory renamed on one side) (its commits only: 2 uncommitted files not in it)");
  expect(landingLines({ ...base, conflict: { state: "nothing" } })).toContain("Conflicts with origin/main: none, the base already has its change\n");
});

test("the checks on a tree: the newest decided run of each, a part of a check named with its command, in the repository's order", () => {
  const named = [{ name: "typecheck", run: "tsc" }, { name: "unit", run: "bun test" }, { name: "e2e", run: "playwright test" }, { name: "smoke", run: "smoke.sh" }];
  const got = checksOnTree(named, [
    { name: "unit", command: "bun test", result: "pass", ended: 3 },
    { name: "unit", command: "bun test", result: "fail", ended: 1 },
    { name: "typecheck", command: "tsc", result: "fail", ended: 4 },
    { name: "typecheck", command: "tsc", result: "pass", ended: 2 },
    { name: "e2e", command: "playwright test test/e2e/chat.spec.ts", result: "pass", ended: 5 },
    { name: "smoke", command: "smoke.sh", result: "stopped", ended: 6 },
    { name: "gone", command: "gone", result: "pass", ended: 7 },
  ]);
  expect(got).toEqual({ passed: ["unit", "e2e (`playwright test test/e2e/chat.spec.ts`)"], failed: ["typecheck"], notRun: ["smoke"] });
  expect(landingLines({ ...base, checks: { state: "known", ...got } })).toEndWith("\nChecks passed on this tree: unit, e2e (`playwright test test/e2e/chat.spec.ts`) (failed: typecheck; not run: smoke)");
  expect(landingLines({ ...base, checks: { state: "known", passed: [], failed: [], notRun: ["unit"] } })).toEndWith("Checks passed on this tree: none (not run: unit)");
});
