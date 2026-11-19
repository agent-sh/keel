import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { claudeAllow, rustRule } from "./port-permissions.ts";

// What maps one to one, what is already so in Keel, and what stays out.
test("Claude Code allow rules map only where the meaning is the same", () => {
  const cases: [string, unknown][] = [
    ["Bash", { kind: "shell", pattern: "*" }],
    ["Bash(*)", { kind: "shell", pattern: "*" }],
    ["Bash(npm run *)", { kind: "shell", pattern: "npm run *" }],
    ["Bash(git log:*)", { kind: "shell", pattern: "git log *" }],
    ["Bash(gh --version)", { kind: "shell", pattern: "gh --version" }],
    // Quotes are gone in the words Keel matches; escaped parentheses are literal.
    ['Bash(python3 -c "print\\(1\\)")', { kind: "shell", pattern: "python3 -c print(1)" }],
    ["Bash(ls*)", { kind: "shell", pattern: "ls*" }],
    ["Bash(git * main)", { kind: "shell", pattern: "git * main" }],
    ["Edit(//srv/app/**)", { kind: "edit", pattern: "/srv/app" }],
    ["Edit(~/notes/**)", { kind: "edit", pattern: `${homedir()}/notes` }],
    ["mcp__github__get_issue", { kind: "tool", pattern: "github__get_issue" }],
  ];
  for (const [rule, want] of cases) expect({ rule, m: claudeAllow(rule) }).toEqual({ rule, m: want as any });
  for (const rule of ["Read(//home/**)", "WebFetch", "WebFetch(domain:example.com)", "Grep"]) expect(claudeAllow(rule)).toHaveProperty("done");
  for (const rule of ["Bash(cat x | wc -l)", "Bash(ls ~/p/*/ 2>/dev/null | head *)", "Bash(echo hi > out.txt)", 'Bash(grep "a*b" f)', "Edit(/src/**/*.ts)", "Edit(src/**)",
    "Write", "mcp__github", "mcp__github__get_*", "Agent", "bash /x/run.sh"]) expect({ rule, m: claudeAllow(rule) }).toEqual({ rule, m: { skip: expect.any(String) } as any });
});

test("Rust Keel stored answers map by kind", () => {
  expect(rustRule("shell_prefix", "cargo test")).toEqual({ kind: "shell", pattern: "cargo test *" });
  expect(rustRule("shell_exact", "make lint")).toEqual({ kind: "shell", pattern: "make lint" });
  expect(rustRule("path_write", "/data/out")).toEqual({ kind: "edit", pattern: "/data/out" });
  expect(rustRule("path_read", "/tmp")).toHaveProperty("done");
  for (const k of ["workspace_trust", "net_host", "stdin_exact", "machine_prefix"]) expect(rustRule(k, "*")).toHaveProperty("skip");
});
