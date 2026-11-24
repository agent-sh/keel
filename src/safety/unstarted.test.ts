// A turn nobody started merges, approves, turns on auto-merge and force-pushes nothing, in every mode.
import { expect, test } from "bun:test";
import { decide, type Facts, type Mode } from "./policy.ts";
import { splitCommand } from "./shell.ts";
import { unstartedAct } from "./unstarted.ts";

const MODES = ["ask", "auto-edits", "auto", "full-auto", "read-only", "plan", "reviewer"] as const satisfies readonly Mode[];
const facts = (mode: Mode, byOwner?: () => boolean): Facts => ({ mode, workspace: "/w/repo", sandboxed: false, rules: [], tool: "Bash", home: "/h", ...(byOwner ? { byOwner } : {}) });
const run = (mode: Mode, command: string, byOwner?: () => boolean) => decide({ kind: "shell", command, cwd: "/w/repo" } as any, facts(mode, byOwner));

const REFUSED = [
  "gh pr merge 12 --squash", "gh pr merge 12 --auto --squash", "gh pr merge --admin", "gh pr merge", "gh pr -R o/r merge 12", "gh pr merge 12 -R o/r", "/usr/bin/gh pr merge 3",
  "gh pr review 12 --approve", "gh pr review 12 -a -b ok", "gh pr review --approve=true 12",
  "gh api -X PUT repos/o/r/pulls/12/merge", "gh api repos/o/r/pulls/12/merge --method PUT -f merge_method=squash", "gh api /repos/o/r/pulls/12/merge -XPUT", "gh api https://api.github.com/repos/o/r/pulls/12/merge -X PUT",
  "gh api -X POST repos/o/r/merges -f base=main -f head=x", "gh api repos/o/r/pulls/12/reviews -f event=APPROVE",
  "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
  "gh api graphql -f query='mutation { addPullRequestReview(input: {pullRequestId: \"x\", event: APPROVE}) { clientMutationId } }'",
  "gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc -F force=true",
  "git push --force", "git push -f origin main", "git push origin main --force-with-lease", "git push --force-with-lease=main:abc origin main", "git push origin +main", "git push origin +HEAD:main", "git push -fu origin x",
  "git -C /w/other push --force", "git -c push.default=simple push -f", "git push --mirror", "git push --force-if-includes origin x",
  "glab mr merge 4", "glab mr approve 4",
  "cd /w/repo && git status && gh pr merge 12", "FOO=1 gh pr merge 12", "env GH_TOKEN=x gh pr merge 12", "bash -c 'gh pr merge 12'", "sh -c \"git push -f origin x\"", "eval 'gh pr merge 12'", "echo 1 | xargs gh pr merge",
];
const ALLOWED = [
  "gh pr view 12", "gh pr list", "gh pr create --fill", "gh pr comment 12 -b merge", "gh pr review 12 --comment -b ok", "gh pr review 12 -r -b no", "gh pr checks 12", "gh pr diff 12",
  "gh api repos/o/r/pulls/12/merge", "gh api repos/o/r/pulls/12", "gh api repos/o/r/pulls/12/reviews", "gh api repos/o/r/pulls/12/reviews -f event=COMMENT -f body=x", "gh api graphql -f query='query { viewer { login } }'",
  "git push", "git push origin main", "git push -u origin feature", "git push --force-with-lease-not-a-flag-no", "git log --oneline", "git commit -m 'git push -f'", "echo gh pr merge 12", "cat > notes.md <<'EOF'\ngh pr merge 12\nEOF", "git push origin HEAD:refs/heads/x",
];

test("a turn nobody started is refused every merge, approval, auto-merge and force push, in every mode", () => {
  for (const command of REFUSED) {
    expect([command, unstartedAct(splitCommand(command)) !== null]).toEqual([command, true]);
    for (const mode of MODES) {
      const d = run(mode, command, () => false);
      expect([mode, command, "deny" in d ? d.deny.startsWith("Refused: the command") && d.deny.includes("no message of the owner's") : d]).toEqual([mode, command, true]);
    }
  }
});

test("a turn that holds the owner's message is not limited, and what is no such act is never refused", () => {
  for (const command of REFUSED) {
    for (const mode of MODES) {
      const d = run(mode, command, () => true);
      expect([mode, command, "deny" in d && d.deny.includes("no message of the owner's")]).toEqual([mode, command, false]);
    }
  }
  for (const command of ALLOWED) {
    expect([command, unstartedAct(splitCommand(command))]).toEqual([command, null]);
    for (const mode of MODES) {
      const d = run(mode, command, () => false);
      expect([mode, command, "deny" in d && d.deny.includes("no message of the owner's")]).toEqual([mode, command, false]);
    }
  }
  // No fact about the turn: nothing is limited (trial replays, tools that decide without a session).
  expect("deny" in run("full-auto", "gh pr merge 12")).toBe(false);
});

test("the owner's check is asked only when a command could be one of those acts", () => {
  let asked = 0;
  run("auto", "git status && ls", () => (asked++, false));
  expect(asked).toBe(0);
  run("auto", "gh pr merge 1", () => (asked++, false));
  expect(asked).toBe(1);
});
