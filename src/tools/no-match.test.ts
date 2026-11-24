import { expect, test } from "bun:test";
import { noMatch } from "./no-match.ts";

test("exit 1 of a search or compare program that sets the status is no match", () => {
  for (const c of [
    "grep foo file", "rg -n foo src", "diff a b", "cmp a b", "test -f x", "[ -f x ]", "git diff --exit-code",
    "cd /tmp && grep foo x", "ls; grep foo x", "cat x | grep foo", "FOO=1 grep foo x", "grep foo x 2>&1", "grep foo x > out.txt",
    "ls\ngrep foo x", "x=1 && cd a; rg foo", "false || grep foo x", "/usr/bin/grep foo x",
  ]) expect([c, noMatch(c, 1)]).toEqual([c, true]);
});

test("other codes, other programs and a masked or unknown status are failures", () => {
  expect(noMatch("grep foo x", 2)).toBe(false);
  expect(noMatch("grep foo x", 0)).toBe(false);
  expect(noMatch("grep foo x", null)).toBe(false);
  for (const c of [
    "make test", "grep foo x; make", "grep foo x | head", "make && grep foo x", "find . -name x", "git status",
    "grep foo x &", "(cd a && grep foo x)", "if grep foo x; then echo y; fi", "echo 'open grep foo", "grep foo x; (exit 1)",
  ]) expect([c, noMatch(c, 1)]).toEqual([c, false]);
});
