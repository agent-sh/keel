import { describe, expect, test } from "bun:test";
import { isMode } from "./policy.ts";
import { checkChange, grantsWith, judgedOf, namespacesWith, ruledOf, storedOutcome, trialReport, type Judged, type StoredOutcome, type TrialCall } from "./trial.ts";

const ALLOW: Judged = { outcome: "allow", cls: "allowed" };
const ASK: Judged = { outcome: "ask", cls: "destroys work or data" };
const REFUSE: Judged = { outcome: "refuse", cls: "writes beyond your accounts" };
const RAN: StoredOutcome = { outcome: "allow", source: "ran" };
let n = 0;
const call = (tool: string, current: Judged, candidate: Judged, more: Partial<TrialCall> = {}): TrialCall =>
  ({ id: `c${++n}`, session: "s1", event: `e${n}`, tool, kind: "shell", ts: n, ok: true, stored: RAN, current, candidate, ...more });

describe("the trial's diff", () => {
  test("counts only the calls the candidate treats otherwise, per tool and per class, with the succeeded share", () => {
    const r = trialReport([
      call("Bash", ALLOW, ALLOW),
      call("Bash", ALLOW, REFUSE),
      call("Bash", ALLOW, REFUSE, { ok: false }),
      call("exec_command", ASK, ALLOW),
      call("Bash", ASK, REFUSE),
    ], { days: 7, since: 0, ms: 5 });
    expect(r.changed).toMatchObject({ n: 4, allow: 1, ask: 0, refuse: 3, succeeded: 3, share: 0.75 });
    expect(r.changed.tools).toEqual([
      { key: "Bash", n: 3, allow: 0, ask: 0, refuse: 3, succeeded: 2, share: 2 / 3 },
      { key: "exec_command", n: 1, allow: 1, ask: 0, refuse: 0, succeeded: 1, share: 1 },
    ]);
    // A call the candidate allows is counted under the class that no longer holds; one it refuses, under the new one.
    expect(r.changed.classes.map((c) => [c.key, c.n])).toEqual([["writes beyond your accounts", 3], ["destroys work or data", 1]]);
    expect(r.changed.calls.map((c) => [c.from, c.to, c.link])).toEqual([
      ["allow", "refuse", "/s/s1?e=e2"], ["allow", "refuse", "/s/s1?e=e3"], ["ask", "allow", "/s/s1?e=e4"], ["ask", "refuse", "/s/s1?e=e5"],
    ]);
  });

  test("lists calls up to the cap and counts the rest", () => {
    const r = trialReport([call("Bash", ALLOW, ASK), call("Bash", ALLOW, ASK), call("Bash", ALLOW, ASK)], { days: 1, since: 0, ms: 0, cap: 2 });
    expect(r.changed.calls.length).toBe(2);
    expect(r.changed.more).toBe(1);
    expect(r.changed.n).toBe(3);
  });

  test("holds the current rules' replay against what was stored, and keeps apart what the rules never saw", () => {
    const r = trialReport([
      call("Bash", ALLOW, ALLOW),
      call("Bash", ASK, ASK, { stored: { outcome: "ask", source: "ruled" } }),
      call("Bash", ASK, ASK, { stored: { outcome: "allow", source: "ruled" }, rev: "old" }),
      call("Bash", ASK, ASK, { unkept: true }),
      call("Bash", ALLOW, ALLOW, { stored: { before: "a hook" } }),
      call("Bash", ALLOW, ALLOW, { stored: { skip: "not run (a stop or a missing tool)" } }),
    ], { days: 7, since: 0, ms: 0, skipped: { imported: 4 } });
    expect(r.agreement).toMatchObject({ compared: 4, agreed: 2, share: 0.5, recorded: { compared: 2, agreed: 1 }, before: { "a hook": 1 }, skipped: { imported: 4, "not run (a stop or a missing tool)": 1 } });
    expect(r.agreement.causes.map((c) => [c.n, c.from, c.to, c.cause])).toEqual([
      [1, "allow", "ask", "another build of the rules decided the call"],
      [1, "allow", "ask", "it ran in Full auto before the store kept a row for a flagged call it ran unreviewed"],
    ]);
    expect(r.agreement.causes[0]!.classes).toEqual({ "shell: destroys work or data": 1 });
  });
});

describe("what is stored of a call", () => {
  test("its rules' record first, then a card, a review, a refusal by its kind, a run", () => {
    expect(storedOutcome({ ok: true, ruled: { mode: "ask", d: "ask" }, card: false })).toEqual({ outcome: "ask", source: "ruled" });
    expect(storedOutcome({ ok: false, verdict: "denied", ruled: { mode: "auto", before: "agent write scope" } })).toEqual({ before: "agent write scope" });
    expect(storedOutcome({ ok: false, verdict: "denied", card: true })).toEqual({ outcome: "ask", source: "card" });
    expect(storedOutcome({ ok: false, verdict: "denied", reviewed: true })).toEqual({ outcome: "ask", source: "review" });
    expect(storedOutcome({ ok: false, verdict: "denied", denial: "A hook blocked this call: no" })).toEqual({ before: "a hook" });
    expect(storedOutcome({ ok: false, verdict: "denied", denial: "This session is read-only: files cannot be changed." })).toEqual({ outcome: "refuse", source: "refusal" });
    expect(storedOutcome({ ok: false, verdict: "none" })).toEqual({ skip: "not run (a stop or a missing tool)" });
    expect(storedOutcome({ ok: false, verdict: "failed" })).toEqual({ outcome: "allow", source: "ran" });
  });

  test("the gate's record of a decision names its class, never its words", () => {
    const r = ruledOf("full-auto", { ask: { risk: "high", why: "the command deletes /x", rule: "destroys work or data", suggest: [] } }, { rev: "b1", looked: [] });
    expect(r).toEqual({ mode: "full-auto", d: "ask", risk: "high", rule: "destroys work or data", rev: "b1" });
    expect(judgedOf({ deny: "Refused: it changes /s/keel.db, one of Keel's own files (its store)" })).toEqual({ outcome: "refuse", cls: "Keel's own files" });
  });
});

describe("a settings diff", () => {
  test("is checked before it is tried", () => {
    expect(checkChange(undefined, isMode)).toBeNull();
    expect(checkChange({ namespaces: { add: ["github.com/me"] }, grants: { add: [{ kind: "shell", pattern: "make", scope: "/" }] }, mode: "auto" }, isMode)).toBeNull();
    expect(checkChange({ mode: "loose" }, isMode)).toBe("unknown mode: loose");
    expect(checkChange({ grants: { add: [{ kind: "shell", pattern: "make", scope: "here" }] } }, isMode)).toContain("absolute folder");
    expect(checkChange({ other: 1 }, isMode)).toContain("has no other");
  });

  test("makes its namespaces and grants as the owner wrote them", () => {
    expect(namespacesWith(["github.com/a", "npm:@b"], { namespaces: { add: ["github.com/c", "npm:@b"], remove: ["github.com/a"] } })).toEqual(["npm:@b", "github.com/c"]);
    const kept = { id: "g1", kind: "shell" as const, pattern: "ls", scope: "/w", lifetime: "always" as const, created: 5 };
    const gone = { ...kept, id: "g2" };
    const out = grantsWith([kept, gone], { grants: { remove: ["g2"], add: [{ kind: "edit", pattern: " /w/src ", scope: "/" }] } });
    expect(out.map((r) => [r.id, r.kind, r.pattern, r.created])).toEqual([["g1", "shell", "ls", 5], ["trial-0", "edit", "/w/src", 0]]);
  });
});
