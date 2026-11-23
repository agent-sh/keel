// Which shell commands are reads of local files: the files a printer is
// given, none when a program of the command can reach another machine.
import { expect, test } from "bun:test";
import { fileReads, resultText, shellReads } from "./work-calls.ts";

test("a shell command's file reads are the files its printers are given, never what another machine sends", () => {
  expect(shellReads("cat /w/BRIEF.md; echo ----; ./row.sh T-1")).toEqual(["/w/BRIEF.md"]);
  expect(shellReads("cd /w && sed -n '1,80p' src/a.ts | head -n 20")).toEqual(["src/a.ts"]);
  expect(shellReads("head -n 5 a.md b.md && tail -c 100 c.log")).toEqual(["a.md", "b.md", "c.log"]);
  expect(shellReads("nl -ba notes.md 2>/dev/null")).toEqual(["notes.md"]);
  expect(shellReads("cat a.md > b.md")).toEqual([]); // a copy
  expect(shellReads("curl -s https://x.example/r.md; cat r.md")).toEqual([]);
  expect(shellReads("ssh box cat /srv/r.md")).toEqual([]);
  expect(shellReads("git fetch && cat README.md")).toEqual([]);
  expect(shellReads("python3 - <<EOF\nprint(1)\nEOF")).toEqual([]);
  expect(shellReads("ls -la; git log -1")).toEqual([]);
  expect(fileReads("Read", { file_path: "/w/a.md" })).toEqual(["/w/a.md"]);
  expect(fileReads("exec_command", { cmd: "cat x.md" })).toEqual(["x.md"]);
  expect(fileReads("WebFetch", { url: "https://x" })).toEqual([]);
  expect(fileReads("mcp__fs__read", { file_path: "/w/a.md" })).toEqual([]);
  expect(resultText("1\tone\n2\ttwo")).toBe("one\ntwo");
});
