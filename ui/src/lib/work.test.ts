import { expect, test } from "bun:test";
import type { ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { APPROVAL_CUT, CUT_CALL, denialReason, ownerDenial, RESTART_CUT, STOPPED_BEFORE, STOPPED_WHILE, turnedAway } from "../../../src/core/stops.ts";
import { addCall, addMeta, besideOf, callState, callsOf, carriedOut, changedName, changeOf, commandText, edgeOf, failureLine, isAside, isTable, moreLines, noSuchTool, ranOf, refusalOf, sentence, setResult, smallChange, stateWords, summarize, targetOf, type Step } from "./work.ts";

let n = 0;
const use = (name: string, input: Record<string, unknown> = {}): ToolUseBlock => ({ type: "tool_use", id: `c${++n}`, name, input });
const done = (id: string, content: string, is_error = false): ToolResultBlock => ({ type: "tool_result", tool_use_id: id, content, ...(is_error ? { is_error } : {}) });
const run = (calls: ToolUseBlock[]) => calls.reduce<Step[]>((s, c) => addCall(s, c, "e1"), []);
const isCallOf = (id: string) => (i: Step["items"][number]): i is Extract<Step["items"][number], { t: "call" }> => i.t === "call" && i.id === id;

test("calls of one family in a row are one step, and another family starts the next", () => {
  const steps = run([use("Read", { file_path: "/w/a.ts" }), use("Grep", { pattern: "x" }), use("Read", { file_path: "/w/b.ts" }), use("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b\nc" }), use("Bash", { command: "bun test" }), use("Bash", { command: "git status" })]);
  expect(steps.map((s) => [s.family, callsOf(s).length])).toEqual([["explore", 3], ["change", 1], ["run", 2]]);
});

test("a plan update, a question and an agent are each a step of their own", () => {
  const steps = run([use("Read", { file_path: "/w/a.ts" }), use("TodoWrite", { todos: [] }), use("TodoWrite", { todos: [] }), use("Read", { file_path: "/w/b.ts" }), use("Agent", {}), use("Agent", {}), use("AskUserQuestion", {})]);
  expect(steps.map((s) => s.family)).toEqual(["explore", "plan", "plan", "explore", "card", "card", "card"]);
});

test("what the model says in passing starts a step; what it thought goes to the step it led to", () => {
  let steps = run([use("Read", { file_path: "/w/a.ts" })]);
  steps = addMeta(steps, { t: "thought", id: "t1", text: "same family next", event: "e2" });
  steps = addCall(steps, use("Read", { file_path: "/w/b.ts" }), "e2");
  expect(steps.length).toBe(1); // a thought between two reads does not split them
  steps = addMeta(steps, { t: "thought", id: "t2", text: "now the tests", event: "e3" });
  steps = addCall(steps, use("Bash", { command: "bun test" }), "e3");
  expect(steps.map((s) => s.items.map((i) => i.t))).toEqual([["call", "thought", "call"], ["thought", "call"]]);
  steps = addMeta(steps, { t: "note", id: "n1", text: "One more run.", event: "e4" });
  steps = addCall(steps, use("Bash", { command: "bun test again" }), "e4");
  expect(steps.map((s) => s.family)).toEqual(["explore", "run", "run"]);
  expect(steps[2]!.items.map((i) => i.t)).toEqual(["note", "call"]);
});

test("a result changes only the step that holds its call", () => {
  const steps = run([use("Read", { file_path: "/w/a.ts" }), use("Bash", { command: "ls" })]);
  const id = callsOf(steps[1]!)[0]!.id;
  const next = setResult(steps, id, done(id, "a.ts"))!;
  expect(next[0]).toBe(steps[0]!);
  expect(next[1]).not.toBe(steps[1]!);
  expect(callsOf(next[1]!)[0]!.result!.content).toBe("a.ts");
  expect(setResult(steps, "nope", done("nope", ""))).toBeNull();
});

