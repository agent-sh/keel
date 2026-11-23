import { expect, test } from "bun:test";
import { observeWait, pollNote, resetWait, stepWait, waitKey } from "./wait-poll.ts";

const bash = (command: string) => ["Bash", { command }] as const;

test("a waitfor polled again after the same wait gets the line naming the wait tool", () => {
  const [t, i] = bash("waitfor --file X --timeout 2m");
  const k = waitKey(t, i);
  expect(k).not.toBeNull();
  expect(pollNote(k, waitKey(t, i), "WaitFor")).toContain("WaitFor wakes you");
});

test("a capacity gate in front of real work is not a wait", () => {
  const [t, i] = bash("waitfor --capacity 20,8 --timeout 10m && bun test");
  expect(waitKey(t, i)).toBeNull();
  expect(pollNote(waitKey(t, i), waitKey(t, i), "WaitFor")).toBeNull();
});

test("an empty write_stdin after an empty write_stdin on the same session gets it", () => {
  const a = waitKey("write_stdin", { session_id: 7, chars: "" });
  expect(pollNote(a, waitKey("write_stdin", { session_id: 7 }), "wait_for")).toContain("wait_for wakes you");
  // Another exec session, or a write that sends characters, is not the same wait.
  expect(pollNote(a, waitKey("write_stdin", { session_id: 8 }), "wait_for")).toBeNull();
  expect(waitKey("write_stdin", { session_id: 7, chars: "y\n" })).toBeNull();
});

test("a first wait does not get it, and a call between two waits breaks the run", () => {
  const s = "wait-poll-test";
  resetWait(s);
  // One call a step, the steps one after another (the hook ends each step).
  const step = (tool: string, input: object) => { const note = observeWait(s, tool, input, "WaitFor"); stepWait(s); return note; };
  expect(step("Bash", { command: "sleep 60" })).toBeNull();
  expect(step("Bash", { command: "sleep 60" })).not.toBeNull();
  expect(step("Read", { file_path: "x" })).toBeNull();
  expect(step("Bash", { command: "sleep 60" })).toBeNull();
  resetWait(s);
});

test("two of the same wait in one step are not one polled after the other", () => {
  const s = "wait-poll-batch";
  resetWait(s);
  expect(observeWait(s, "Bash", { command: "sleep 60" }, "WaitFor")).toBeNull();
  expect(observeWait(s, "Bash", { command: "sleep 60" }, "WaitFor")).toBeNull();
  stepWait(s);
  // The next step polls it again: now it is.
  expect(observeWait(s, "Bash", { command: "sleep 60" }, "WaitFor")).not.toBeNull();
  stepWait(s);
  // A step that did other work beside its wait breaks the run.
  observeWait(s, "Bash", { command: "sleep 60" }, "WaitFor");
  observeWait(s, "Read", { file_path: "x" }, "WaitFor");
  stepWait(s);
  expect(observeWait(s, "Bash", { command: "sleep 60" }, "WaitFor")).toBeNull();
  resetWait(s);
});

test("what counts as a wait only", () => {
  expect(waitKey("Bash", { command: "gh pr checks 12 --watch || true" })).not.toBeNull();
  expect(waitKey("run_shell_command", { command: "sleep 30; echo done" })).not.toBeNull();
  expect(waitKey("exec_command", { cmd: "timeout 600 gh run watch 99 2>&1 | tail -5" })).not.toBeNull();
  expect(waitKey("Bash", { command: "sleep 30 && cat log.txt" })).toBeNull();
  expect(waitKey("Bash", { command: "echo 'sleep 5'" })).toBeNull();
  expect(waitKey("Bash", { command: "sleep 30 && bun test" })).toBeNull();
  // No wait tool offered: nothing to point at.
  const k = waitKey("Bash", { command: "sleep 5" });
  expect(pollNote(k, k, undefined)).toBeNull();
});
