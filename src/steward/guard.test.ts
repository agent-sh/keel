import { expect, test } from "bun:test";
import { commandRefusal, toolRefusal } from "./guard.ts";

const B = "keel/fix-it";
const refused = (c: string) => commandRefusal(c, B);

test("a turn of the watch may push its own branch, plainly", () => {
  for (const c of ["git push", "git push origin", "git push origin HEAD", `git push origin ${B}`, `git push -u origin ${B}`, `git push origin HEAD:${B}`, "git add -A && git commit -m x && git push", "git status && git fetch origin"]) {
    expect(refused(c), c).toBeNull();
  }
});

test("it may not push another branch, force, delete or push wide", () => {
  for (const c of ["git push origin main", "git push origin HEAD:main", "git push --force", "git push -f origin", "git push --force-with-lease", `git push origin +${B}`, `git push origin :${B}`, `git push --delete origin ${B}`, "git push --all", "git push --tags", "git push upstream", "git -c x=y push", "git push origin 'a*:b'"]) {
    expect(refused(c), c).toContain("Refused: this turn belongs to PR Steward");
  }
});

test("it may not merge, approve, turn on auto-merge or close, in any wrapping", () => {
  for (const c of [
    "gh pr merge 12", "gh pr merge 12 --auto --squash", "gh -R a/b pr merge 12", "env GH_TOKEN=x gh pr merge", "sudo gh pr merge 1", "nice -n 5 gh pr merge 1",
    "gh pr review 12 --approve", "gh pr review --approve -b ok", "gh pr close 12", "gh pr reopen 12", "gh pr edit 1 --enable-auto-merge",
    "gh api -X PUT repos/a/b/pulls/12/merge", "gh api repos/a/b/pulls/12/merge -f merge_method=squash",
    "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    "gh api repos/a/b/pulls/12/reviews -f event=APPROVE",
    "bash -c 'gh pr merge 12'", "sh -c \"cd x && gh pr merge 12\"", "echo go; gh pr merge 3", "x=$(gh pr merge 3)",
    "curl -X PUT https://api.github.com/repos/a/b/pulls/12/merge", "gh $verb 3",
  ]) {
    expect(refused(c), c).toContain("Refused: this turn belongs to PR Steward");
  }
});

test("reading and commenting stay allowed", () => {
  for (const c of ["gh pr view 12", "gh pr checks 12", "gh pr comment 12 -b 'fixed in abc'", "gh pr review 12 --comment -b ok", "gh run view 5 --log-failed", "gh api repos/a/b/pulls/12/comments", "bash -c 'git status'", "bun test", "echo merge approve"]) {
    expect(refused(c), c).toBeNull();
  }
});

test("a line it cannot read that names gh or git is refused, one that does not is let through", () => {
  expect(refused("gh pr merge 'unclosed")).toContain("Refused");
  expect(refused("echo 'unclosed")).toBeNull();
});

test("a connected server's merge and approve tools are refused", () => {
  expect(toolRefusal("mcp__github__merge_pull_request", B)).toContain("Refused");
  expect(toolRefusal("github.approve", B)).toContain("Refused");
  expect(toolRefusal("mcp__github__get_pull_request", B)).toBeNull();
  expect(toolRefusal("Bash", B)).toBeNull();
});
