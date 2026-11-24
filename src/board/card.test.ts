import { expect, test } from "bun:test";
import { areasOf, isCard, landCard, missingOf, proofOf } from "./card.ts";
import type { BoardRow } from "./rules.ts";

const HEAD = "a".repeat(40);
const row = (o: Partial<BoardRow> = {}): BoardRow => ({
  id: "ag1", session_id: "s-ag", parent_id: "s-root", depth: 1, title: "Fix the retry", type: "general-purpose", model: "m", state: "completed",
  created: 1000, ended: 2000, machine: null, branch: "keel/fix-retry", repo: "/r", base: "main", head: HEAD, ahead: 2, behind: 1, worktree: "here",
  checks: { state: "known", passed: ["typecheck", "unit"], failed: [], notRun: [] },
  review: { by: "rv1", title: "Review fix", how: "named", state: "completed", verdict: "approved", source: "verdict", line: "tests cover the retry", tip: HEAD, of: HEAD, current: true, at: 3000 },
  reviews: [], landed: { state: "no", missing: 2 }, queue: null, live: null, work: null, ...o,
});
const card = (r: BoardRow, report = "Done.\n(Checks after its last edit (2 min ago): typecheck passed 1 min ago.)\nLeft: nothing", numstat = "") =>
  landCard({ root: "s-root", title: "Coordinator", row: r, report, numstat });

test("a finished branch the base lacks is a card; work in progress, a queued head and a landed branch are not", () => {
  expect(isCard(row())).toBe(true);
  expect(isCard(row({ state: "running" }))).toBe(false);
  expect(isCard(row({ landed: { state: "yes", how: "ancestor" } }))).toBe(false);
  expect(isCard(row({ head: null }))).toBe(false);
  expect(isCard(row({ queue: { id: "q1", state: "checking", why: null, landed: null, tip: HEAD, current: true, updated: 1 } }))).toBe(false);
  // An entry of an older head, or one that left, does not hold this head.
  expect(isCard(row({ queue: { id: "q1", state: "queued", why: null, landed: null, tip: "b".repeat(40), current: false, updated: 1 } }))).toBe(true);
  expect(isCard(row({ queue: { id: "q1", state: "left", why: "unit failed", landed: null, tip: HEAD, current: true, updated: 1 } }))).toBe(true);
});

test("the card carries the checks, the review and the proof line, and says what evidence is missing", () => {
  const c = card(row());
  expect([c.key, c.ready, c.missing, c.proof]).toEqual(["s-root.ag1", true, [], "(Checks after its last edit (2 min ago): typecheck passed 1 min ago.)"]);
  expect(c.checks).toEqual({ state: "known", passed: ["typecheck", "unit"], failed: [], not_run: [] });
  expect(c.review).toMatchObject({ verdict: "approved", by: "rv1", line: "tests cover the retry", current: true });
  expect(card(row({ checks: { state: "known", passed: ["typecheck"], failed: ["unit"], notRun: ["e2e"] }, review: null })).missing)
    .toEqual(["failed: unit", "not run on its head: e2e", "no review"]);
  expect(missingOf({ state: "unknown", why: "no worktree" }, { verdict: "stale", by: "r", title: "", line: "", current: false, panel: false })).toEqual(["the checks are not known (no worktree)", "the review is of an older head"]);
  expect(missingOf({ state: "none" }, { verdict: "words", by: "r", title: "", line: "LAND: yes", current: null, panel: false })).toEqual(["the reviewer gave words only, no verdict"]);
  expect(proofOf("no proof here")).toBe("");
});

test("the print changes with every fact the card shows, and with nothing else", () => {
  const base = card(row()).fp;
  expect(card(row(), "Done.\n(Checks after its last edit (2 min ago): typecheck passed 1 min ago.)\nLeft: nothing", "3\t1\tsrc/a.ts").fp).toBe(base);
  for (const changed of [
    row({ head: "c".repeat(40) }),
    row({ checks: { state: "known", passed: ["typecheck"], failed: ["unit"], notRun: [] } }),
    row({ review: { ...row().review!, verdict: "refused" } }),
    row({ review: { ...row().review!, line: "another reason" } }),
    row({ state: "stopped" }),
  ]) expect(card(changed).fp).not.toBe(base);
  expect(card(row(), "Done.\n(Checks: none ran; it made 2 edits.)").fp).not.toBe(base);
});

test("the size is told by area, the largest first, renames under their new path", () => {
  const numstat = ["120\t4\tsrc/board/card.ts", "30\t0\tsrc/board/card.test.ts", "10\t2\tandroid/app/Wire.kt", "-\t-\tdocs/shot.png", "1\t1\tREADME.md", "5\t5\tui/{old => new}/x.ts", "2\t0\tscripts/a.sh", "garbage"].join("\n");
  expect(areasOf(numstat)).toEqual([
    { area: "src/", files: 2, added: 150, removed: 4 },
    { area: "android/", files: 1, added: 10, removed: 2 },
    { area: "ui/", files: 1, added: 5, removed: 5 },
    { area: "README.md", files: 1, added: 1, removed: 1 },
    { area: "2 more", files: 2, added: 2, removed: 0 },
  ]);
  expect(areasOf("")).toEqual([]);
});
