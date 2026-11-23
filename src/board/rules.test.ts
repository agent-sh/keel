import { describe, expect, test } from "bun:test";
import { boardText, landedFrom, namedIn, reviewsInput, verdictOf, type Board, type BoardRow } from "./rules.ts";

describe("verdictOf", () => {
  test("a line that says it is the verdict decides, wherever it is", () => {
    expect(verdictOf("I read the diff.\nIt looks fine overall.\n\n**Verdict:** refused. Line 12 breaks the parser.")).toMatchObject({ verdict: "refused", line: "Verdict: refused. Line 12 breaks the parser." });
    expect(verdictOf("## Review\nVerdict: approve, ready to land.")).toMatchObject({ verdict: "approved", line: "Verdict: approve, ready to land." });
    // On the labeled line the plain words count; "not approved" refuses.
    expect(verdictOf("Decision: no").verdict).toBe("refused");
    expect(verdictOf("Verdict - correct").verdict).toBe("approved");
    expect(verdictOf("Verdict: not approved yet").verdict).toBe("refused");
  });
  test("a JSON report is read by its verdict key", () => {
    expect(verdictOf('```json\n{"verdict":"incorrect","summary":"One P1."}\n```')).toMatchObject({ verdict: "refused", line: "verdict: incorrect · One P1." });
    expect(verdictOf('{"approved": true}').verdict).toBe("approved"); // a yes-or-no key
    expect(verdictOf('{"decision": "approve"}').verdict).toBe("approved");
  });
  test("an empty report", () => expect(verdictOf(null)).toMatchObject({ verdict: "unclear", line: "" }));
});

describe("namedIn", () => {
  const cands = [{ branch: "keel/fix-a-1", tip: "abcdef1234567890abcdef1234567890abcdef12" }, { branch: "keel/fix-a", tip: "1111111111111111111111111111111111111111" }];
  test("a branch by its whole name, not inside a longer one", () => {
    expect(namedIn("Review the branch keel/fix-a-1.", cands)).toEqual([{ branch: "keel/fix-a-1", by: "name" }]);
    expect(namedIn("Review keel/fix-a and keel/fix-a-1", cands).map((x) => x.branch).sort()).toEqual(["keel/fix-a", "keel/fix-a-1"]);
    expect(namedIn("Look at keel/fix-a-10 and keel/fix-a/sub", cands)).toEqual([]);
  });
  test("a head by seven or more of its digits", () => {
    expect(namedIn("Review commit abcdef1 please", cands)).toEqual([{ branch: "keel/fix-a-1", by: "head" }]);
    expect(namedIn("abcdef is too short", cands)).toEqual([]);
  });
});

test("reviewsInput", () => {
  expect(reviewsInput("keel/a keel/b, refs/heads/keel/c")).toEqual(["keel/a", "keel/b", "keel/c"]);
  expect(reviewsInput(["x", 3, "-rf"])).toEqual(["x"]);
  expect(reviewsInput("  ")).toBeUndefined();
  expect(reviewsInput(7)).toBeUndefined();
});

describe("landedFrom", () => {
  const head = "h".repeat(40);
  test("the base holds the head, or every one of its patches", () => {
    expect(landedFrom({ head, madeFrom: "m", ancestor: true, cherry: undefined })).toEqual({ state: "yes", how: "ancestor" });
    expect(landedFrom({ head, madeFrom: "m", ancestor: false, cherry: "- aaa\n- bbb\n" })).toEqual({ state: "yes", how: "patch" });
  });
  test("one patch the base lacks is not landed", () => {
    expect(landedFrom({ head, madeFrom: "m", ancestor: false, cherry: "- aaa\n+ bbb\n" })).toEqual({ state: "no", missing: 1 });
  });
  test("a head still at its start made nothing; a failed git is unknown", () => {
    expect(landedFrom({ head, madeFrom: head, ancestor: true, cherry: undefined })).toEqual({ state: "nothing" });
    expect(landedFrom({ head, madeFrom: null, ancestor: null, cherry: undefined }).state).toBe("unknown");
    expect(landedFrom({ head, madeFrom: null, ancestor: false, cherry: undefined }).state).toBe("unknown");
    expect(landedFrom({ head, madeFrom: null, ancestor: false, cherry: "" }).state).toBe("unknown");
  });
});