test("a step's line says what was done, to what and how it went, from the calls alone", () => {
  const calls = [use("Read", { file_path: "/w/src/a.ts" }), use("Read", { file_path: "/w/src/b.ts" }), use("Grep", { pattern: "x" }), use("Read", { file_path: "/w/docs/c.md" })];
  let steps = run(calls);
  steps = setResult(steps, calls[0]!.id, done(calls[0]!.id, "1\tx"))!;
  steps = setResult(steps, calls[1]!.id, done(calls[1]!.id, "1\ty"))!;
  steps = setResult(steps, calls[2]!.id, done(calls[2]!.id, "No matches found"))!;
  let s = summarize(steps[0]!);
  expect([s.label, s.counts, s.targets, s.looks.running, s.looks.error]).toEqual(["Explored", "3 files, 1 search", ["a.ts", "b.ts", "c.md"], 1, 0]);
  steps = setResult(steps, calls[3]!.id, done(calls[3]!.id, "File does not exist: /w/docs/c.md", true))!;
  s = summarize(steps[0]!);
  expect([s.looks.running, s.looks.error]).toEqual([0, 1]);
  expect(sentence(s)).toBe("Explored 3 files, 1 search a.ts, b.ts, c.md, 1 failed");

  const edits = [use("Edit", { file_path: "/w/a.ts", old_string: "one\ntwo", new_string: "one\n2\nthree" }), use("Write", { file_path: "/w/new.ts", content: "a\nb\nc\n" })];
  const change = summarize(run(edits)[0]!);
  expect([change.label, change.counts, change.targets, change.added, change.removed]).toEqual(["Edited", "2 files", ["a.ts", "new.ts"], 5, 1]);
  expect(changeOf(edits[1]!)).toEqual({ files: ["/w/new.ts"], added: 3, removed: 0 });

  const cmd = use("Bash", { command: "bun test\n# and more", description: "what the model calls it" });
  let ran = run([cmd]);
  ran = setResult(ran, cmd.id, done(cmd.id, "Exit code 1\n 3 pass\n 1 fail\nerror: expected 2 to be 3", true))!;
  const r = summarize(ran[0]!);
  expect([r.label, r.targets, r.exit, r.looks.error]).toEqual(["Ran", ["bun test (+1 line)"], 1, 1]); // the command, never the model's name for it
  expect(sentence(r)).toBe("Ran bun test (+1 line), exit 1");
  // A command stopped by the owner did not fail.
  const stopped = setResult(run([cmd]), cmd.id, done(cmd.id, STOPPED_WHILE, true))!;
  expect(summarize(stopped[0]!).looks).toMatchObject({ error: 0, stopped: 1 });
  // A call the reply cut at the output limit was not run: it read "Ran echo cut-ran, failed".
  const cutOff = use("Bash", { command: "echo cut-ran" });
  const unrun = summarize(setResult(run([cutOff]), cutOff.id, done(cutOff.id, CUT_CALL, true))![0]!);
  expect([unrun.ran, unrun.looks.error, unrun.looks.unrun]).toEqual([0, 0, 1]);
  expect(sentence(unrun)).toBe("Not run echo cut-ran, cut at the output limit");
  const one = use("Bash", { command: "echo one" });
  let two = run([one, cutOff]);
  two = setResult(setResult(two, one.id, done(one.id, "one"))!, cutOff.id, done(cutOff.id, CUT_CALL, true))!;
  expect(sentence(summarize(two[0]!))).toBe("Ran 2 commands echo one, echo cut-ran, 1 not run: cut at the output limit");
});

test("why a call failed is a line of its own output", () => {
  expect(failureLine(done("x", "Exit code 1\nbun test v1\n\n\u001b[31m✗\u001b[0m reports each part once\n  error: expect(received).toEqual(expected)\n 1 fail", true))).toBe("error: expect(received).toEqual(expected)");
  expect(failureLine(done("x", "File does not exist: /w/a.md", true))).toBe("File does not exist: /w/a.md");
  expect(failureLine(done("x", "Exit code 2\nplain words", true))).toBe("plain words");
  // A line longer than the row shows ends at a word, marked: never in the middle of one.
  const long = `Delivery to receipt-fixture/receiver is unconfirmed (the daemon at http://127.0.0.1:41529 did not prove the pairing (HTTP 200)). The message may have arrived; check the receiving session before retrying.`;
  expect(long.length).toBeGreaterThan(200);
  expect(failureLine(done("x", long, true))).toBe(`${long.slice(0, long.lastIndexOf(" before"))} before…`);
  expect(failureLine(done("x", `error: ${"a".repeat(400)}`, true))).toBe(`error: ${"a".repeat(193)}…`);
});

test("a line said in passing is short plain words; anything shaped or long is a reply", () => {
  expect(isAside("I'll read the exporter and its callers first.")).toBe(true);
  expect(isAside("Two ways:\n\n1. One\n2. Two")).toBe(false);
  expect(isAside("- a list item")).toBe(false);
  expect(isAside("```ts\ncode\n```")).toBe(false);
  expect(isAside("word ".repeat(60))).toBe(false);
});

