import { expect, test } from "bun:test";
import { exitOf, reasonLine } from "./reason.ts";

test("a shell failure's reason is the last line it printed, with how it ended; any other failure's is its first line", () => {
  // Claude's Bash: the exit code leads, the output follows. It read "Exit code 4" for every such failure.
  expect(reasonLine("Exit code 4\nstep one ok\nturn 23 failed\n")).toBe("turn 23 failed (exit code 4)");
  expect(reasonLine("Exit code 3\nfatal: remote rejected the push (protected branch)\nShell cwd was reset to /work")).toBe("fatal: remote rejected the push (protected branch) (exit code 3)");
  // What a hook added after the result is not the command's output.
  expect(reasonLine('Exit code 2\nerror: lane 1 build failed at step 1\n\n<memory source="tacit" hook="pre-tool">\n- echo-rule: fine\n</memory>')).toBe("error: lane 1 build failed at step 1 (exit code 2)");
  // Nothing printed: how it ended is all there is.
  expect(reasonLine("Exit code 1")).toBe("Exit code 1");
  expect(reasonLine("Killed by SIGKILL\nbuilding...\n[... 5000 characters cut ...]\nlinking app")).toBe("linking app (killed by SIGKILL)");
  expect(reasonLine("Command was killed at its 5s timeout\nwaiting for the lock")).toBe("waiting for the lock (command was killed at its 5s timeout)");
  // Gemini's shell: the output sits between the command and the exit code.
  const gemini = "Command: make test\nDirectory: /work\nOutput: compiling\nFAIL parser_test.go:41\nExit Code: 2\nShell cwd was reset to /work";
  expect(reasonLine(gemini)).toBe("FAIL parser_test.go:41 (exit code 2)");
  expect(reasonLine("Command: false\nDirectory: /work\nOutput: (empty)\nExit Code: 1")).toBe("Command: false");
  // Not a shell result: its first line, as before.
  expect(reasonLine("File does not exist: /nonexistent/a.txt\n\nThe folder /nonexistent does not exist.")).toBe("File does not exist: /nonexistent/a.txt");
  expect(reasonLine([{ type: "text", text: "No tool named NoSuchTool." }])).toBe("No tool named NoSuchTool.");
  // One line, within the bound, the ending kept whole.
  const long = reasonLine(`Exit code 4\n${"x".repeat(400)}`);
  expect(long.length).toBeLessThanOrEqual(140);
  expect(long).toEndWith("... (exit code 4)");
  expect(reasonLine("")).toBe("");
});

test("the exit code a shell result names is read from it", () => {
  expect(exitOf("Exit code 4\nturn failed")).toBe(4);
  expect(exitOf("Command: make\nDirectory: /w\nOutput: no\nExit Code: 2")).toBe(2);
  expect(exitOf("Killed by SIGKILL\nx")).toBeUndefined();
  expect(exitOf("File does not exist: Exit code 4")).toBeUndefined();
});
