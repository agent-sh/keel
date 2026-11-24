// What the gate reads of a git command an agent in its own worktree runs: a branch it did not make is not its to move,
// rename or delete; its own, and the ones it makes, are.
import { expect, test } from "bun:test";
import { sharedRefusal, sharedMessage, gitStoreOf, type Shared } from "./shared-branches.ts";

const s: Shared = {
  root: "/r/wt", gitDir: "/r/.git/worktrees/wt", common: "/r/.git", branch: "keel/me", base: "main",
  out: new Map([["main", "/r"]]), folders: ["/r"], gitDirs: ["/r/.git"],
  // Branches that exist and are not this worktree's: the owner's release line, another agent's, one left behind.
  foreign: () => new Set(["release/1.0", "keel/agent-2", "old-work"]),
};
const refused = (line: string) => sharedRefusal(line, s.root, "/home/u", s);

test("a branch that exists and is not this worktree's is not moved, renamed or deleted", () => {
  for (const line of [
    "git update-ref refs/heads/keel/agent-2 HEAD",
    "git update-ref -d refs/heads/release/1.0",
    "git branch -f old-work HEAD",
    "git branch -m keel/agent-2 keel/agent-3",
    "git branch -m old-work keel/me-2",
    "git branch -M keel/me release/1.0",
    "git branch -D keel/agent-2",
    "git branch -d release/1.0 old-work",
    "git push . HEAD:keel/agent-2",
    "git push . +HEAD:refs/heads/release/1.0",
    "git push --delete . old-work",
    "git checkout -B old-work",
    "git switch -C keel/agent-2 HEAD",
    "git worktree add -B old-work ../x",
    "git fetch . other:old-work",
    "git checkout old-work",
    "cd /r/wt && git branch -D keel/agent-2",
  ]) expect([line, refused(line) !== null]).toEqual([line, true]);
});

test("the reason names the branch and says it is not this worktree's", () => {
  const why = refused("git branch -D keel/agent-2")!;
  expect(why).toContain("the branch keel/agent-2, which this worktree did not make");
  expect(sharedMessage(why, s)).toContain("keel/me");
  expect(refused("git branch -m main x")).toContain("which another checkout has out");
});

test("its own branch, the branches it makes and ordinary work are not refused", () => {
  for (const line of [
    "git commit -qm x",
    "git branch -f keel/me HEAD",
    "git branch keel/me-sub",
    "git branch -m keel/me-sub keel/me-sub2",
    "git branch -D keel/me-sub2",
    "git update-ref refs/heads/keel/new HEAD",
    "git checkout -b keel/new2 && git branch -D keel/new2",
    "git checkout -B keel/new3",
    "git push origin keel/me",
    "git push . HEAD:keel/me",
    "git checkout --detach release/1.0",
    "git checkout old-work -- README.md",
    "git branch --list 'keel/*'",
    "git branch -a",
    "git log keel/agent-2..HEAD",
    "git merge keel/agent-2",
    "git rebase main",
    "git diff release/1.0 -- a.txt",
  ]) expect([line, refused(line)]).toEqual([line, null]);
});

test("with no list of branches the rule is the one for the base and the checkouts' branches", () => {
  const bare: Shared = { ...s, foreign: undefined };
  expect(sharedRefusal("git branch -D keel/agent-2", s.root, "/home/u", bare)).toBeNull();
  expect(sharedRefusal("git branch -D main", s.root, "/home/u", bare)).not.toBeNull();
});

test("the list of the branches this worktree made is written by git alone", () => {
  expect(gitStoreOf("/r/.git/worktrees/wt/keel-made-branches", s)).not.toBeNull();
  expect(sharedRefusal("echo refs/heads/old-work >> /r/.git/worktrees/wt/keel-made-branches", s.root, "/home/u", s)).not.toBeNull();
});