test("a call with no result runs only while its session works, and waits while its approval card is open", () => {
  const calls = [use("Bash", { command: "ls" }), use("Bash", { command: "rm -rf build" }), use("Bash", { command: "make deploy" }), use("Bash", { command: "sleep 600" })];
  let steps = run(calls);
  steps = setResult(steps, calls[0]!.id, done(calls[0]!.id, "a"))!;
  steps = setResult(steps, calls[2]!.id, done(calls[2]!.id, RESTART_CUT, true))!;
  // The session works; the second call's approval card is open; the fourth has started.
  let s = summarize(steps[0]!, { working: true, waiting: new Set([calls[1]!.id]) });
  expect(s.looks).toMatchObject({ ok: 1, waiting: 1, cut: 1, running: 1, error: 0 });
  expect(stateWords(s)).toEqual([{ text: "1 needs you", tone: "need" }, { text: "1 cut by a restart", tone: "warn" }]);
  expect(carriedOut(s)).toBe(true);
  expect(edgeOf(s.looks)).toBe("need");
  // The session is idle: what has no result did not finish, and nothing is said to run.
  s = summarize(steps[0]!, { working: false });
  expect(s.looks).toMatchObject({ running: 0, unfinished: 2, cut: 1 });
  expect(stateWords(s).map((w) => w.text)).toEqual(["1 cut by a restart", "2 with no result"]);
  expect(edgeOf(s.looks)).toBe("warn");
  expect(sentence(s)).toBe("Ran 4 commands ls, rm -rf build, make deploy, sleep 600, 1 cut by a restart, 2 with no result");
  // None of a step's calls got a result: it is not said to have run.
  const none = summarize(run([use("Bash", { command: "a" }), use("Bash", { command: "b\nc" })])[0]!, { working: false });
  expect([carriedOut(none), stateWords(none).map((w) => w.text), none.targets]).toEqual([false, ["no result"], ["a", "b (+1 line)"]]);
});

test("a call on a line of its own is counted and never among the targets named or left out", () => {
  const calls = Array.from({ length: 11 }, (_, k) => use("Bash", { command: k === 9 ? "git push --force origin main" : `echo ${k}` }));
  const steps = run(calls);
  const s = summarize(steps[0]!, { working: false, own: new Set([calls[9]!.id]) });
  expect([s.counts, s.targets, s.more]).toEqual(["11 commands", ["echo 0", "echo 1", "echo 2", "echo 3"], 6]);
  expect(s.targets.concat(String(s.more)).join(" ")).not.toContain("push");
  // What is named and what "+N" counts are together every call that has no line of its own: 4 + 6 of 11, with 1 apart.
  expect(s.targets.length + s.more + 1).toBe(11);
  // A target is cut in its own text past a length, where the cut shows: it is not hidden by the line's end.
  const long = summarize(run([use("Bash", { command: `echo ${"x".repeat(200)}` }), use("Bash", { command: "ls" })])[0]!, { working: false });
  expect([long.targets[0]!.length, long.targets[0]!.endsWith("\u2026"), long.targets[1]]).toEqual([96, true, "ls"]);
});

test("a denial, a refusal and a failure are three things, and only the last is a failure", () => {
  const calls = [use("Bash", { command: "rm -rf build" }), use("Bash", { command: "make deploy" }), use("Bash", { command: "bun test" }), use("Bash", { command: "ls" })];
  let steps = run(calls);
  steps = setResult(steps, calls[0]!.id, done(calls[0]!.id, ownerDenial("not that folder"), true))!;
  steps = setResult(steps, calls[1]!.id, done(calls[1]!.id, "The reviewer refused this call (risk high): it deploys. Do not retry it as it is.", true))!;
  steps = setResult(steps, calls[2]!.id, done(calls[2]!.id, "1 fail\nExit code 1", true))!;
  steps = setResult(steps, calls[3]!.id, done(calls[3]!.id, "a.ts"))!;
  const s = summarize(steps[0]!, { working: false });
  expect(s.looks).toMatchObject({ denied: 1, refused: 1, error: 1, ok: 1 });
  expect(stateWords(s)).toEqual([{ text: "1 failed", tone: "fail" }, { text: "1 denied by you", tone: "own" }, { text: "1 refused", tone: "warn" }]);
  expect([s.ran, carriedOut(s), edgeOf(s.looks, s.soft)]).toEqual([2, true, "error"]);
  expect([callState(calls[0] && steps[0]!.items.find(isCallOf(calls[0]!.id))!.result), denialReason(ownerDenial("not that folder")), denialReason(ownerDenial()), turnedAway("Refused by the judge (risk high): it is risky.")]).toEqual(["denied", "not that folder", "", "refused"]);
  // Every call of a step denied: it is not said to have run, and it is not a failure.
  let both = run([use("Bash", { command: "a" }), use("Bash", { command: "b" })]);
  for (const c of callsOf(both[0]!)) both = setResult(both, c.id, done(c.id, ownerDenial(), true))!;
  const d = summarize(both[0]!, { working: false });
  expect([carriedOut(d), stateWords(d), edgeOf(d.looks, d.soft)]).toEqual([false, [{ text: "denied by you", tone: "own" }], "ok"]);
  // A call the page knows was refused is refused, whatever its result says.
  const known = summarize(steps[0]!, { working: false, refused: new Set([calls[2]!.id]) });
  expect(known.looks).toMatchObject({ refused: 2, error: 0 });
});

