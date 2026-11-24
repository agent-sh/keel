// The pure rules of which memory lookups are made and which facts are given.
import { expect, test } from "bun:test";
import { namedPrograms } from "./memory-meter.ts";
import { afterAnswer, afterAsk, callFamilies, callTopics, freshYield, hitFamilies, toolAsk, toolKind, type KindYield } from "./memory-yield.ts";

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

test("a call's families: the programs of a shell line, the folders of a write, an MCP tool", () => {
  const sh = (command: string) => callFamilies({ tool_name: "Bash", tool_input: { command } }).sort();
  expect(sh("cd /home/x/repo && FOO=1 /usr/bin/git push")).toEqual(["cd", "git"]);
  expect(sh("sudo make install | tee out.log")).toEqual(["make", "tee"]);
  // Only the programs the line runs: not the words of a script, a quoted argument or a here-document.
  expect(sh("python3 - <<'EOF'\nthis announce 250\nrm -rf scratch-dir\nEOF")).toEqual(["python3"]);
  expect(sh("bun -e \"console.log(getComputedStyle(x).announce)\" && git commit -m 'fix 250 ab12cd3'")).toEqual(["bun", "git"]);
  expect(sh("echo $(date) | grep -c \"$(git rev-parse HEAD)\"")).toEqual(["date", "echo", "git", "grep"]);
  expect(sh("echo 'open quote")).toEqual(["echo"]);
  // Loop words, builtins that steer the line and functions the line defines are not programs.
  expect(sh("p() { sed -n 1p x; }; for i in a b; do p $i || break; done")).toEqual(["sed"]);
  expect(sh("git push origin main")).toEqual(sh("git push origin dev"));
  expect(callFamilies({ tool_name: "Edit", tool_input: { file_path: "/r/src/a.ts" } })).toEqual(["/r/src"]);
  expect(callFamilies({ tool_name: "Write", tool_input: { file_path: "a.ts" } })).toEqual(["."]);
  expect(callFamilies({ tool_name: "mcp__github__get_pr", tool_input: {} })).toEqual(["mcp__github__get_pr"]);
});

test("a hit speaks for the programs its facts name, else for the first program that is not trivial", () => {
  const sh = (command: string) => ({ tool_name: "Bash", tool_input: { command } });
  const line = "cd ~/x && git stash && ls | grep a";
  // A fact that names `git stash` in backquotes, or whose deny key does: git, not cd, ls or grep.
  expect(hitFamilies(sh(line), namedPrograms("- never-stash (past mistake): do not run `git stash` here."))).toEqual(["git"]);
  expect(hitFamilies(sh(line), namedPrograms("- never-stash (past mistake): shared refs.", (n) => (n === "never-stash" ? ["git stash"] : [])))).toEqual(["git"]);
  // A fact that names no program of the call: the call's first program that is not cd, ls, echo, grep and the like.
  expect(hitFamilies(sh(line), namedPrograms("- note: remember the build is slow."))).toEqual(["git"]);
  expect(hitFamilies(sh("cd x && echo hi | grep h"), [])).toEqual([]);
  // A program the fact names that the call does not run is not credited.
  expect(hitFamilies(sh("ls"), namedPrograms("- r: never `rm -rf` it."))).toEqual([]);
  // Writes and MCP tools keep their families.
  expect(hitFamilies({ tool_name: "Edit", tool_input: { file_path: "/r/src/a.ts" } }, [])).toEqual(["/r/src"]);
});
