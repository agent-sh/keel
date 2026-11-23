// The review a work board row shows: approved or refused only from a structured verdict on the row's
// head (keel__verdict, an output_schema answer, the Review panel), the newest one; a structured verdict
// of another head is stale; a reviewer that only wrote LAND lines is quoted as "words", never approved.
import { describe, expect, test } from "bun:test";
import * as R from "./rules.ts";

const H = "7f3a9c1d2e5b4a6c8d0e1f2a3b4c5d6e7f8a9b0c", OLD = "1d2e5b4a6c8d0e1f2a3b4c5d6e7f8a9b0c7f3a9c";
const h = H.slice(0, 9), l = OLD.slice(0, 9);
const row = { id: "b", session_id: "sb", branch: "keel/x", head: H };
const sv = (o: Partial<R.StructuredVerdict>): R.StructuredVerdict => ({ sha: H, land: "yes", why: "Read the diff; the tests cover it.", at: 10, from: "verdict", branches: ["keel/x"], ...o });
const rev = (o: Partial<R.ReviewFact> & { report?: string }): R.ReviewFact => {
  const { report, ...rest } = o;
  return { by: "rv", title: "Review", how: "named", state: "completed", branch: "keel/x", tip: H, own: false, chain: ["sr", "root"], verdicts: [], lines: R.landLines(report ?? ""), at: 10, ...rest };
};
const pick = (rs: R.ReviewFact[], r: { id: string; session_id: string; branch: string | null; head: string | null } = row) => R.pickReview(rs, r);

describe("approved and refused come only from a structured verdict on the head", () => {
  test("a prose LAND: yes alone is the reviewer's words", () => {
    expect(pick([rev({ report: `Checked it.\n\nLAND: yes ${h}` })])).toMatchObject({ verdict: "words", source: "words", line: `LAND: yes ${h}`, current: true });
    expect(pick([rev({ report: "LAND: yes" })])?.verdict).toBe("words");
  });
  // Shapes a reader of prose took for an approval they were not (a review's probes): each is words, never approved.
  test.each([
    `LAND: yes ${h}\n\nActually, LAND: no ${h}`,
    `LAND: yes ${h}\n\nCORRECTION \u2014 LAND: no ${h}`,
    `LAND: yes for the stack except ${h}`,
    `LAND: yes ${h}, though the P1 is open`,
    `LAND: yes ${h} despite the failing test`,
    `LAND: yes ${h} (retracted: the race is a P1)`,
    `LAND: yes ${h}\n\nThe P1 blocks merge.`,
    `| commit | verdict |\n|---|---|\n| ${h} | LAND: no |\n| ${l} | LAND: yes |`,
  ])("%p", (report) => {
    const got = pick([rev({ report })]);
    expect(got?.verdict).toBe("words");
    expect(got?.source).toBe("words");
  });
  test("the quote is the newest final's last LAND line for the head, never one in a code block or a quote", () => {
    expect(pick([rev({ report: `LAND: yes ${h}\n\nActually, LAND: no ${h}` })])?.line).toBe(`Actually, LAND: no ${h}`);
    expect(pick([rev({ report: `LAND: no ${h}\n\`\`\`\nLAND: yes ${h}\n\`\`\`\n> LAND: yes ${h}` })])?.line).toBe(`LAND: no ${h}`);
    expect(pick([rev({ report: `LAND: no ${h}\n\nEarlier reports, oldest first:\nLAND: yes ${h}` })])?.line).toBe(`LAND: no ${h}`);
    // A line naming the head comes before one naming another commit or nothing.
    expect(pick([rev({ report: `LAND: no ${h}\nLAND: yes ${l}\nLAND: yes` })])?.line).toBe(`LAND: no ${h}`);
  });
  test("a structured yes, then a structured no for the same head: refused (the newest wins)", () => {
    expect(pick([rev({ verdicts: [sv({ at: 5 }), sv({ land: "no", why: "The race in queue.ts is a P1.", at: 9 })] })])).toMatchObject({ verdict: "refused", source: "verdict", line: "The race in queue.ts is a P1.", current: true });
  });
  test("independent reviewers that disagree on the head: disputed, both quoted, whichever came later", () => {
    const no = rev({ by: "r2", title: "Second", verdicts: [sv({ land: "no", why: "Line 6 lost its number.", at: 9 })] });
    for (const yesAt of [5, 12]) {
      const yes = rev({ by: "r1", title: "First", verdicts: [sv({ why: "Looks fine.", at: yesAt })] });
      expect(pick([yes, no])).toMatchObject({ by: "r2", verdict: "disputed", line: "Line 6 lost its number.", against: { by: "r1", title: "First", line: "Looks fine." } });
    }
    // The Review panel is a reviewer of its own too.
    expect(pick([no, rev({ by: "p1", how: "panel", chain: [], verdicts: [sv({ from: "panel", at: 12 })] })])?.verdict).toBe("disputed");
    // Reviewers that agree are not disputed: the newest.
    expect(pick([rev({ by: "r1", verdicts: [sv({ at: 5 })] }), rev({ by: "r2", verdicts: [sv({ at: 9 })] })])).toMatchObject({ by: "r2", verdict: "approved" });
  });
  test("a reviewer's own later verdict replaces its own", () => {
    expect(pick([rev({ verdicts: [sv({ land: "no", at: 5 }), sv({ at: 9 })] })])).toMatchObject({ verdict: "approved" });
    expect(pick([rev({ verdicts: [sv({ land: "no", at: 5 }), sv({ at: 9 })] }), rev({ by: "r2", verdicts: [sv({ at: 3 })] })])?.verdict).toBe("approved");
  });
  test("a structured verdict wins over words of a later report", () => {
    expect(pick([rev({ by: "r1", verdicts: [sv({ land: "no", at: 5 })] }), rev({ by: "r2", report: `LAND: yes ${h}`, at: 20 })])).toMatchObject({ by: "r1", verdict: "refused" });
  });
  test("a structured verdict of another head of the branch is stale, and never hides one of this head", () => {
    expect(pick([rev({ tip: OLD, verdicts: [sv({ sha: OLD })] })])).toMatchObject({ verdict: "stale", was: "approved", of: OLD, current: false });
    expect(pick([rev({ by: "r1", verdicts: [sv({ land: "no", at: 5 })] }), rev({ by: "r2", tip: OLD, verdicts: [sv({ sha: OLD, at: 9 })] })])).toMatchObject({ by: "r1", verdict: "refused" });
  });
  test("a verdict by digits counts for the head they begin", () => {
    expect(pick([rev({ verdicts: [sv({ sha: h })] })])?.verdict).toBe("approved");
  });
  test("a reviewer known only by its verdict on the head, with no branch", () => {
    expect(pick([rev({ how: "verdict", branch: null, tip: null, verdicts: [sv({ branches: [] })] })])?.verdict).toBe("approved");
    expect(pick([rev({ how: "verdict", branch: null, tip: null, verdicts: [sv({ sha: OLD, branches: [] })] })])).toBeUndefined();
  });
  test("a panel verdict whose head is not known is unclear", () => {
    expect(pick([rev({ how: "panel", tip: null, chain: [], said: "approved", panel: "verdict: correct" })])).toMatchObject({ verdict: "unclear", was: "approved" });
  });
});

