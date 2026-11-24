import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bornDuring, endedWell, worktreesAdded } from "./made-places.ts";

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

test("a result of the gpt family's shell or of a command still running shows nothing made", () => {
  expect(endedWell("Chunk ID: a1\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nok")).toBe(true);
  expect(endedWell("Chunk ID: a1\nWall time: 0.1 seconds\nProcess exited with code 128\nOutput:\nx")).toBe(false);
  expect(endedWell("Chunk ID: a1\nWall time: 1.0 seconds\nProcess running with session ID 3\nOutput:\n")).toBe(false);
  expect(endedWell("Command did not complete within its 120s timeout and was moved to the background with ID: b1. Output is being written to: /x")).toBe(false);
  expect(endedWell("Command running in background with ID: b1. Output is being written to: /x")).toBe(false);
  expect(endedWell("Command moved to the background.\nBackground PIDs: 12")).toBe(false);
});

test("a folder was made by a call only when its .git file was born while the call ran", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-born-"));
  try {
    const before = Date.now();
    writeFileSync(join(dir, ".git"), "gitdir: /x/.git/worktrees/w\n");
    const after = Date.now();
    expect(bornDuring(dir, before, after)).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    // A call that began and ended later than the folder's birth made nothing of it.
    expect(bornDuring(dir, Date.now() - 100, Date.now())).toBe(false);
    // One that ended before it was born did not make it either.
    expect(bornDuring(dir, before - 5000, before - 1000)).toBe(false);
    expect(bornDuring(join(dir, "none"), before, after)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
