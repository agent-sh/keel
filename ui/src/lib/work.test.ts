import { expect, test } from "bun:test";
import type { ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { STOPPED_WHILE } from "../../../src/core/stops.ts";
import { addCall, addMeta, callsOf, changeOf, failureLine, isAside, sentence, setResult, summarize, type Step } from "./work.ts";

let n = 0;
const use = (name: string, input: Record<string, unknown> = {}): ToolUseBlock => ({ type: "tool_use", id: `c${++n}`, name, input });
const done = (id: string, content: string, is_error = false): ToolResultBlock => ({ type: "tool_result", tool_use_id: id, content, ...(is_error ? { is_error } : {}) });
const run = (calls: ToolUseBlock[]) => calls.reduce<Step[]>((s, c) => addCall(s, c, "e1"), []);

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
  expect([s.label, s.counts, s.targets, s.running, s.failed]).toEqual(["Explored", "3 files, 1 search", ["a.ts", "b.ts", "c.md"], 1, 0]);
  steps = setResult(steps, calls[3]!.id, done(calls[3]!.id, "File does not exist: /w/docs/c.md", true))!;
  s = summarize(steps[0]!);
  expect([s.running, s.failed]).toEqual([0, 1]);
  expect(sentence(s)).toBe("Explored 3 files, 1 search a.ts, b.ts, c.md, 1 failed");

  const edits = [use("Edit", { file_path: "/w/a.ts", old_string: "one\ntwo", new_string: "one\n2\nthree" }), use("Write", { file_path: "/w/new.ts", content: "a\nb\nc\n" })];
  const change = summarize(run(edits)[0]!);
  expect([change.label, change.targets, change.added, change.removed]).toEqual(["Edited", ["a.ts", "new.ts"], 5, 1]);
  expect(changeOf(edits[1]!)).toEqual({ files: ["/w/new.ts"], added: 3, removed: 0 });

  const cmd = use("Bash", { command: "bun test\n# and more", description: "what the model calls it" });
  let ran = run([cmd]);
  ran = setResult(ran, cmd.id, done(cmd.id, "Exit code 1\n 3 pass\n 1 fail\nerror: expected 2 to be 3", true))!;
  const r = summarize(ran[0]!);
  expect([r.label, r.targets, r.exit, r.failed]).toEqual(["Ran", ["bun test"], 1, 1]); // the command, never the model's name for it
  expect(sentence(r)).toBe("Ran bun test, failed with exit code 1");
  // A command stopped by the owner did not fail.
  const stopped = setResult(run([cmd]), cmd.id, done(cmd.id, STOPPED_WHILE, true))!;
  expect(summarize(stopped[0]!).failed).toBe(0);
});

test("why a call failed is a line of its own output", () => {
  expect(failureLine(done("x", "Exit code 1\nbun test v1\n\n\u001b[31m✗\u001b[0m reports each part once\n  error: expect(received).toEqual(expected)\n 1 fail", true))).toBe("error: expect(received).toEqual(expected)");
  expect(failureLine(done("x", "File does not exist: /w/a.md", true))).toBe("File does not exist: /w/a.md");
  expect(failureLine(done("x", "Exit code 2\nplain words", true))).toBe("plain words");
});

test("a line said in passing is short plain words; anything shaped or long is a reply", () => {
  expect(isAside("I'll read the exporter and its callers first.")).toBe(true);
  expect(isAside("Two ways:\n\n1. One\n2. Two")).toBe(false);
  expect(isAside("- a list item")).toBe(false);
  expect(isAside("```ts\ncode\n```")).toBe(false);
  expect(isAside("word ".repeat(60))).toBe(false);
});
