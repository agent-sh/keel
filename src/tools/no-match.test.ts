import { expect, test } from "bun:test";
import { noMatch, silentExit } from "./no-match.ts";

test("exit 1 of a search or compare program that sets the status is no match", () => {
  for (const c of [
    "grep foo file", "rg -n foo src", "diff a b", "cmp a b", "test -f x", "[ -f x ]", "git diff --exit-code",
    "cd /tmp && grep foo x", "ls; grep foo x", "cat x | grep foo", "FOO=1 grep foo x", "grep foo x 2>&1", "grep foo x > out.txt",
    "ls\ngrep foo x", "x=1 && cd a; rg foo", "false || grep foo x", "/usr/bin/grep foo x",
    // A yes-or-no answer of git: not an ancestor. The echo behind `&&` ran only when the answer was yes.
    "git merge-base --is-ancestor A B", "git -C /r merge-base --is-ancestor A B", "git merge-base --is-ancestor A B && echo yes",
    "cd /r && git merge-base --is-ancestor A B && echo ancestor && echo more", "git merge-base --is-ancestor A B && printf 'yes\\n'",
    "grep foo x && echo found",
  ]) expect([c, noMatch(c, 1)]).toEqual([c, true]);
});

test("other codes, other programs and a masked or unknown status are failures", () => {
  expect(noMatch("grep foo x", 2)).toBe(false);
  expect(noMatch("grep foo x", 0)).toBe(false);
  expect(noMatch("grep foo x", null)).toBe(false);
  for (const c of [
    "make test", "grep foo x; make", "grep foo x | head", "make && grep foo x", "find . -name x", "git status",
    "grep foo x &", "(cd a && grep foo x)", "if grep foo x; then echo y; fi", "echo 'open grep foo", "grep foo x; (exit 1)",
    // Not the yes-or-no form (a merge base is asked for), an echo that is not behind `&&`, work after the answer.
    "git merge-base A B", "git merge-base --is-ancestor A B; echo no", "git merge-base --is-ancestor A B || echo no",
    "git merge-base --is-ancestor A B && make", "echo yes",
  ]) expect([c, noMatch(c, 1)]).toEqual([c, false]);
});

test("a call whose failing command prints nothing says so (what it printed is from commands before it)", () => {
  for (const c of ["git merge-base --is-ancestor A B", "git log -1 --format=%s; git merge-base --is-ancestor A B && echo yes", "[ -f x ]", "test -d a", "git diff --quiet", "make; false"])
    expect([c, silentExit(c, 1)]).toEqual([c, true]);
  for (const c of ["make", "git merge-base A B", "grep foo x", "git diff", "make && echo done"]) expect([c, silentExit(c, 1)]).toEqual([c, false]);
  expect(silentExit("git merge-base --is-ancestor A B", 128)).toBe(false);
});
