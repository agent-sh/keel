import { expect, test } from "bun:test";
import { endedWell, worktreesAdded } from "./made-places.ts";

const H = "/h";
const added = (cmd: string, cwd = "/h/repo") => worktreesAdded(cmd, cwd, H);

test("the worktrees a line adds are the paths it spells out, from where it runs", () => {
  expect(added("git worktree add -b lane/x /h/.cache/wt/x main")).toEqual(["/h/.cache/wt/x"]);
  expect(added("git worktree add ~/.cache/wt/y")).toEqual(["/h/.cache/wt/y"]);
  expect(added("cd /h/proj && git worktree add -q ../wt/z HEAD")).toEqual(["/h/wt/z"]);
  expect(added("git -C /h/other worktree add --detach wt/r main")).toEqual(["/h/other/wt/r"]);
  expect(added("git worktree add -B b --quiet /h/a/b/ main; git worktree add /h/a/c")).toEqual(["/h/a/b", "/h/a/c"]);
  // A variable the line sets to a literal is read; one it does not set, or builds as it runs, is not.
  expect(added("p=$HOME/.cache/w; I=$p/wt-1; git worktree add -q \"$I\" main")).toEqual(["/h/.cache/w/wt-1"]);
  expect(added("git worktree add \"$I\" main")).toEqual([]);
  expect(added("I=$(mktemp -d); git worktree add $I main")).toEqual([]);
  expect(added("git worktree add /h/a/* main")).toEqual([]);
  expect(added("git worktree add \"$(mktemp -d)\" main")).toEqual([]);
});

test("a line that only mentions a worktree add adds none", () => {
  expect(added("echo 'git worktree add /h/a/b'")).toEqual([]);
  expect(added("git worktree list")).toEqual([]);
  expect(added("git worktree remove /h/a/b")).toEqual([]);
  expect(added("git worktree add")).toEqual([]);
  expect(added("grep 'worktree add' notes.md")).toEqual([]);
  // (Not a command line a shell would run.)
  expect(added("git worktree add '/h/a/b")).toEqual([]);
});

test("a call made nothing when its result says it failed", () => {
  expect(endedWell("Preparing worktree (new branch 'x')\nHEAD is now at abc1234 msg")).toBe(true);
  expect(endedWell("")).toBe(true);
  expect(endedWell("Exit code 1\nsome output")).toBe(false);
  expect(endedWell("fatal: '/h/a/b' already exists")).toBe(false);
  expect(endedWell("ok", true)).toBe(false);
});
