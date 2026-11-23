// The work board's reading of real review reports (shapes taken from reviewer reports, names scrubbed),
// the pick of a branch's review, the heads a task may name by digits, landed and live.
import { describe, expect, test } from "bun:test";
import * as R from "./rules.ts";

const A = "01fe3b3a9c0d1e2f3a4b5c6d7e8f901234567890"; // heads, by their first digits in the reports
const B = "acd2cc0b1e2f3a4b5c6d7e8f9012345678901234";
const C = "4b5c6d7e8f9012345678901234567890abcdef12";
const v = (report: string, heads: (string | null)[] = [], branch?: string) => R.verdictOf(report, { heads, branch }).verdict;

describe("a reviewer's LAND line decides, before any prose", () => {
  test("words in the findings never decide", () => {
    expect(v("LAND: no\n\nFindings: the parser accepts bad input; fix it.")).toBe("refused");
    expect(v("**LAND: yes**\n\n- none of the P3s blocks landing")).toBe("approved");
    expect(v("LAND: no\n\nOne regression on the New session box blocks it; the fix is one line.")).toBe("refused");
    expect(v("LAND: no   (P1-a below; small fix, then yes)")).toBe("refused");
  });
  test("prose with no labelled line is unclear", () => {
    expect(v("Built it; all tests pass. LGTM from me, ready to land.")).toBe("unclear");
    expect(v("I could not review: the branch is blocked on a missing file.")).toBe("unclear");
    expect(v("The tests pass.\nI found one problem in the queue.")).toBe("unclear");
  });
  test("a labelled verdict line still decides", () => {
    expect(R.verdictOf("I read the diff.\n\n**Verdict:** refused. Line 12 breaks the parser.")).toEqual({ verdict: "refused", line: "Verdict: refused. Line 12 breaks the parser." });
    expect(v("Decision: approve; the P2 can follow.")).toBe("approved");
  });
  test("per commit: the verdict for this row's head, else mixed", () => {
    const list = "LAND per commit:\n\n- 01fe3b3 FEAT-S01 (count the request): `LAND: yes`, with P2-1\n- acd2cc0 FEAT-S02: `LAND: no` (P1-1)\n\nNo other findings.";
    expect(v(list, [A])).toBe("approved");
    expect(v(list, [B])).toBe("refused");
    expect(v(list, [C])).toBe("mixed");
    expect(R.verdictOf(list, { heads: [B] }).line).toBe("acd2cc0 FEAT-S02: LAND: no (P1-1)");
  });
  test("a table, headings over the LAND line, and one line with two verdicts", () => {
    const table = "| Commit | Lane | Verdict |\n| --- | --- | --- |\n| 01fe3b3 | scratch folder | LAND: yes |\n| acd2cc0 | FEAT-M02 | **LAND: no** — one P1 |";
    expect(v(table, [A])).toBe("approved");
    expect(v(table, [B])).toBe("refused");
    const sections = "## acd2cc0 FEAT-M07 diff lines\nLAND: no. It is independent of the other five.\n\n## 01fe3b3 FEAT-S04 image button\nLAND: yes\n\n- P2, ring nearly invisible";
    expect(v(sections, [A])).toBe("approved");
    expect(v(sections, [B])).toBe("refused");
    expect(v("LAND: yes for 01fe3b3, no for acd2cc0", [B])).toBe("refused");
    expect(v("LAND: yes for 01fe3b3, no for acd2cc0", [A])).toBe("approved");
  });
  test("the newest final comes first; an earlier one's list does not override it", () => {
    const r = "LAND: no (4b5c6d7e). The engine writes the wrong order.\n\nEarlier reports, oldest first:\n- `4b5c6d7` FEAT-S35: LAND: yes\n- `01fe3b3` FEAT-S10: LAND: yes on its own";
    expect(v(r, [C])).toBe("refused");
    expect(v(r, [A])).toBe("approved");
  });
  test("the head the reviewer was started on, or the branch by name, decides when the head moved", () => {
    expect(v("## 4b5c6d7 FEAT-S03 — LAND: yes\n- Claim holds.", ["f".repeat(40), C])).toBe("approved");
    expect(v("**LAND: yes** (branch `keel/crash-safe-c5bc90` at 99aa88b)\n**LAND: no** (branch `keel/other-1` at 77cc66d)", ["f".repeat(40)], "keel/crash-safe-c5bc90")).toBe("approved");
    // A branch named as what it lands after is not the branch the verdict is of.
    expect(v("LAND: no. It needs two changes first, then it can land after keel/a-command-fd975e.", ["f".repeat(40)], "keel/mine")).toBe("refused");
    expect(R.verdictOf("LAND: yes (branch keel/a)\nLAND: no (branch keel/b)", { branch: "keel/c", others: new Set(["keel/a", "keel/b"]) }).verdict).toBe("mixed");
  });
});

describe("pickReview", () => {
  const rev = (o: Partial<R.ReviewFact>): R.ReviewFact => ({ by: "rv", title: "Review", how: "named", state: "completed", branch: "keel/x", tip: null, own: false, read: R.readReport("LAND: yes"), at: 10, ...o });
  // Sessions: the builder b (session sb) under the root; its child c (session sc) under sb; a reviewer r under the root.
  const parents = new Map([["sb", "root"], ["sc", "sb"], ["sr", "root"]]);
  const agentOf = new Map([["rv", "sr"], ["kid", "sc"]]);
  const row = { id: "b", session_id: "sb", branch: "keel/x", head: null };
  const lineage = { parentOf: (s: string) => parents.get(s), sessionOf: (id: string) => agentOf.get(id) };
  test("a review started by the builder (or its children) of the branch is not its review", () => {
    const own = rev({ by: "kid", at: 20 });
    const got = R.pickReview([own, rev({ by: "rv", read: R.readReport("LAND: no") })], row, lineage);
    expect(got?.by).toBe("rv");
    expect(R.pickReview([own], row, lineage)).toBeUndefined();
  });
  test("an agent with a branch of its own counts by its task only when a labelled line decides and it ended", () => {
    expect(R.pickReview([rev({ how: "task", own: true, read: R.readReport("Rebased onto keel/x; all tests pass.") })], row, lineage)).toBeUndefined();
    expect(R.pickReview([rev({ how: "task", own: true, state: "running", read: R.readReport("") })], row, lineage)).toBeUndefined();
    expect(R.pickReview([rev({ how: "task", own: true, read: R.readReport("LAND: no") })], row, lineage)?.by).toBe("rv");
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
  test("live: whichever deploy holds the head", () => {
    const after = { sha: "a".repeat(40), how: "after step passed" as const, at: 1 }, daemon = { sha: "d".repeat(40), how: "this daemon" as const, at: null };
    expect(R.liveFrom([{ deploy: after, holds: { state: "no", missing: 1 } }, { deploy: daemon, holds: { state: "yes", how: "ancestor" } }])).toEqual({ state: "yes", at: daemon.sha, how: "this daemon" });
    expect(R.liveFrom([{ deploy: after, holds: { state: "no", missing: 1 } }])).toEqual({ state: "no", at: after.sha, how: "after step passed" });
  });
});
