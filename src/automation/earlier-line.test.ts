import { expect, test } from "bun:test";
import { findingClass, firstLine, lineOf, noteOf, outcome, sayClass, type Ended } from "./earlier-line.ts";

const done: Ended = { status: "completed", branch: "keel/x", tip: "abc1234", noWork: false, landed: false };

test("an outcome is landed, refused with the finding's class, abandoned, or told as it is", () => {
  expect(outcome({ ...done, landed: true })).toBe("landed");
  expect(outcome({ ...done, review: { land: false, class: "P1: Drops the user's rows" } })).toBe("refused by review (P1: Drops the user's rows)");
  // landed wins over an older refusal: the work was fixed and landed.
  expect(outcome({ ...done, landed: true, review: { land: false, class: "P2: x" } })).toBe("landed");
  expect(outcome({ ...done, status: "stopped", stopped_by: "the owner stopped it" })).toBe("abandoned (the owner stopped it)");
  expect(outcome({ ...done, status: "incomplete", end_reason: "it ran out of its step budget" })).toBe("abandoned (it ran out of its step budget)");
  expect(outcome({ ...done, status: "running" })).toBe("working now");
  expect(outcome(done)).toBe("finished, not landed");
  expect(outcome({ ...done, review: { land: true, class: "" } })).toBe("approved by review, finished, not landed");
  expect(outcome({ ...done, tip: null })).toContain("its branch is gone");
  expect(outcome({ ...done, noWork: true })).toBe("answered, no commits");
  expect(outcome({ ...done, branch: null, tip: null })).toBe("answered, no commits");
  expect(outcome({ ...done, remote: true, tip: null })).toContain("another machine");
});

test("a finding's class and a reviewer's first sentence", () => {
  expect(findingClass(1, "Rows lost on  retry")).toBe("P1: Rows lost on retry");
  expect(findingClass(null, null)).toBe("unrated");
  expect(sayClass("Line 6 lost its number. The rest reads right.")).toBe("Line 6 lost its number");
  expect(sayClass("x".repeat(200)).length).toBeLessThanOrEqual(90);
});

test("the first line of a report skips marks and the harness's own lines", () => {
  expect(firstLine("\n## Result\n\n**Landed the fix** in two commits.\nmore")).toBe("Landed the fix in two commits.");
  expect(firstLine("Earlier reports, oldest first:\nThe real line is here")).toBe("The real line is here");
  expect(firstLine("")).toBe("");
  expect(firstLine("a".repeat(300)).length).toBe(110);
});

test("the note is short: three lines stay under a thousand bytes", () => {
  const s = (id: string, ended: Ended) => ({ id, title: "Leftovers: remove only Keel-made worktrees and branches of the agent", branch: "keel/what-an-agent-leaves-0f6e60", head: "abc1234", ended, report: "Built the leftovers settle step and its e2e; all checks pass on the head." });
  const note = noteOf([s("1a2b3c4d5e6f", { ...done, landed: true }), s("2a2b3c4d5e6f", { ...done, review: { land: false, class: "P1: Removes another actor's worktree" } }), s("3a2b3c4d5e6f", { ...done, status: "stopped", stopped_by: "the owner stopped it" })]);
  expect(Buffer.byteLength(note)).toBeLessThan(1_000);
  expect(note).toContain("agent 1a2b3c4d5e6f): landed; branch keel/what-an-agent-leaves-0f6e60 @abc1234");
  expect(lineOf(s("x", done))).not.toContain("\n");
  expect(noteOf([])).toBe("");
});
