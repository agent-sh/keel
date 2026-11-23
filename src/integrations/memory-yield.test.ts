// The pure rules of which memory lookups are made and which facts are given.
import { expect, test } from "bun:test";
import { afterAnswer, afterAsk, callTopics, freshYield, toolAsk, toolKind, type KindYield } from "./memory-yield.ts";

test("a kind of tool call is asked in full until the store has had nothing for it many times in a row", () => {
  let y = freshYield();
  for (let i = 0; i < 4; i++) {
    expect(toolAsk(y, false, false, 4, 3)).toBe("full");
    y = afterAnswer(afterAsk(y, "full"), false);
  }
  // Quiet now: the session's first call of the kind, and one in three of the rest, are asked lightly.
  expect(toolAsk(y, true, false, 4, 3)).toBe("light");
  const seq: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = toolAsk(y, false, false, 4, 3);
    seq.push(a);
    y = afterAsk(y, a);
    if (a !== "skip") y = afterAnswer(y, false);
  }
  expect(seq).toEqual(["skip", "skip", "light", "skip", "skip", "light"]);
  // A call that names the store is always asked in full.
  expect(toolAsk(y, false, true, 4, 3)).toBe("full");
  // One answer with a fact and the kind is asked in full again.
  y = afterAnswer(y, true);
  expect(y).toEqual({ quiet: 0, passed: 0 });
  expect(toolAsk(y, false, false, 4, 3)).toBe("full");
});

test("a kind is a shell command, a file write, or one MCP server's tools", () => {
  expect(toolKind({ tool_name: "Bash", tool_input: { command: "ls" } })).toBe("shell");
  expect(toolKind({ tool_name: "Edit", tool_input: { file_path: "a" } })).toBe("edit");
  expect(toolKind({ tool_name: "apply_patch", tool_input: { command: "x" } })).toBe("edit");
  expect(toolKind({ tool_name: "mcp__github__get_pr", tool_input: {} })).toBe("mcp:github");
});

test("a call's topics: each command by its words as the store matches them, each file a write touches, an MCP tool", () => {
  const sh = (command: string) => callTopics({ tool_name: "Bash", tool_input: { command } }).sort();
  // The words after the program tell commands apart: a fact tied to "git push origin main" is not one tied to "git push origin x".
  expect(sh("git push origin main")).toEqual(["git push origin main", "push origin main"]);
  expect(sh("systemctl --user stop x")).toEqual(["systemctl --user stop x"]);
  expect(sh("systemctl --user stop x")).not.toEqual(sh("systemctl --user status x"));
  // As the store matches a fact's command: assignments skipped, the program by base name, and a program that runs the next word runs that word too.
  expect(sh("cd /home/x/repo && FOO=1 /usr/bin/git push")).toEqual(["cd /home/x/repo", "git push", "push", "repo"]);
  expect(sh("claude -p 'hi' | tee out.log")).toEqual(["claude -p 'hi'", "out.log", "tee out.log"]);
  expect(sh("sudo make install")).toEqual(["make install", "sudo make install"]);
  // A here-document's lines are parts too: the store matches a fact's command there.
  expect(sh("cat > x.sh <<'EOF'\nrm -rf build\nEOF")).toContain("rm -rf build");
  // A topic keeps the first words: a long command is cut there.
  expect(sh("a -1 -2 -3 -4 -5 -6 -7 -8 -9")).toEqual(["a -1 -2 -3 -4 -5 -6 -7"]);
  // A write's topic is the file itself: a rule tied to one file is asked with its first write.
  expect(callTopics({ tool_name: "Edit", tool_input: { file_path: "/r/src/a.ts" } })).toEqual(["/r/src/a.ts"]);
  expect(callTopics({ tool_name: "apply_patch", tool_input: { command: "*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** Update File: src/a.ts" } })).toEqual(["src/a.ts", "src/b.ts"]);
  expect(callTopics({ tool_name: "mcp__github__get_pr", tool_input: {} })).toEqual(["mcp__github__get_pr"]);
});

test("asks of a quiet kind keep their count across decisions", () => {
  const y: KindYield = { quiet: 2, passed: 1 };
  expect(afterAsk(y, "skip")).toEqual({ quiet: 2, passed: 2 });
  expect(afterAsk(y, "light")).toEqual({ quiet: 2, passed: 0 });
  expect(afterAsk(y, "full")).toEqual(y);
});
