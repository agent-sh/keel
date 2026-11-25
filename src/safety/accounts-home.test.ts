// `git -C ~/folder`: the account rules place the write in the home folder the shell writes out, and only there.
import { expect, test } from "bun:test";
import { parseNamespaces, type Remotes } from "./accounts.ts";
import type { Looked } from "./looked.ts";
import { decide, type Mode } from "./policy.ts";

const remotes = (origin: string): Remotes => ({ fetch: { origin }, push: { origin: [origin] }, resolved: {} });
const mine = "https://github.com/me/repo.git", theirs = "https://github.com/them/lib.git";
const disk: Record<string, Remotes> = {
  "/home/u/ws": remotes(mine), "/home/u/own": remotes(mine), "/home/u/clone": remotes(theirs),
  // A folder named `~` where the command runs, and the folder another HOME would make of `~/own`.
  "/home/u/ws/~/own": remotes(theirs), "/elsewhere/own": remotes(theirs),
};
const looked = (): Looked => ({ kept: () => ({ n: 0 }), exists: () => "dir", targets: () => null, read: () => null, remotes: (d) => disk[d] ?? null, manifest: () => null, hostname: () => null });
const facts = (mode: Mode) => ({ mode, workspace: "/home/u/ws", sandboxed: false, rules: [], tool: "t", home: "/home/u", looked: looked(), accounts: { names: parseNamespaces(["me"]) } });
// What the account rules make of a line: null when they ask nothing, the namespace named, or "unplaced".
const where = (command: string, mode: Mode = "full-auto") => {
  const d = decide({ kind: "shell", command, cwd: "/home/u/ws" }, facts(mode));
  return "ask" in d && d.ask.account !== undefined ? d.ask.account || "unplaced" : null;
};

test("git -C ~/folder is placed in the home folder: the owner's repository runs, another's asks by its name", () => {
  for (const mode of ["ask", "auto", "full-auto"] as Mode[]) {
    expect([mode, where("git -C ~/own push -q origin main", mode)]).toEqual([mode, null]);
    expect([mode, where("git -C ~/clone push", mode)]).toEqual([mode, "github.com/them/lib"]);
  }
  const rows: [string, string | null][] = [
    ["git -C ~/own push origin main 2>&1 | tail -1", null],
    ["cd /home/u/clone; git -C ~/own merge -q --ff-only x && git -C ~/own push -q origin main", null],
    ["cd /home/u/own && git -C ~/clone push", "github.com/them/lib"],
    ["p=$HOME/.cache/x; echo $p; git -C ~/own push", null],
    ["git -c user.name=x -C ~/own push", null],
  ];
  for (const [command, want] of rows) expect([command, where(command)]).toEqual([command, want]);
});

test("a ~ the shell does not write out as the home folder is not placed", () => {
  const rows: string[] = [
    // Quoted or escaped: git is given the `~` itself, a folder of that name where it runs.
    'git -C "~/own" push',
    "git -C '~/own' push",
    "git -C \\~/own push",
    // The line may give HOME another value.
    "HOME=/elsewhere; git -C ~/own push",
    "export HOME=/elsewhere && git -C ~/own push",
    "HOME=/elsewhere git -C ~/own push",
    "declare -x HOME; git -C ~/own push",
    "read HOME < f; git -C ~/own push",
    "unset HOME; git -C ~/own push",
    'eval "$x"; git -C ~/own push',
    "source ./env.sh; git -C ~/own push",
    ". ./env.sh && git -C ~/own push",
    // A script another shell is given: whose home that shell has is not in the line's words.
    'bash -c "git -C ~/own push"',
    "sudo -u other bash -c 'git -C ~/own push'",
    'HOME=/elsewhere bash -c "git -C ~/own push"',
    // Something else the shell makes.
    "git -C ~other/own push",
    "git -C ~/$X push",
    "git -C ~/ow* push",
    "git -C ~/{own,clone} push",
    "git -C ~+/own push",
  ];
  for (const command of rows) expect([command, where(command)]).toEqual([command, "unplaced"]);
});
