// The work board says approved only when a report is unambiguous for the row's head: any doubt reads
// mixed or unclear (cases from a review's probes of real report shapes and the ways prose goes wrong).
import { describe, expect, test } from "bun:test";
import * as R from "./rules.ts";

const A = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0", B = "b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1";
const s9 = (x: string) => x.slice(0, 9);
const pad = (x: string) => x.padEnd(40, "0");
// (`heads` too, so the same case runs on the reader before this change.)
const ask = (head?: string, tip?: string) => ({ head, tip, heads: [head, tip] }) as R.VerdictAsk;
const v = (report: string, head?: string, tip?: string) => R.verdictOf(report, ask(head, tip)).verdict;
const DASH = "\u2014";

describe("a mark counts only where a verdict is written, not in a sentence about one", () => {
  test("after a negation, a modal or inside a sentence", () => {
    expect(v("I reviewed it. We cannot say LAND: yes until the P1 is fixed.\nThe race in queue.ts is real.")).toBe("unclear");
    expect(v("Not ready. LAND: yes would need the test added first.")).toBe("unclear");
    expect(v("My verdict is that I would write LAND: yes only after rebase; right now it fails to build.")).toBe("unclear");
    expect(v("NOT LAND: yes")).toBe("unclear");
    expect(v("The brief says to end with `LAND: yes` or `LAND: no`. I ran out of budget.")).toBe("unclear");
    expect(v("Report format: first line per commit: LAND: yes or LAND: no.\nFindings: P1 data loss.")).toBe("unclear");
  });
  test("inside a code fence or a quote", () => {
    expect(v("> LAND: yes\n\n(the earlier reviewer said that; I disagree, the lock is wrong.)\n\nLAND: no")).toBe("refused");
    expect(v("The earlier review said:\n> LAND: yes\nI could not finish: the daemon crashed.")).toBe("unclear");
    expect(v("Previous reviewer output:\n```\nLAND: yes\n```\nMy own: still reading, no verdict.")).toBe("unclear");
  });
  test("a template, or a yes with a condition", () => {
    expect(v("LAND: yes/no")).toBe("unclear");
    expect(v("LAND: yes, but only if the daemon is restarted first (P1).")).toBe("unclear");
    expect(v("LAND: yes once the P2 is fixed")).toBe("unclear");
    expect(v("LAND: yes until we see the flake again")).toBe("unclear");
  });
  test("a follow-up is not a condition; a later sentence that holds a commit holds that one", () => {
    expect(v(`LAND: yes ${DASH} ${s9(A)} (one diff block): P3s only.`, A)).toBe("approved");
    expect(v(`LAND: yes ${DASH} ${s9(A)} (its output by its call), with P2-6 fixed right after.`, A)).toBe("approved");
    expect(v("LAND: yes. Fix the three P2s right after landing.")).toBe("approved");
    const two = `${s9(A)}, ${s9(B)}: LAND: yes. ${s9(B)} can only land once c121c2af does.`;
    expect(v(two, A)).toBe("approved");
    expect(v(two, B)).not.toBe("approved");
    expect(v(`- \`${s9(A)}\` FEAT-S10: LAND: yes on its own merits; it is stacked on ${s9(B)}, and the P1 fix reuses it, so it lands with that fix on top`, A)).not.toBe("approved");
    expect(v(`- **${s9(A)}** (first valve fix): LAND: yes, as part of that series.`, A)).not.toBe("approved");
    expect(v(`LAND: yes ${DASH} \`${s9(A)}\`, \`${s9(B)}\` (question card): must land together, since \`${s9(B)}\` closes their P1-1.`, A)).not.toBe("approved");
    expect(v(`- **LAND: yes for \`${s9(A)}\` with \`${s9(B)}\`.** It depends on the producer introduced by \`${s9(B)}\`.`, A)).not.toBe("approved");
    expect(v(`LAND: yes for ${s9(A)} and ${s9(B)}, as one stack. The lane commit must not land without ${s9(B)}.`, A)).not.toBe("approved");
    expect(v(`- LAND: yes - \`${s9(A)}\` (no swap, swap line). It sits on \`${s9(B)}\`; checked only through its specs.`, A)).not.toBe("approved");
  });
  test("the shapes reviewers write still read", () => {
    expect(v(`## 60bfe11 FEAT-S08 ${DASH} LAND: yes`, pad("60bfe11"))).toBe("approved");
    expect(v("**FEAT-M03 (ca64fad) LAND: yes**", pad("ca64fad"))).toBe("approved");
    expect(v(`## 7c6d031 FEAT-M01 ${DASH} LAND: yes (fix the P2 in the same push)`, pad("7c6d031"))).toBe("approved");
    expect(v(`| cab5a90 FEAT-M02 | **LAND: no** ${DASH} one P1 on the fetch path |`, pad("cab5a90"))).toBe("refused");
    expect(v("- **e9dcc23 (FEAT-S02): LAND: yes**", pad("e9dcc23"))).toBe("approved");
    expect(v("## cdb90ca FEAT-M08 (outbox drain and retry): LAND: yes", pad("cdb90ca"))).toBe("approved");
    expect(v("LAND: yes\n\nP2: the label is long.")).toBe("approved");
  });
});

