import { describe, expect, test } from "bun:test";
import * as R from "./rules.ts";
import { boardText, landedFrom, namedIn, reviewsInput, type Board, type BoardRow } from "./rules.ts";

const A = "01fe3b3a9c0d1e2f3a4b5c6d7e8f901234567890", B = "acd2cc0b1e2f3a4b5c6d7e8f9012345678901234", C = "4b5c6d7e8f9012345678901234567890abcdef12";

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
    landed: { state: "no", missing: 1 }, queue: null, live: null, work: null, together: null, ...o,
  });
  const board = (rows: BoardRow[]): Board => ({ session_id: "root", rows, total: rows.length, repos: [{ repo: "/r", base: "main", base_tip: "b".repeat(40), deploys: [] }], at: 0, took_ms: 0 });
  test("agents that need the coordinator get a line each, the rest their ids", () => {
    const text = boardText(board([
      row({ id: "work1", state: "running", title: "Working lane", landed: { state: "no", missing: 2 } }),
      row({ id: "refd1", review: { by: "rev1", title: "Review", how: "named", state: "completed", verdict: "refused", source: "verdict", line: "It breaks X.", tip: "c".repeat(40), of: "c".repeat(40), current: true, at: 3 } }),
      row({ id: "land1", landed: { state: "yes", how: "patch" }, live: { state: "yes", at: "d".repeat(40), how: "after step passed" } }),
      row({ id: "rev1", branch: null, checks: null, landed: null, reviews: ["keel/lane"] }),
      row({ id: "gone1", branch: "keel/gone", head: null, landed: { state: "unknown", why: "its branch is gone" } }),
    ]));
    const lines = text.split("\n");
    expect(lines[0]).toBe("Work board: 5 agents (1 working, 4 done); base main at bbbbbbbbb.");
    // A fact that says nothing (no review, a worktree removed) is left out of a board line.
    expect(lines[1]).toBe('work1 working "Working lane" · keel/lane@ccccccccc · checks passed typecheck; not run unit · not landed (2 commits)');
    expect(lines[2]).toContain('review refused by rev1 ("Review"), reviewer wrote: "It breaks X."');
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

describe("the heads a task may name by its digits", () => {
  test("not a tip that is where its worktree started, nor one other refs share", () => {
    const cands = [
      { branch: "keel/a", tip: A as string | null, madeFrom: "0".repeat(40) },
      { branch: "keel/same-as-main", tip: C, madeFrom: "0".repeat(40) },
      { branch: "keel/nothing", tip: B, madeFrom: B },
    ];
    const kept = R.matchableTips(cands, [A, C, C]);
    expect(kept.map((c) => c.tip)).toEqual([A, null, null]);
    expect(R.namedIn(`on origin/main ${C.slice(0, 9)}, review ${A.slice(0, 7)}`, kept)).toEqual([{ branch: "keel/a", by: "head" }]);
    expect(R.namedIn("review keel/nothing", kept)).toEqual([{ branch: "keel/nothing", by: "name" }]);
  });
});

describe("landed and live", () => {
  const head = "h".repeat(40);
  test("a head the base holds, with no record of its start, made before the agent started: nothing of its own", () => {
    expect(R.landedFrom({ head, madeFrom: null, ancestor: true, cherry: undefined, headTime: 100, since: 500 })).toEqual({ state: "nothing" });
    expect(R.landedFrom({ head, madeFrom: null, ancestor: true, cherry: undefined, headTime: 900, since: 500 })).toEqual({ state: "yes", how: "ancestor" });
  });
  test("a head the landing queue landed whose patches the base does not show is the queue's word", () => {
    expect(R.queueLanded({ state: "no", missing: 2 }, { state: "landed", current: true })).toEqual({ state: "yes", how: "queue" });
    expect(R.queueLanded({ state: "no", missing: 2 }, { state: "landed", current: false })).toEqual({ state: "no", missing: 2 });
  });
  test("what runs of a repository that builds this daemon is the daemon's revision, never the step that installs it", () => {
    const after = { to_sha: "a".repeat(40), ended: 5 };
    expect(R.deploysOf("d".repeat(40), after)).toEqual([{ sha: "d".repeat(40), how: "this daemon", at: null }]);
    expect(R.deploysOf(null, after)).toEqual([{ sha: "a".repeat(40), how: "after step passed", at: 5 }]);
    expect(R.deploysOf(null, undefined)).toEqual([]);
  });
  test("a landing installed as nothing or as the page alone runs beside the daemon's revision; an engine install does not", () => {
    const own = "d".repeat(40), to = "a".repeat(40);
    for (const kind of ["none", "page"]) expect(R.deploysOf(own, { to_sha: to, ended: 5, after_install: kind })).toEqual([{ sha: own, how: "this daemon", at: null }, { sha: to, how: "after step passed", at: 5 }]);
    for (const kind of ["engine", null, undefined]) expect(R.deploysOf(own, { to_sha: to, ended: 5, after_install: kind })).toEqual([{ sha: own, how: "this daemon", at: null }]);
    expect(R.deploysOf(own, { to_sha: own, ended: 5, after_install: "none" })).toEqual([{ sha: own, how: "this daemon", at: null }]);
  });
  test("live: whichever deploy holds the head", () => {
    const after = { sha: "a".repeat(40), how: "after step passed" as const, at: 1 }, daemon = { sha: "d".repeat(40), how: "this daemon" as const, at: null };
    expect(R.liveFrom([{ deploy: after, holds: { state: "no", missing: 1 } }, { deploy: daemon, holds: { state: "yes", how: "ancestor" } }])).toEqual({ state: "yes", at: daemon.sha, how: "this daemon" });
    expect(R.liveFrom([{ deploy: after, holds: { state: "no", missing: 1 } }])).toEqual({ state: "no", at: after.sha, how: "after step passed" });
  });
});

describe("live of a head the queue landed", () => {
  test("is read from the commit the queue put on the base", () => {
    const fn = (R as Record<string, unknown>).liveSha as ((r: Pick<R.BoardRow, "head" | "landed" | "queue">) => string | null) | undefined;
    expect(typeof fn).toBe("function");
    const q = { id: "q", state: "landed", why: null, landed: "e".repeat(40), tip: "c".repeat(40), current: true, updated: 1 };
    expect(fn!({ head: "c".repeat(40), landed: { state: "yes", how: "queue" }, queue: q })).toBe("e".repeat(40));
    expect(fn!({ head: "c".repeat(40), landed: { state: "yes", how: "patch" }, queue: q })).toBe("c".repeat(40));
  });
});

// UX-S140: the overlap forecast holds Land for the branch it names, and says which branch.
describe("the overlap forecast", () => {
  const tipA = "a".repeat(40);
  const heads = (a: string[] | null, b: string[] | null): R.Meeting[] => [
    { branch: "keel/a", agent: "a1", base: "main", baseFiles: a }, { branch: "keel/b", agent: "b2", base: "main", baseFiles: b },
  ];
  const pair = (files: string[]) => [{ a: "keel/a", b: "keel/b", files }];
  const row = (o: Partial<BoardRow> = {}): BoardRow => ({
    id: "a1", session_id: "s1", parent_id: "root", depth: 1, title: "Lane", type: "general-purpose", model: "m", state: "completed", created: 1, ended: 2, machine: null,
    branch: "keel/a", repo: "/r", base: "main", head: tipA, ahead: 1, behind: 0, worktree: "here",
    checks: { state: "known", passed: ["typecheck"], failed: [], notRun: [] }, review: null, reviews: [],
    landed: { state: "no", missing: 1 }, queue: null, live: null, work: null, together: [], ...o,
  });

  test("a conflict between two branches names the other, from either side of the pair", () => {
    const m = R.forecastFrom(heads(null, null), pair(["notes.md"]));
    expect(m.get("keel/a")).toEqual([{ with: "keel/b", with_agent: "b2", base: false, files: ["notes.md"] }]);
    expect(m.get("keel/b")).toEqual([{ with: "keel/a", with_agent: "a1", base: false, files: ["notes.md"] }]);
  });
  test("a conflict with the base names the base and its files", () => {
    const m = R.forecastFrom(heads(["notes.md"], null), []);
    expect(m.get("keel/a")).toEqual([{ with: "main", with_agent: null, base: true, files: ["notes.md"] }]);
    expect(m.has("keel/b")).toBe(false);
  });
  test("a file a branch conflicts with the base in is the base's, not where two branches meet", () => {
    const m = R.forecastFrom(heads(["notes.md"], null), pair(["notes.md"]));
    expect(m.get("keel/a")?.map((f) => f.with)).toEqual(["main"]);
    expect(m.has("keel/b")).toBe(false);
    // Another file of the pair still is.
    expect(R.forecastFrom(heads(["notes.md"], null), pair(["notes.md", "b.ts"])).get("keel/b")).toEqual([{ with: "keel/a", with_agent: "a1", base: false, files: ["b.ts"] }]);
    // A conflict git names no file for is kept.
    expect(R.forecastFrom(heads(null, null), pair([])).get("keel/a")).toHaveLength(1);
  });
  test("a branch the forecast could not read whole says why: its own line, or a pair not made", () => {
    const g = R.forecastGaps(["keel/a", "keel/b", "keel/c", "keel/d"], [null, "the merge with the base: git's merge failed", null, "past the 64 branches the forecast reads"], [
      { a: "keel/a", b: "keel/c", why: "not merged yet" }, { a: "keel/a", b: "keel/b", why: null },
    ]);
    expect(Object.fromEntries(g)).toEqual({
      "keel/a": "the merge with keel/c: not merged yet",
      "keel/b": "the merge with the base: git's merge failed",
      "keel/c": "the merge with keel/a: not merged yet",
      "keel/d": "past the 64 branches the forecast reads",
    });
    expect(R.forecastGaps(["keel/a", "keel/b"], [null, null], [{ a: "keel/a", b: "keel/b", why: null }]).size).toBe(0);
  });
  test("the caps count merges no earlier read made, ended rows first, so a busy repository's ended rows fill in", () => {
    // 30 unlanded branches, the first ten of them live: 20 ended rows, 390 pairs with an ended side.
    const rows = Array.from({ length: 30 }, (_, i) => ({ head: `h${i}`, ended: i >= 10 }));
    const caps = { rows: 64, base: 24, pairs: 80 };
    const made = new Set<string>();
    const key = (x: string, y: string) => (x < y ? `${x} ${y}` : `${y} ${x}`);
    let reads = 0, whole = false;
    while (!whole && reads < 6) {
      reads++;
      const p = R.forecastPlan(rows, caps, (h) => made.has(h), (x, y) => made.has(key(x, y)));
      expect(p.open.slice(0, 20).every((i) => rows[i]!.ended)).toBe(true);
      p.open.forEach((i, k) => { if (!p.base[k]) made.add(rows[i]!.head); });
      for (const q of p.pairs) if (!q.why) made.add(key(rows[p.open[q.a]!]!.head, rows[p.open[q.b]!]!.head));
      const branches = p.open.map((i) => `b${i}`);
      const gaps = R.forecastGaps(branches, p.base, p.pairs.map((q) => ({ a: branches[q.a]!, b: branches[q.b]!, why: q.why })));
      whole = p.open.every((i, k) => !rows[i]!.ended || !gaps.has(branches[k]!));
    }
    expect([whole, reads]).toEqual([true, 5]);
    // A read after them makes no merge: every answer is kept.
    const after = R.forecastPlan(rows, caps, (h) => made.has(h), (x, y) => made.has(key(x, y)));
    expect([after.base.every((w) => w === null), after.pairs.every((q) => q.why === null)]).toEqual([true, true]);
  });
  test("Land is offered with no conflict and held with one", () => {
    expect(R.canLand(row())).toBe(true);
    expect(R.canLand(row({ forecast: [] }))).toBe(true);
    const held = row({ forecast: R.forecastFrom(heads(null, null), pair(["notes.md"])).get("keel/a") });
    expect(R.canLand(held)).toBe(false);
    expect(R.rowLine(held)).toContain("would conflict with keel/b (b2)");
    expect(R.rowLine(held, true)).toContain("would conflict with keel/b (b2) in notes.md");
  });
});

// UX-S170: the hover card's one Work line.
describe("workLine", () => {
  const row = (o: Partial<BoardRow> = {}): BoardRow => ({
    id: "a1", session_id: "s1", parent_id: "root", depth: 1, title: "Lane", type: "general-purpose", model: "m", state: "completed", created: 1, ended: 2, machine: null,
    branch: "keel/a", repo: "/r", base: "main", head: "a".repeat(40), ahead: 1, behind: 0, worktree: "here",
    checks: { state: "known", passed: ["typecheck"], failed: [], notRun: [] }, review: null, reviews: [],
    landed: { state: "no", missing: 1 }, queue: null, live: null, work: { uncommitted: null, branch: { files: 3, added: 12, removed: 4 } }, together: [], ...o,
  });
  test("one branch: its name, its change, its checks and that nothing is left but the landing", () => {
    expect(R.workLine([row()])).toBe("keel/a, 3 files +12 -4, checks green on this tree, ready to land");
  });
  test("a failed check is named, and the branch is not ready", () => {
    expect(R.workLine([row({ checks: { state: "known", passed: [], failed: ["unit"], notRun: [] } })])).toBe("keel/a, 3 files +12 -4, unit failed on this tree");
  });
  test("no branch says nothing", () => {
    expect(R.workLine([row({ branch: null, checks: null, landed: null, work: null })])).toBeNull();
    expect(R.workLine([])).toBeNull();
  });
  test("several branches are counted together", () => {
    const b = row({ branch: "keel/b", session_id: "s2", id: "b2", work: { uncommitted: null, branch: { files: 1, added: 2, removed: 0 } } });
    expect(R.workLine([row(), b])).toBe("2 branches, 4 files +14 -4, checks green on every tree, 2 of 2 ready to land");
    expect(R.workLine([row(), row({ branch: "keel/c", state: "running", landed: { state: "no", missing: 1 } })])).toContain("1 of 2 ready to land");
  });
});
