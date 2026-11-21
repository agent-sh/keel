import { expect, test } from "bun:test";
import { asksLess, childMode, classify, decide, MODES, shellText, type Facts, type Mode, type Rule, escapeOf } from "./policy.ts";

const ws = "/w/repo";
const rule = (kind: Rule["kind"], pattern: string): Rule => ({ id: pattern, kind, pattern, scope: ws, lifetime: "always", created: 0 });
const facts = (mode: Mode, extra: Partial<Facts> = {}): Facts => ({ mode, workspace: ws, sandboxed: false, rules: [], tool: "Bash", ...extra });
const tool = (name: string, kind?: "shell" | "edit" | "control" | "remote", readOnly = false, input_schema?: any) => ({ name, readOnly, kind, input_schema });
const escalating = { properties: { cmd: {}, sandbox_permissions: {} } };
const kind = (d: ReturnType<typeof decide>) => ("allow" in d ? "allow" : "deny" in d ? "deny" : `ask-${d.ask.risk}`);

test("a call's class comes from its tool's definition", () => {
  expect(classify(tool("Bash", "shell"), { command: "ls" }, ws)).toEqual({ kind: "shell", command: "ls", cwd: ws });
  expect(classify(tool("exec_command", "shell", false, escalating), { cmd: "npm test", sandbox_permissions: "require_escalated" }, ws)).toEqual({ kind: "shell", command: "npm test", escalate: true, cwd: ws });
  // What is judged is what runs: the text of the one key the tool reads. A
  // tool runs a list as its joined text, where "$(...)" is shell again, and it
  // never reads a second key.
  expect(classify(tool("Bash", "shell"), { command: ["echo", "$(touch M)"] }, ws)).toEqual({ kind: "refused", why: "Bash takes its command as one string." });
  expect(classify(tool("Bash", "shell"), { command: { text: "ls" } }, ws).kind).toBe("refused");
  expect(classify(tool("exec_command", "shell", false, escalating), { command: "echo harmless", cmd: "touch M" }, ws)).toEqual({ kind: "shell", command: "touch M", cwd: ws });
  expect(classify(tool("exec_command", "shell", false, escalating), { command: "echo harmless", cmd: ["touch", "M"] }, ws).kind).toBe("refused");
  expect(classify(tool("Bash", "shell", false, { properties: { command: {} } }), { cmd: "touch M" }, ws)).toEqual({ kind: "other" }); // Bash reads command: nothing runs
  expect(classify(tool("x", "shell"), { command: "echo harmless", cmd: "touch M" }, ws).kind).toBe("refused"); // no definition says which one runs
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
  // Each family asks to leave the sandbox with its own parameter, and only with its own.
  const claude = { properties: { command: {}, dangerouslyDisableSandbox: {} } };
  expect(classify(tool("Bash", "shell", false, claude), { command: "git gc", dangerouslyDisableSandbox: true }, ws)).toEqual({ kind: "shell", command: "git gc", escalate: true, cwd: ws });
  expect(classify(tool("Bash", "shell", false, claude), { command: "git gc", dangerouslyDisableSandbox: "true" }, ws)).toEqual({ kind: "shell", command: "git gc", cwd: ws });
  expect(classify(tool("exec_command", "shell", false, escalating), { cmd: "git gc", dangerouslyDisableSandbox: true }, ws)).toEqual({ kind: "shell", command: "git gc", cwd: ws });
  // It is asked of the owner in every mode that has a sandbox, and refused in a read-only session.
  const out = { kind: "shell" as const, command: "git gc", escalate: true, cwd: ws };
  expect(["full-auto", "auto-edits", "ask"].map((m) => kind(decide(out, facts(m as Mode, { sandboxed: true }))))).toEqual(["ask-high", "ask-high", "ask-high"]);
  expect(kind(decide(out, facts("read-only", { sandboxed: true })))).toBe("deny");
  expect(escapeOf(tool("Bash", "shell", false, claude))).toContain("dangerouslyDisableSandbox: true");
  expect(escapeOf(tool("exec_command", "shell", false, escalating))).toContain('sandbox_permissions: "require_escalated"');
  expect(escapeOf(tool("Bash", "shell"))).toBe("If the command is needed, ask the owner to run it outside the sandbox.");
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

// The menu shows a mode by its summary alone. What a mode lets run without
// the owner must be in those words: a summary that says "ask" for a call
// that runs is a promise the gate does not keep.
test("a mode's summary names what runs without asking", () => {
  const said = (id: Mode) => MODES.find((m) => m.id === id)!.summary.toLowerCase();
  const sh = (command: string) => ({ kind: "shell" as const, command });
  const edit = (p: string) => ({ kind: "edit" as const, paths: [p] });
  // Ask: a read-only command and a granted one run.
  expect(kind(decide(sh("git status"), facts("ask")))).toBe("allow");
  expect(kind(decide(sh("npm test"), facts("ask", { rules: [rule("shell", "npm test *")] })))).toBe("allow");
  expect(said("ask")).toContain("reads run");
  expect(said("ask")).toContain("unless granted");
  // Auto edits: a command runs unasked when it is read-only or the sandbox is on; an edit outside the folder asks.
  expect(kind(decide(sh("npm test"), facts("auto-edits", { sandboxed: true })))).toBe("allow");
  expect(kind(decide(sh("git status"), facts("auto-edits")))).toBe("allow");
  expect(kind(decide(sh("npm test"), facts("auto-edits")))).toBe("ask-low");
  expect(kind(decide(edit("/elsewhere/a.ts"), facts("auto-edits")))).toBe("ask-low");
  for (const word of ["folder edits run", "read-only", "sandboxed"]) expect(said("auto-edits")).toContain(word);
  // Read only: a read-only command runs, anything else is refused, nothing asks.
  expect(kind(decide(sh("git status"), facts("read-only")))).toBe("allow");
  expect(kind(decide(sh("npm test"), facts("read-only")))).toBe("deny");
  expect(said("read-only")).toContain("read-only commands");
  // No summary of a mode where a model or nobody decides says the owner is asked for ordinary work.
  for (const id of ["auto", "full-auto", "read-only", "plan"] as Mode[]) expect(said(id)).not.toMatch(/\bask/);
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

test("a command another interpreter runs is never read as a read", () => {
  const exec = { ...tool("exec_command", "shell"), interpreter: (i: any) => i?.shell || "bash" };
  const cls = (input: any) => classify(exec, input, ws);
  // Python reads this line as a write; bash reads it as `cat` with three words.
  const py = { cmd: `cat = f'{open("f","w")}'`, shell: "python3", login: false };
  expect(cls(py)).toMatchObject({ kind: "shell", interpreter: "python3" });
  for (const input of [py, { cmd: "ls", shell: "fish" }, { cmd: "ls", shell: "sh" }, { cmd: "ls", shell: "/tmp/x/bash" }]) {
    expect([input.shell, kind(decide(cls(input), facts("read-only")))]).toEqual([input.shell, "deny"]);
    expect([input.shell, kind(decide(cls(input), facts("ask")))]).toEqual([input.shell, "ask-low"]);
  }
  for (const input of [{ cmd: "ls" }, { cmd: "ls", shell: "bash" }, { cmd: "ls", shell: "/bin/bash" }, { cmd: "ls", shell: "/usr/bin/bash" }]) {
    expect(cls(input)).toEqual({ kind: "shell", command: "ls", cwd: ws });
    expect(kind(decide(cls(input), facts("read-only")))).toBe("allow");
  }
  // A grant still covers it, and the risk rules still read it.
  expect(kind(decide(cls({ cmd: "npm test", shell: "zsh" }), facts("ask", { rules: [rule("shell", "npm test *")] })))).toBe("allow");
  expect(kind(decide(cls({ cmd: "git push --force", shell: "zsh" }), facts("ask")))).toBe("ask-high");
  const d = decide(cls({ cmd: "ls", shell: "fish" }), facts("read-only"));
  expect("deny" in d && d.deny).toContain("run it with bash");
  // Only bash's own script is unwrapped from an argument list; the words of any other are quoted as words.
  // (An argument list is what an external agent's shell call carries; Keel's own tools take text.)
  expect(shellText({ command: ["bash", "-lc", "git status"] })).toBe("git status");
  expect(shellText({ command: ["sh", "-c", "ls"] })).toBe("sh -c ls");
  const argv = { kind: "shell" as const, command: shellText({ command: ["find", ".", "'", "-delete", "-name", "'"] })!, cwd: ws };
  expect(kind(decide(argv, facts("read-only")))).toBe("deny");
  expect(kind(decide(argv, facts("ask")))).toBe("ask-low");
});

test("a Read only session and the owner's card are told the form of a command that would be read as a read", () => {
  const ro = (command: string) => decide({ kind: "shell", command }, facts("read-only"));
  const ask = (command: string) => decide({ kind: "shell", command }, facts("ask"));
  // A substitution that prints commit hashes cannot add an option: a read.
  expect(kind(ro("git diff $(git merge-base main HEAD)"))).toBe("allow");
  const tag = ro("git log $(git describe --tags --abbrev=0)..HEAD");
  expect("deny" in tag && tag.deny).toContain("quote it after written-out text");
  expect(kind(ro('git log "refs/tags/$(git describe --tags --abbrev=0)..HEAD"'))).toBe("allow");
  const files = ask("rg foo $(git ls-files)");
  expect("ask" in files && files.ask.notice).toContain("put -- before it");
  expect(kind(ask("rg foo -- $(git ls-files)"))).toBe("allow");
  const find = ro("find . $X");
  expect("deny" in find && find.deny).toContain("write the value out");
  // A command that writes gets no such hint, on the refusal or on the card.
  const plain = ro("git commit -m x");
  expect("deny" in plain && plain.deny).not.toContain("write the value out");
  const card = ask("sort -o out $f");
  expect("ask" in card && card.ask.notice).toBeUndefined();
});