describe("marks that disagree read mixed", () => {
  test("a correction in the same report", () => {
    expect(v("LAND: yes\n\n...later, after rereading:\n\nCORRECTION: LAND: no. I missed a P1 in queue.ts:40.")).toBe("mixed");
    expect(v("LAND: yes\n\nP2 foo\n\nUpdate: I found a P1.\nLAND: no")).toBe("mixed");
    expect(v("LAND: no\n\nUpdate after fix.\nLAND: yes")).toBe("mixed");
    expect(v("LAND: yes\n\n## Correction (appended)\nLAND: no")).toBe("mixed");
    expect(v(`**LAND: yes** ${DASH} wait, I misread the diff. LAND: no.`)).not.toBe("approved");
    expect(v("LAND: yes\n(scratch that, retracting: LAND: no)")).not.toBe("approved");
  });
  test("a table of what-ifs, and a labelled line against a mark", () => {
    expect(v("| if | verdict |\n| tests pass | LAND: yes |\n| tests fail | LAND: no |")).toBe("mixed");
    expect(v("Verdict: refused\nLAND: yes")).toBe("mixed");
  });
  test("marks naming this head that disagree", () => {
    expect(v(`- ${s9(A)}: LAND: yes\n- ${s9(A)}: LAND: no (P1 in the retry)`, A)).toBe("mixed");
  });
  test("the newest final first only across the harness's own separator", () => {
    expect(v("Earlier report (superseded):\nLAND: yes\n\nFinal:\nLAND: no")).toBe("mixed");
    expect(v("LAND: no\n\nEarlier reports, oldest first:\n\nLAND: yes")).toBe("refused");
    expect(v("LAND: yes\n\nEarlier reports, oldest first:\n\nLAND: no")).toBe("approved");
  });
});

describe("a mark's subject is the first commit on its line", () => {
  test("commits after a dependency word are not what it is said of", () => {
    const relies = "decadc97e Read and approve a plan on the phone: LAND: yes (the read gate it relies on is fixed in 83c198489)";
    expect(v(relies, pad("83c198489"))).not.toBe("approved");
    expect(v(relies, pad("decadc97e"))).toBe("approved");
    expect(v("0f1c04747: LAND: yes, only together with 08249acf9.", pad("08249acf9"))).not.toBe("approved");
    expect(v(`LAND: yes, only after a564e00b ${DASH} 50489ceb (import preview).`, pad("a564e00b"))).not.toBe("approved");
    expect(v(`LAND: yes ${s9(A)} (builds on ${s9(B)})`, B)).not.toBe("approved");
    expect(v(`LAND: yes ${s9(A)} (builds on ${s9(B)})`, A)).toBe("approved");
    // A stacked commit's yes waits for its base: unsure for both.
    expect(v(`LAND: yes ${s9(A)} (stacked on ${s9(B)})`, A)).toBe("unclear");
    expect(v(`LAND: yes ${s9(A)} (stacked on ${s9(B)})`, B)).not.toBe("approved");
  });
  test("yes on and no for name what the verdict is of", () => {
    const r = `LAND: yes on ${s9(A)} (FEAT-M03). None of the P2s blocks landing.\nLAND: no on ${s9(B)} (FEAT-S40)`;
    expect(v(r, A)).toBe("approved");
    expect(v(r, B)).toBe("refused");
  });
  test("a list of commits right after the first is said of each", () => {
    expect(v(`LAND: yes for ${s9(A)}, ${s9(B)}`, B)).toBe("approved");
  });
});

