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

test("the cause is the line shaped like an error, not what a tool prints after it", () => {
  const exit = (n: number, ...out: string[]) => `Exit code ${n}\n${out.join("\n")}`;
  // gcc: the caret lines come after the error. It read "| ;".
  expect(reasonLine(exit(1, "bad.c: In function 'main':", "bad.c:1:28: error: expected ';' before '}' token", "    1 | int main(void) { return x }", "      |                            ^", "      |                            ;")))
    .toBe("bad.c:1:28: error: expected ';' before '}' token (exit code 1)");
  // node: the stack and the runtime's version come after it. It read "Node.js v26.12.0".
  expect(reasonLine(exit(1, "[eval]:1", 'throw new Error("boom in node")', "^", "", "Error: boom in node", "    at [eval]:1:7", "    at runScriptInThisContext (node:internal/vm:219:10)", "", "Node.js v26.12.0")))
    .toBe("Error: boom in node (exit code 1)");
  // bun test: the tally comes last. It read "Ran 1 test across 1 file."
  expect(reasonLine(exit(1, "t.test.ts:", "error: expect(received).toBe(expected)", "Expected: 3", "Received: 2", "(fail) adds [0.21ms]", " 0 pass", " 1 fail", "Ran 1 test across 1 file. [4.00ms]")))
    .toBe("error: expect(received).toBe(expected) (exit code 1)");
  // bun build: the place comes after the error. It read "at /w/e.ts:1:15".
  expect(reasonLine(exit(1, '1 | import x from "./nope"; x()', "                  ^", 'error: Could not resolve: "./nope"', "    at /w/e.ts:1:15"))).toBe('error: Could not resolve: "./nope" (exit code 1)');
  // npm: where its log is comes last. It read "npm error A complete log of this run can be found in: ...".
  expect(reasonLine(exit(254, 'npm error Missing script: "nosuch"', "npm error", "npm error To see a list of scripts, run:", "npm error   npm run", "npm error A complete log of this run can be found in: /home/u/.npm/_logs/2026-11-22T06_00_00_000Z-debug-0.log")))
    .toBe('npm error Missing script: "nosuch" (exit code 254)');
  // Typed errors, a compiler's code, a test runner's mark.
  expect(reasonLine(exit(1, "Traceback (most recent call last):", '  File "tb.py", line 5, in <module>', "KeyError: 'k'"))).toBe("KeyError: 'k' (exit code 1)");
  expect(reasonLine(exit(2, "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", "", "Found 1 error in src/a.ts:3"))).toBe("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'. (exit code 2)");
  expect(reasonLine(exit(1, "error[E0425]: cannot find value `x` in this scope", " --> src/main.rs:2:5", "error: could not compile `app` due to 1 previous error"))).toBe("error: could not compile `app` due to 1 previous error (exit code 1)");
  // Nothing shaped like an error: a line that names a place in a file, else the last line that says anything.
  expect(reasonLine(exit(1, "checking", "lib/x.go:12:3: undefined: y", "done checking"))).toBe("lib/x.go:12:3: undefined: y (exit code 1)");
  expect(reasonLine(exit(1, "WARNING: Package(s) not found: nosuchpkg"))).toBe("WARNING: Package(s) not found: nosuchpkg (exit code 1)");
});

test("the line is printable: no escape sequences, the last frame of a redrawn line, no control characters", () => {
  expect(reasonLine("Exit code 1\n\x1b[31merror\x1b[0m: \x1b[1mcolored cause\x1b[0m")).toBe("error: colored cause (exit code 1)");
  expect(reasonLine("Exit code 1\nprogress 10%\rprogress 100%\r\n\n")).toBe("progress 100% (exit code 1)");
  const binary = reasonLine(`Exit code 1\n\x00\x01\x1b\x07abc\x1f\x7f def\x1b]0;title\x07 ghi`);
  expect(binary).toBe("abc def ghi (exit code 1)");
  expect(reasonLine("\x1b[1mTool failed\x1b[0m: no such thing\r\n")).toBe("Tool failed: no such thing");
});
