import { expect, test } from "bun:test";
import { answerText, baseState, baseWords, flakyOn, PROOF_MAX, proofLine, runNote, when, type Run } from "./words.ts";

const at = (h: number, m: number) => new Date(2026, 10, 21, h, m).getTime();
const NOW = at(15, 0);
let id = 0;
const run = (o: Partial<Run>): Run => ({
  id: ++id, name: "unit", command: "bun test", dir: ".", tree: "t1", head: null, session_id: "s1", by: "agent", result: "pass",
  exit: 0, pass: 10, fail: 0, started: at(14, 0), ended: at(14, 1), log: "/logs/b1.log", from_run: null, inputs: null, top: null, ...o,
});

test("the base: red since the oldest red commit in a row, green at its newest run, or nothing known", () => {
  const history = [{ commit: "c4", tree: "T4" }, { commit: "c3", tree: "T3" }, { commit: "c2", tree: "T2" }, { commit: "c1", tree: "T1" }];
  // c4 and c2 red, c3 not run, c1 green: red since c2.
  const runs = [{ tree: "T4", result: "fail" as const, ended: 40 }, { tree: "T2", result: "fail" as const, ended: 20 }, { tree: "T1", result: "pass" as const, ended: 10 }];
  expect(baseState(history, runs)).toEqual({ state: "red", since: { commit: "c2", at: 20 }, last: { commit: "c4", at: 40 } });
  // The newest run on a tree decides it: c4 passed after it failed.
  expect(baseState(history, [...runs, { tree: "T4", result: "pass", ended: 50 }])).toEqual({ state: "green", commit: "c4", at: 50 });
  expect(baseState(history, [{ tree: "T9", result: "fail", ended: 1 }])).toBeUndefined();
  expect(baseWords(undefined, "main")).toBe("not run on main's recent commits yet");
  expect(baseWords({ state: "red", since: { commit: "abcdef1234567", at: at(9, 5) }, last: { commit: "c4", at: at(14, 0) } }, "origin/main", NOW)).toBe("red on origin/main too since abcdef123 (09:05)");
  expect(baseWords({ state: "green", commit: "c4", at: at(14, 0) }, "main", NOW)).toContain("passes on main");
});

test("flaky: a pass and a failure on one tree", () => {
  expect(flakyOn([{ result: "pass", ended: 1 }, { result: "fail", ended: 2 }])).toEqual({ pass: 1, fail: 2 });
  expect(flakyOn([{ result: "pass", ended: 1 }, { result: "pass", ended: 2 }])).toBeUndefined();
});

test("the answer to a check that passed on these files says when, where its output is, and how to run it anyway", () => {
  const text = answerText(run({ ended: at(14, 2), pass: 37, fail: 0 }), { session: "s1", now: NOW });
  expect(text).toContain("unit (`bun test`) passed on this tree at 14:02 (37 pass, 0 fail), in this session");
  expect(text).toContain("Its output: /logs/b1.log");
  expect(text).toContain("send the same command again");
  expect(answerText(run({ by: "owner" }), { session: "s2", now: NOW })).toContain("run by the owner");
  expect(when(at(14, 2) - 86400_000, NOW)).toBe("2026-11-20 14:02");
});

test("a red run's note: its counts, flaky, and the base", () => {
  const red = run({ result: "fail", exit: 1, pass: 8, fail: 2 });
  expect(runNote(red, { base: "red on main too since c2 (09:05)", now: NOW })).toBe("Check ledger: unit failed on this tree (8 pass, 2 fail). Red on main too since c2 (09:05).");
  expect(runNote(red, { flaky: { pass: at(14, 0), fail: at(14, 5) }, now: NOW })).toContain("It passed on this same tree at 14:00: flaky.");
  expect(runNote(run({}), {})).toBe("");
  expect(runNote(run({}), { flaky: { pass: 1, fail: at(13, 0) }, now: NOW })).toContain("flaky");
});

test("the proof line: checks after the last edit, edits after the last green run, the files at the report", () => {
  const unit = run({ ended: at(14, 12), tree: "t2" });
  const lint = run({ name: "lint", command: "bun run lint", result: "fail", exit: 1, pass: null, fail: 2, ended: at(14, 13), tree: "t2" });
  const early = run({ ended: at(14, 2), tree: "t1" });
  const line = proofLine({ runs: [early, unit, lint], edits: [at(14, 5), at(14, 10)], treeNow: "t2", base: new Map([[lint.id, "red on main too since c2 (09:05)"]]), named: true, now: NOW });
  expect(line).toBe("(Checks after its last edit (14:10): unit passed 14:12, lint failed 14:13 (2 fail; red on main too since c2 (09:05)). No edit after the last green run. Its files are the ones its last check ran on.)");
  // None after the last edit: the ones before it, and the edits after the last green run.
  const stale = proofLine({ runs: [early], edits: [at(14, 5), at(14, 10)], treeNow: "t3", named: true, now: NOW });
  expect(stale).toBe("(Checks: none ran after its last edit (14:10); before it: unit passed 14:02. 2 edits after the last green run. Its files changed after its last check run.)");
  // An answer from the ledger counts as a green run.
  expect(proofLine({ runs: [run({ result: "answered", ended: at(14, 20) })], edits: [], named: true, now: NOW })).toBe("(Checks: unit passed (from the ledger) 14:20.)");
  expect(proofLine({ runs: [lint], edits: [], named: true, now: NOW })).toContain("No check passed.");
  expect(proofLine({ runs: [], edits: [at(14, 5)], named: true, now: NOW })).toBe("(Checks: none ran; it made 1 edit.)");
  expect(proofLine({ runs: [], edits: [at(14, 5)], named: false })).toBe("");
  expect(proofLine({ runs: [], edits: [], named: true })).toBe("");
  // Many checks: the line stays within its bound.
  const many = Array.from({ length: 30 }, (_, i) => run({ name: `check-${i}`, command: `make c${i}`, ended: at(14, 30) + i }));
  expect(proofLine({ runs: many, edits: [at(14, 1)], named: true, now: NOW }).length).toBeLessThanOrEqual(PROOF_MAX);
});