describe("JSON and labelled lines", () => {
  test("land and verdict first; status and result only when they are the only keys", () => {
    expect(v('{"status":"ok","land":"no","findings":["P1 data loss"]}')).toBe("refused");
    expect(v('{"result":"tests passed","land":"no"}')).toBe("refused");
    expect(v('{"status":"ok","summary":"ran the tests"}')).toBe("unclear");
    expect(v('{"status":"approved"}')).toBe("approved");
  });
  test("a labelled line with a condition is unclear; outcome and result are not labels", () => {
    expect(v("Outcome: all tests pass, but the lock is wrong (P1).")).toBe("unclear");
    expect(v("Result: pass")).toBe("unclear");
    expect(v("Verdict: not LGTM")).not.toBe("approved");
    expect(v("Recommendation: approve once the P1 in queue.ts is fixed")).toBe("unclear");
    expect(v("Verdict: approved after the P1 is fixed")).toBe("unclear");
    expect(v("Decision: no P1s, approve")).not.toBe("approved");
  });
});

describe("a review of another head is stale, and reviews of this head come first", () => {
  const H = "c1".repeat(20), OLD = "d2".repeat(20);
  const rev = (o: Partial<R.ReviewFact>): R.ReviewFact => ({ by: "rv", title: "Review", how: "named", state: "completed", branch: "keel/x", tip: H, own: false, read: R.readReport("LAND: yes"), at: 10, chain: ["sr", "root"], ...o });
  const row = { id: "b", session_id: "sb", branch: "keel/x", head: H };
  const pick = (rs: R.ReviewFact[]) => (R.pickReview as (...a: unknown[]) => R.BoardReview | undefined)(rs, row, { parentOf: () => undefined, sessionOf: () => undefined });
  test("an approval of an older head is stale", () => {
    const got = pick([rev({ tip: OLD })]);
    expect(got?.verdict).toBe("stale");
    expect(got?.current).toBe(false);
  });
  test("a mark naming only the head the reviewer started on, after the head moved, is stale", () => {
    expect(pick([rev({ tip: OLD, read: R.readReport(`## ${s9(OLD)} FEAT-S03: LAND: yes`) })])?.verdict).toBe("stale");
    expect(pick([rev({ tip: OLD, read: R.readReport(`LAND: yes for ${s9(H)}`) })])?.verdict).toBe("approved");
  });
  test("a newer approval of an older head never hides a refusal of this one", () => {
    const got = pick([rev({ by: "rv", at: 5, read: R.readReport("LAND: no") }), rev({ by: "rv2", at: 9, tip: OLD })]);
    expect(got?.by).toBe("rv");
    expect(got?.verdict).toBe("refused");
  });
  test("an approval whose reviewed head is not known is unclear", () => {
    expect(pick([rev({ tip: null })])?.verdict).toBe("unclear");
  });
  test("the parent chain comes with the review, not from the rows the board shows", () => {
    // A grandchild of the builder whose middle agent is not among the board's rows.
    expect(pick([rev({ by: "g", chain: ["sg", "sc", "sb", "root"] })])).toBeUndefined();
    expect(pick([rev({ by: "g", chain: null })])).toBeUndefined();
    expect(pick([rev({ by: "rv" })])?.by).toBe("rv");
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
