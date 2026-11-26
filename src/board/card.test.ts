import { expect, test } from "bun:test";
import { areasOf, isCard, landCard, missingOf, proofOf } from "./card.ts";
import { canLand, type BoardRow } from "./rules.ts";

const HEAD = "a".repeat(40);
const row = (o: Partial<BoardRow> = {}): BoardRow => ({
  id: "ag1", session_id: "s-ag", parent_id: "s-root", depth: 1, title: "Fix the retry", type: "general-purpose", model: "m", state: "completed",
  created: 1000, ended: 2000, machine: null, branch: "keel/fix-retry", repo: "/r", base: "main", head: HEAD, ahead: 2, behind: 1, worktree: "here",
  checks: { state: "known", passed: ["typecheck", "unit"], failed: [], notRun: [] },
  review: { by: "rv1", title: "Review fix", how: "named", state: "completed", verdict: "approved", source: "verdict", line: "tests cover the retry", tip: HEAD, of: HEAD, current: true, at: 3000 },
  reviews: [], landed: { state: "no", missing: 2 }, queue: null, live: null, work: null, together: null, ...o,
});
const card = (r: BoardRow, report = "Done.\n(Checks after its last edit (2 min ago): typecheck passed 1 min ago.)\nLeft: nothing", numstat = "") =>
  landCard({ root: "s-root", title: "Coordinator", row: r, report, numstat, baseTip: "d".repeat(40) });

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
    row({ behind: 2 }),
    row({ ahead: 3 }),
  ]) expect(card(changed).fp).not.toBe(base);
  // The base moved under the same name: what the card says of how far behind it is was read against another commit.
  expect(landCard({ root: "s-root", title: "Coordinator", row: row(), report: "x", numstat: "", baseTip: "e".repeat(40) }).fp).not.toBe(landCard({ root: "s-root", title: "Coordinator", row: row(), report: "x", numstat: "", baseTip: "d".repeat(40) }).fp);
  expect(card(row()).base_tip).toBe("d".repeat(40));
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

test("a branch that fails together with another live branch is not ready, and says with which", () => {
  const red = { with: "keel/other", with_agent: "ag2", head: "h".repeat(40), with_head: "o".repeat(40), base_tip: null, state: "red" as const, why: "test", detail: null, checks: [{ name: "unit", tests: ["stamp keeps bots"] }], error: null, at: 1 };
  const c = card(row({ together: [red, { ...red, with: "keel/green", state: "green", checks: [] }] }));
  expect(c.ready).toBe(false);
  expect(c.together).toEqual(["fails together with keel/other: unit (stamp keeps bots)"]);
  expect(c.missing[0]).toBe("fails together with keel/other: unit (stamp keeps bots)");
  expect(c.fp).not.toBe(card(row({ together: [] })).fp);
});

test("a conflict the forecast names makes the card not ready with a new print, and its clearance makes it ready again", () => {
  const clean = card(row({ forecast: [] }));
  expect([clean.ready, clean.missing, clean.conflicts]).toEqual([true, [], []]);
  expect(canLand(row({ forecast: [] }))).toBe(true);
  // Only the forecast changes: the base now conflicts in one file. The board holds Land back, and so does the card.
  const base = row({ forecast: [{ with: "main", with_agent: null, base: true, files: ["src/a.ts"] }] });
  expect(canLand(base)).toBe(false);
  const held = card(base);
  expect(held.ready).toBe(false);
  expect(held.missing).toEqual(["would conflict with the base main in src/a.ts"]);
  expect(held.fp).not.toBe(clean.fp);
  // Another branch's conflict is its own fact.
  const peer = card(row({ forecast: [{ with: "keel/other", with_agent: "ag2", base: false, files: ["src/b.ts"] }] }));
  expect([peer.ready, peer.missing]).toEqual([false, ["would conflict with keel/other (ag2) in src/b.ts"]]);
  expect(peer.fp).not.toBe(held.fp);
  // The conflict clears: the card is ready on the print it had before.
  const cleared = card(row({ forecast: [] }));
  expect([cleared.ready, cleared.fp]).toEqual([true, clean.fp]);
});

test("a forecast that could not be made is missing evidence, not an answer that nothing conflicts", () => {
  const clean = card(row({ forecast: [] }));
  const unknown = card(row({ forecast: [], forecast_unknown: "the board's time for git ran out" }));
  expect(unknown.ready).toBe(false);
  expect(unknown.missing).toEqual(["the conflict forecast is not known (the board's time for git ran out)"]);
  expect(unknown.fp).not.toBe(clean.fp);
  // Why it is not known is shown, not printed: a merge that waits for the next read is the same fact as one past the time.
  const other = card(row({ forecast: [], forecast_unknown: "the merge with keel/b: not merged yet" }));
  expect([other.ready, other.fp, other.missing]).toEqual([false, unknown.fp, ["the conflict forecast is not known (the merge with keel/b: not merged yet)"]]);
  // Made on a later read and clean: ready again on the print it had.
  expect([card(row({ forecast: [], forecast_unknown: null })).ready, card(row({ forecast: [], forecast_unknown: null })).fp]).toEqual([true, clean.fp]);
});
