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
  expect(decide(esc, facts("auto"))).toMatchObject({ ask: { risk: "high", ownerOnly: true } });
  expect(kind(decide(esc, facts("full-auto", { sandboxed: true })))).toBe("ask-high");
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
  expect(decide(read("../scratch.txt"), auto)).toEqual({ allow: true });
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

test("a command that writes is never run as a read: refused in Read only and Plan, asked in Ask", () => {
  const sh = (command: string) => ({ kind: "shell" as const, command });
  const writes = [
    "> f", "{ echo a; } > f", "for x in 1; do echo a; done > f", "if true; then echo a; fi > f", "echo x >&f", "cat <>f",
    "git reflog expire --expire=now --all", "git reflog delete HEAD@{1}", "date -s 2020-01-01",
    // The same redirect after the other compound commands, and with no command before it.
    "(echo a; echo b) > f", "while read l; do echo $l; done < in > f", "case x in x) echo a;; esac > f", "ls | { cat; } >> f", ">> f", "2> f", "&> f", ">| f",
    "f() { echo a; } > f; f", "echo x &>>f", "cat <<EOF > f\nhi\nEOF", "cat <<EOF\n$(touch f)\nEOF", "fi", "# nothing but a comment",
  ];
  for (const c of writes) {
    expect([c, kind(decide(sh(c), facts("read-only")))]).toEqual([c, "deny"]);
    expect([c, kind(decide(sh(c), facts("plan")))]).toEqual([c, "deny"]);
    expect([c, kind(decide(sh(c), facts("ask")))]).toEqual([c, "ask-low"]);
  }
  const reads = [
    "ls 2>/dev/null", "cat a 2>&1 | head", "ls >&2", "ls 2>&-", "{ ls; pwd; }", "(cd sub && ls)", "for f in a b; do cat $f; done", "if [ -f a ]; then cat a; fi",
    "git reflog", "git reflog show -n 5", "date +%s", "date -d yesterday +%F", "date -Iseconds", "cat < in.txt", "wc -l <<< hello", "cat <<'EOF'\nit's text, not a command\nEOF", "ls &> /dev/null",
  ];
  for (const c of reads) for (const m of ["read-only", "ask"] as const) expect([c, kind(decide(sh(c), facts(m)))]).toEqual([c, "allow"]);
  // A redirect with no command word offers no rule: none could cover it.
  const d = decide(sh("{ echo a; } > f"), facts("ask"));
  expect("ask" in d && d.ask.suggest).toEqual([]);
  expect(kind(decide(sh("echo a > f"), facts("ask", { rules: [rule("shell", "echo *")] })))).toBe("allow");
  expect(kind(decide(sh("{ echo a; } > f"), facts("ask", { rules: [rule("shell", "echo *")] })))).toBe("ask-low");
});