test("a failure while looking around is a note: it does not turn the rail, and a failed change adds no lines", () => {
  let reads = run([use("Read", { file_path: "/w/a.ts" }), use("Read", { file_path: "/w/gone.md" })]);
  reads = setResult(reads, callsOf(reads[0]!)[0]!.id, done(callsOf(reads[0]!)[0]!.id, "text"))!;
  reads = setResult(reads, callsOf(reads[0]!)[1]!.id, done(callsOf(reads[0]!)[1]!.id, "File does not exist: /w/gone.md", true))!;
  const r = summarize(reads[0]!, { working: false });
  expect([r.soft, stateWords(r), edgeOf(r.looks, r.soft)]).toEqual([true, [{ text: "1 failed", tone: "note" }], "ok"]);
  let edits = run([use("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b\nc" }), use("Edit", { file_path: "/w/b.ts", old_string: "x\ny", new_string: "z" })]);
  edits = setResult(edits, callsOf(edits[0]!)[0]!.id, done(callsOf(edits[0]!)[0]!.id, "updated"))!;
  edits = setResult(edits, callsOf(edits[0]!)[1]!.id, done(callsOf(edits[0]!)[1]!.id, "String to replace not found in file.", true))!;
  const e = summarize(edits[0]!, { working: false });
  expect([e.added, e.removed, edgeOf(e.looks, e.soft)]).toEqual([2, 1, "error"]);
  // An edit that failed changed nothing: it is not said to have edited (a command that failed did run).
  expect([e.ran, ranOf("error", done("x", "no", true), true), ranOf("error", done("x", "no", true))]).toEqual([1, false, true]);
  let none = run([use("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" })]);
  none = setResult(none, callsOf(none[0]!)[0]!.id, done(callsOf(none[0]!)[0]!.id, "String to replace not found in file.", true))!;
  expect(carriedOut(summarize(none[0]!, { working: false }))).toBe(false);
  // Every call of a step waits on the owner: said in the words every surface uses.
  const asks = summarize(run([use("Bash", { command: "rm -rf build" })])[0]!, { working: true, waiting: new Set([`c${n}`]) });
  expect(stateWords(asks)).toEqual([{ text: "needs you: an approval", tone: "need" }]);
});

test("a call ran when it was carried out in whole or in part", () => {
  const r = (content: string, is_error = true) => done("x", content, is_error);
  expect([ranOf("ok", r("a", false)), ranOf("error", r("boom")), ranOf("running"), ranOf("stopped", r(STOPPED_WHILE)), ranOf("cut", r(RESTART_CUT))]).toEqual([true, true, true, true, true]);
  expect([ranOf("waiting"), ranOf("unfinished"), ranOf("denied", r(ownerDenial())), ranOf("refused", r("Refused: no.")), ranOf("stopped", r(STOPPED_BEFORE)), ranOf("cut", r(APPROVAL_CUT))]).toEqual([false, false, false, false, false, false]);
});

test("a command of several lines says how many follow, and a list of words is read as a command", () => {
  expect(moreLines(use("Bash", { command: "cd build\nrm -rf ../../*\n\nls" }))).toBe(2);
  expect(moreLines(use("Bash", { command: "ls" }))).toBe(0);
  expect(commandText(use("exec_command", { cmd: ["bash", "-lc", "cat src/a.ts"] }))).toBe("cat src/a.ts");
  expect(targetOf(use("exec_command", { cmd: ["git", "status"] }))).toBe("git status");
});

