import { expect, test } from "bun:test";
import { asksLess, childMode, classify, decide, type Facts, type Mode, type Rule } from "./policy.ts";

const ws = "/w/repo";
const rule = (kind: Rule["kind"], pattern: string): Rule => ({ id: pattern, kind, pattern, scope: ws, lifetime: "always", created: 0 });
const facts = (mode: Mode, extra: Partial<Facts> = {}): Facts => ({ mode, workspace: ws, sandboxed: false, rules: [], tool: "Bash", ...extra });
const tool = (name: string, kind?: "shell" | "edit" | "control" | "remote", readOnly = false, input_schema?: any) => ({ name, readOnly, kind, input_schema });
const escalating = { properties: { cmd: {}, sandbox_permissions: {} } };
const kind = (d: ReturnType<typeof decide>) => ("allow" in d ? "allow" : "deny" in d ? "deny" : `ask-${d.ask.risk}`);

test("a call's class comes from its tool's definition", () => {
  expect(classify(tool("Bash", "shell"), { command: "ls" }, ws)).toEqual({ kind: "shell", command: "ls", cwd: ws });
  expect(classify(tool("exec_command", "shell", false, escalating), { cmd: "npm test", sandbox_permissions: "require_escalated" }, ws)).toEqual({ kind: "shell", command: "npm test", escalate: true, cwd: ws });
  expect(classify(tool("shell", "shell"), { command: ["bash", "-lc", "git status"] }, ws)).toEqual({ kind: "shell", command: "git status", cwd: ws });
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
  expect(classify(tool("Bash", "shell"), { command: "npm test", sandbox_permissions: "require_escalated" }, ws)).toEqual({ kind: "shell", command: "npm test", cwd: ws });
  expect(classify(tool("Bash", "shell"), { command: "ls", session_id: "x" }, ws)).toEqual({ kind: "shell", command: "ls", cwd: ws });
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
  for (const mode of ["auto", "full-auto"] as const)
    expect(decide(esc, facts(mode, { sandboxed: true }))).toMatchObject({ ask: { risk: "high", ownerOnly: true } });
  expect(kind(decide(esc, facts("read-only", { sandboxed: true })))).toBe("deny");
  expect(kind(decide(esc, facts("full-auto", { sandboxed: false })))).toBe("allow");
});

test("Auto allows confined work and grants, but neither covers flagged or owner-only actions", () => {
  const auto = facts("auto", { sandboxed: true, rules: [rule("shell", "git *"), rule("edit", ws)] });
  expect(decide({ kind: "shell", command: "npm test" }, auto)).toEqual({ allow: true, why: "sandboxed" });
  expect(decide({ kind: "shell", command: "git add scratch.txt" }, { ...auto, sandboxed: false })).toEqual({ allow: true });
  expect(decide({ kind: "shell", command: "git clean -fn" }, auto)).toMatchObject({ ask: { risk: "high", suggest: [] } });
  expect(decide({ kind: "edit", paths: [`${ws}/.envrc`] }, auto)).toMatchObject({ ask: { ownerOnly: true } });
  const read = (path: string) => classify(tool("Read", undefined, true, { properties: { file_path: { type: "string" } } }), { file_path: path }, ws);
  expect(decide(read("scratch.txt"), auto)).toEqual({ allow: true });
  expect(decide(read("../scratch.txt"), auto)).toMatchObject({ ask: { risk: "low" } });
  expect(decide(read("../scratch.txt"), { ...auto, mode: "full-auto" })).toEqual({ allow: true });
});

test("control calls run in every mode", () => {
  expect(kind(decide({ kind: "control" }, facts("read-only")))).toBe("allow");
  expect(kind(decide({ kind: "control" }, facts("ask")))).toBe("allow");
});

test("a child never runs in a mode that asks less than its parent's", () => {
  expect(childMode("reviewer", "read-only")).toBe("read-only"); // a read-only agent under a reviewer parent
  expect(childMode("plan", "full-auto")).toBe("plan");
  expect(childMode("plan", "ask")).toBe("plan");
  expect(childMode("reviewer", "full-auto")).toBe("reviewer");
  expect(childMode("ask", "reviewer")).toBe("ask");
  expect(childMode("full-auto", "plan")).toBe("plan");
  expect(childMode("full-auto", "reviewer")).toBe("reviewer");
  expect(childMode("auto-edits", undefined)).toBe("auto-edits");
  expect(childMode("auto-edits", "auto")).toBe("auto-edits");
  expect(childMode("auto", "full-auto")).toBe("auto");
  expect(childMode("full-auto", "auto")).toBe("auto");
  expect(asksLess("auto", "auto-edits")).toBe(true); // remote presence check
  expect(asksLess("full-auto", "auto")).toBe(true);
  expect(childMode("ask", "nonsense")).toBe("ask");
});