describe("boardText", () => {
  const row = (o: Partial<BoardRow>): BoardRow => ({
    id: "a1", session_id: "s1", parent_id: "root", depth: 1, title: "Lane", type: "general-purpose", model: "m", state: "completed", created: 1, ended: 2, machine: null,
    branch: "keel/lane", repo: "/r", base: "main", head: "c".repeat(40), ahead: 1, behind: 0, worktree: "gone",
    checks: { state: "known", passed: ["typecheck"], failed: [], notRun: ["unit"] }, review: null, reviews: [],
    landed: { state: "no", missing: 1 }, queue: null, live: null, ...o,
  });
  const board = (rows: BoardRow[]): Board => ({ session_id: "root", rows, total: rows.length, repos: [{ repo: "/r", base: "main", base_tip: "b".repeat(40), deploys: [] }], at: 0, took_ms: 0 });
  test("agents that need the coordinator get a line each, the rest their ids", () => {
    const text = boardText(board([
      row({ id: "work1", state: "running", title: "Working lane", landed: { state: "no", missing: 2 } }),
      row({ id: "refd1", review: { by: "rev1", title: "Review", how: "named", state: "completed", verdict: "refused", line: "Verdict: refused. It breaks X.", tip: "c".repeat(40), of: "c".repeat(40), current: true, at: 3 } }),
      row({ id: "land1", landed: { state: "yes", how: "patch" }, live: { state: "yes", at: "d".repeat(40), how: "after step passed" } }),
      row({ id: "rev1", branch: null, checks: null, landed: null, reviews: ["keel/lane"] }),
      row({ id: "gone1", branch: "keel/gone", head: null, landed: { state: "unknown", why: "its branch is gone" } }),
    ]));
    const lines = text.split("\n");
    expect(lines[0]).toBe("Work board: 5 agents (1 working, 4 done); base main at bbbbbbbbb.");
    // A fact that says nothing (no review, a worktree removed) is left out of a board line.
    expect(lines[1]).toBe('work1 working "Working lane" · keel/lane@ccccccccc · checks passed typecheck; not run unit · not landed (2 commits)');
    expect(lines[2]).toContain('review refused by rev1 ("Review"), reviewer wrote: "Verdict: refused. It breaks X."');
    expect(lines).toContain("Landed (and live where a deploy is known): land1.");
    expect(lines).toContain("Reviewers done: rev1 (keel/lane).");
    expect(lines).toContain("Done, branch removed: gone1.");
    // Small: a coordinator reads it in a few hundred tokens.
    expect(text.length).toBeLessThan(700);
  });
  test("one agent in full", () => {
    const b = board([row({ id: "x1", landed: { state: "yes", how: "ancestor" }, live: { state: "no", at: "d".repeat(40), how: "this daemon" } })]);
    expect(boardText(b, { agent: "x1" })).toBe('x1 done "Lane" · keel/lane@ccccccccc (worktree removed) · checks on its head: passed typecheck; not run unit · review: none · landed on main, not live yet (this daemon at ddddddddd)');
    expect(boardText(b, { agent: "nope" })).toBe("No agent nope on this session's board.");
    // Not landed says what git cannot see; a head the queue landed says it is the queue's word.
    expect(boardText(board([row({ id: "n1" })]), { agent: "n1" })).toContain("not landed (1 commit the base lacks; a squash or edited patches are not seen)");
    expect(boardText(board([row({ id: "q1", landed: { state: "yes", how: "queue" } })]), { agent: "q1" })).toContain("landed by the landing queue (git does not see its patches on main: a squash or edited patches)");
  });
});