test("a small change shows its lines, a larger one only its count", () => {
  expect(smallChange(use("Edit", { file_path: "/w/a.ts", old_string: "one\ntwo\nthree", new_string: "one\n2\nthree" }))).toEqual([{ t: "-", text: "two" }, { t: "+", text: "2" }]);
  expect(smallChange(use("Write", { file_path: "/w/n.ts", content: "a\nb\n" }))).toEqual([{ t: "+", text: "a" }, { t: "+", text: "b" }]);
  expect(smallChange(use("Write", { file_path: "/w/n.ts", content: "x\n".repeat(20) }))).toBeNull();
  expect(smallChange(use("Read", { file_path: "/w/a.ts" }))).toBeNull();
});

test("a few words stand beside the call they lead to; more stand above it", () => {
  let steps = addMeta([], { t: "note", id: "n1", text: "Step 1 of 6.", event: "e1" });
  steps = addCall(steps, use("Read", { file_path: "/w/a.ts" }), "e1");
  expect(besideOf(steps[0]!)?.id).toBe("n1");
  let long = addMeta([], { t: "note", id: "n2", text: "One test fails: the last part is reported twice.", event: "e2" });
  long = addCall(long, use("Read", { file_path: "/w/a.ts" }), "e2");
  expect(besideOf(long[0]!)).toBeUndefined();
  // Words with no call yet are not beside anything.
  expect(besideOf(addMeta([], { t: "note", id: "n3", text: "Hm.", event: "e3" })[0]!)).toBeUndefined();
  // A run is a table when most of its steps have such words; one short line in a long run is not.
  expect(isTable([...steps, ...run([use("Bash", { command: "ls" })])])).toBe(true);
  expect(isTable([...steps, ...run([use("Bash", { command: "ls" })]), ...run([use("Edit", { file_path: "/w/a.ts", old_string: "a", new_string: "b" })])])).toBe(false);
});

test("a changed file under a hidden folder keeps that folder, and a dozen changed files are all named", () => {
  expect(changedName("/w/src/a.ts", "/w")).toBe("a.ts");
  expect(changedName("/w/.github/workflows/ci.yml", "/w")).toBe(".github/workflows/ci.yml");
  expect(changedName("/w/packages/app/.husky/pre-push", "/w")).toBe(".husky/pre-push");
  expect(changedName("/w/.env", "/w")).toBe(".env");
  // Outside the folder (a hidden folder above it says nothing about the file): its name; such a call is marked and shown whole.
  expect(changedName("/home/x/.cache/ws/a.ts", "/w")).toBe("a.ts");
  const edits = Array.from({ length: 14 }, (_, k) => use("Edit", { file_path: `/w/src/f${k}.ts`, old_string: "a", new_string: "b" }));
  const s = summarize(run(edits)[0]!, { working: false, cwd: "/w" });
  expect([s.counts, s.targets.length, s.more]).toEqual(["14 files", 12, 2]);
});

test("a refusal says who refused and why, without what was written for the model", () => {
  const r = (content: string): ToolResultBlock => done("x", content, true);
  expect(refusalOf(r("The reviewer refused this call (risk high): it publishes a release. Do not retry it as it is: take another way, or ask the owner."))).toEqual({ by: "Reviewer", why: "it publishes a release." });
  expect(refusalOf(r("Refused by the judge (risk high): The command discards work. Do not retry it as it is or work around it."))).toEqual({ by: "Judge", why: "The command discards work." });
  expect(refusalOf(r("Refused: the command deletes / recursively, which never runs without the owner. Do not try another form of it; say what you wanted it for."))).toEqual({ by: "Keel", why: "the command deletes / recursively, which never runs without the owner." });
  expect(refusalOf(r("This session is read-only: only read-only commands run, and `rm x` is not one."))).toEqual({ by: "Read only", why: "only read-only commands run, and `rm x` is not one." });
});

test("a failure's reason is the tool's own output, and a call to a tool that is not there did not run", () => {
  const r = (content: string): ToolResultBlock => done("x", content, true);
  // A command that failed with no output: what a hook put into its result is not its reason.
  const hooked = r('Exit code 3\n\n<memory source="tacit" hook="pre-tool">\nFrom the owner\'s memory store.\n- a fact\n</memory>');
  expect(failureLine(hooked)).toBe("Exit code 3");
  expect(failureLine(r('<memory source="tacit" hook="pre-tool">\n- a fact\n</memory>\nrm: cannot remove x: No such file'))).toBe("rm: cannot remove x: No such file");
  expect(failureLine(r("cat: gone.md: No such file or directory\nExit code 1"))).toBe("cat: gone.md: No such file or directory");
  const missing = r("No tool named exec_command.");
  expect([noSuchTool(missing), ranOf("error", missing), ranOf("error", r("boom")), noSuchTool(done("x", "No tool named x."))]).toEqual([true, false, true, false]);
});