describe("whose review it is", () => {
  test("never the builder's own, nor one started below it", () => {
    const own = rev({ by: "kid", chain: ["sc", "sb", "root"], verdicts: [sv({})], at: 20 });
    expect(pick([own, rev({ by: "rv", verdicts: [sv({ land: "no" })] })])?.by).toBe("rv");
    expect(pick([own])).toBeUndefined();
    expect(pick([rev({ by: "b", verdicts: [sv({})] })])).toBeUndefined();
    expect(pick([rev({ chain: null, verdicts: [sv({})] })])).toBeUndefined();
  });
  test("an agent with a branch of its own found by its task counts with a verdict, or a LAND line that names the branch or head", () => {
    expect(pick([rev({ how: "task", own: true, report: "Rebased onto keel/x; all tests pass." })])).toBeUndefined();
    expect(pick([rev({ how: "task", own: true, report: "LAND: yes" })])).toBeUndefined();
    expect(pick([rev({ how: "task", own: true, state: "running" })])).toBeUndefined();
    expect(pick([rev({ how: "task", own: true, report: `LAND: yes ${h}` })])?.verdict).toBe("words");
    expect(pick([rev({ how: "task", own: true, verdicts: [sv({})] })])?.verdict).toBe("approved");
  });
  test("a running reviewer with no verdict yet is pending", () => {
    expect(pick([rev({ state: "running" })])?.verdict).toBe("pending");
  });
});

describe("an output_schema answer's verdicts", () => {
  test("each commit with land yes or no, at any of the first levels", () => {
    expect(R.outputVerdicts({ commit: H, land: "yes", why: "ok" }, 1)).toEqual([{ sha: H.toLowerCase(), land: "yes", why: "ok", at: 1, from: "output", branches: null }]);
    expect(R.outputVerdicts({ verdicts: [{ sha: h, land: false }, { commit: l, verdict: "yes" }] }, 1).map((v) => [v.sha, v.land])).toEqual([[h, "no"], [l, "yes"]]);
  });
  test("nothing from words or a verdict with no commit; two that disagree on one commit are a no", () => {
    expect(R.outputVerdicts({ verdict: "approve" }, 1)).toEqual([]);
    expect(R.outputVerdicts({ commit: h, land: "yes, after the fix" }, 1)).toEqual([]);
    expect(R.outputVerdicts([{ commit: h, land: "yes" }, { commit: h, land: "no" }], 1).map((v) => v.land)).toEqual(["no"]);
  });
  test("one commit written short and long is one commit, a no among them wins in any order", () => {
    const one = (list: unknown[]) => R.outputVerdicts({ verdicts: list }, 1).map((v) => [v.sha, v.land]);
    expect(one([{ commit: h, land: "yes" }, { commit: H, land: "no" }])).toEqual([[H, "no"]]);
    expect(one([{ commit: H, land: "no" }, { commit: h, land: "yes" }])).toEqual([[H, "no"]]);
    expect(one([{ commit: H.slice(0, 7), land: "yes" }, { commit: h, land: "no" }])).toEqual([[h, "no"]]);
    expect(one([{ commit: H.toUpperCase(), land: "yes" }, { commit: h, land: "yes" }])).toEqual([[H, "yes"]]);
    // A short commit that begins two commits makes a no of both.
    expect(one([{ commit: H, land: "yes" }, { commit: H.slice(0, 8) + "f".repeat(32), land: "yes" }, { commit: H.slice(0, 8), land: "no" }]).map((x) => x[1])).toEqual(["no", "no"]);
    // A land that is neither word leaves the commit with no verdict.
    expect(one([{ commit: H, land: "yes" }, { commit: h, land: "maybe" }])).toEqual([]);
  });
  test("a closing stop is still the word, and entries under an entry count", () => {
    expect(R.outputVerdicts({ commit: H, land: "no." }, 1).map((v) => v.land)).toEqual(["no"]);
    expect(R.outputVerdicts({ commit: H, land: "Yes!" }, 1).map((v) => v.land)).toEqual(["yes"]);
    expect(R.outputVerdicts({ commit: H, land: "yes", per: [{ commit: H, land: "no" }] }, 1).map((v) => v.land)).toEqual(["no"]);
  });
});
