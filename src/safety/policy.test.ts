import { expect, test } from "bun:test";
import { classify, decide, type Facts, type Mode, type Rule } from "./policy.ts";

const ws = "/w/repo";
const rule = (kind: Rule["kind"], pattern: string): Rule => ({ id: pattern, kind, pattern, scope: ws, lifetime: "always", created: 0 });
const facts = (mode: Mode, extra: Partial<Facts> = {}): Facts => ({ mode, workspace: ws, sandboxed: false, rules: [], tool: "Bash", ...extra });
const tool = (name: string, kind?: "shell" | "edit" | "control" | "remote", readOnly = false, input_schema?: any) => ({ name, readOnly, kind, input_schema });
const escalating = { properties: { cmd: {}, sandbox_permissions: {} } };
const kind = (d: ReturnType<typeof decide>) => ("allow" in d ? "allow" : "deny" in d ? "deny" : `ask-${d.ask.risk}`);

test("a call's class comes from its tool's definition", () => {
  expect(classify(tool("Bash", "shell"), { command: "ls" }, ws)).toEqual({ kind: "shell", command: "ls" });
  expect(classify(tool("exec_command", "shell", false, escalating), { cmd: "npm test", sandbox_permissions: "require_escalated" }, ws)).toEqual({ kind: "shell", command: "npm test", escalate: true });
  expect(classify(tool("shell", "shell"), { command: ["bash", "-lc", "git status"] }, ws)).toEqual({ kind: "shell", command: "git status" });
  expect(classify(tool("Edit", "edit"), { file_path: "src/a.ts" }, ws)).toEqual({ kind: "edit", paths: ["/w/repo/src/a.ts"] });
  expect(classify(tool("apply_patch", "edit"), { input: "*** Begin Patch\n*** Update File: a.ts\n*** Add File: b.ts\n*** End Patch" }, ws)).toEqual({ kind: "edit", paths: ["/w/repo/a.ts", "/w/repo/b.ts"] });
  expect(classify(tool("apply_patch", "edit"), "*** Begin Patch\n*** Delete File: c.ts\n*** End Patch", ws)).toEqual({ kind: "edit", paths: ["/w/repo/c.ts"] });
  expect(classify(tool("write_stdin", "control"), { session_id: 3, chars: "y\n" }, ws)).toEqual({ kind: "control" });
  expect(classify(tool("mcp_call"), { tool: "github__create_issue", arguments: {} }, ws)).toEqual({ kind: "other" });
  expect(classify(tool("Read", undefined, true), { file_path: "/etc/passwd" }, ws)).toEqual({ kind: "read" });
  // Keys in the input never change the class.
  expect(classify(tool("keel__session_send"), { session_id: "x", text: "hi" }, ws)).toEqual({ kind: "other" });
  expect(classify(tool("keel__session_send"), { task_id: "x", to: "y" }, ws)).toEqual({ kind: "other" });
  expect(classify(tool("keel__send_files", "remote"), { file_path: "a.ts" }, ws)).toEqual({ kind: "other" });
  expect(classify(tool("some_tool"), { command: "rm -rf build" }, ws)).toEqual({ kind: "other" });
  expect(classify(tool("Bash", "shell"), { command: "npm test", sandbox_permissions: "require_escalated" }, ws)).toEqual({ kind: "shell", command: "npm test" });
  expect(classify(tool("Bash", "shell"), { command: "ls", session_id: "x" }, ws)).toEqual({ kind: "shell", command: "ls" });
});

test("modes", () => {
  const sh = (command: string) => ({ kind: "shell" as const, command });
  const edit = (p: string) => ({ kind: "edit" as const, paths: [p] });
  expect(kind(decide(sh("npm test"), facts("ask")))).toBe("ask-low");
  expect(kind(decide(sh("git status && ls"), facts("ask")))).toBe("allow");
  expect(kind(decide(sh("npm test"), facts("ask", { rules: [rule("shell", "npm test *")] })))).toBe("allow");
  expect(kind(decide(sh("npm test && rm x"), facts("ask", { rules: [rule("shell", "npm test *")] })))).toBe("ask-low");
  expect(kind(decide(edit("/w/repo/a.ts"), facts("auto-edits")))).toBe("allow");
  expect(kind(decide(edit("/w/repo/.git/config"), facts("auto-edits")))).toBe("ask-high");
  expect(kind(decide(edit("/w/repo/.envrc"), facts("ask", { rules: [rule("edit", "/w/repo")] })))).toBe("ask-high");
  expect(kind(decide(edit("/w/repo/.git/HEAD"), facts("auto-edits")))).toBe("ask-low");
  expect(kind(decide(edit("/etc/hosts"), facts("auto-edits")))).toBe("ask-low");
  expect(kind(decide(sh("npm test"), facts("auto-edits", { sandboxed: true })))).toBe("allow");
  expect(kind(decide(sh("npm test"), facts("full-auto")))).toBe("allow");
  expect(kind(decide(sh("git push --force"), facts("full-auto")))).toBe("ask-high");
  expect(kind(decide(sh("npm test"), facts("read-only")))).toBe("deny");
  expect(kind(decide(sh("rg foo"), facts("read-only")))).toBe("allow");
  expect(kind(decide(edit("/w/repo/a.ts"), facts("read-only")))).toBe("deny");
});

test("leaving the sandbox asks once in every mode", () => {
  const esc = { kind: "shell" as const, command: "npm test", escalate: true };
  expect(kind(decide(esc, facts("full-auto", { sandboxed: true })))).toBe("ask-high");
  expect(kind(decide(esc, facts("read-only", { sandboxed: true })))).toBe("deny");
  expect(kind(decide(esc, facts("full-auto", { sandboxed: false })))).toBe("allow");
});

test("control calls run in every mode", () => {
  expect(kind(decide({ kind: "control" }, facts("read-only")))).toBe("allow");
  expect(kind(decide({ kind: "control" }, facts("ask")))).toBe("allow");
});
