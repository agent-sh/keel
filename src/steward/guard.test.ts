import { expect, test } from "bun:test";
import { commandRefusal, toolRefusal } from "./guard.ts";

const B = "keel/fix-it";
const G = { branch: B, repo: "a/b", number: 12, dir: "/w/tree", head: () => B as string | undefined, upstream: () => undefined as string | undefined };
const refused = (c: string, g: Partial<typeof G> = {}) => commandRefusal(c, { ...G, ...g });
const tool = (t: string) => toolRefusal(t, G);

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
  expect(tool("mcp__github__merge_pull_request")).toContain("Refused");
  expect(tool("github.approve")).toContain("Refused");
  expect(tool("mcp__github__get_pull_request")).toBeNull();
  expect(tool("Bash")).toBeNull();
});

test("gh is an allow-list: it reads, and it comments on this repository's pull requests", () => {
  for (const c of ["gh alias set x 'pr merge'", "gh pr edit 12 --title x", "gh pr create", "gh pr checkout 3", "gh workflow run ci.yml", "gh release create v1", "gh repo delete a/b --yes", "gh secret set X", "gh extension install x/y",
    "gh api -X POST repos/a/b/issues -f title=x", "gh api --method DELETE repos/a/b/git/refs/heads/x", "gh api repos/a/b/issues -f title=x", "gh api repos/a/b/pulls/12/comments --input body.json",
    "gh api graphql -f query='query { viewer { login } }'", "gh api -XPATCH repos/a/b", "gh api repos/other/repo/issues/1/comments -f body=x", "gh -R other/repo pr view 1", "gh pr comment 1 --repo x/y -b hi", "gh api repos/a/b/pulls/$N/comments"]) {
    expect(refused(c), c).toContain("Refused: this turn belongs to PR Steward");
  }
  for (const c of ["gh api repos/a/b/pulls/12/comments", "gh api -X GET repos/a/b/commits", "gh api repos/a/b/issues/12/comments -f body='fixed'", "gh api -X POST repos/a/b/pulls/12/comments/5/replies -f body=ok", "gh pr view 12 --json state", "gh run rerun 5 --failed", "gh -R a/b pr checks 12"]) {
    expect(refused(c), c).toBeNull();
  }
});

test("it may not change where git pushes, nor work in another repository", () => {
  for (const c of ["git remote set-url origin git@evil.example:a/b.git", "git remote add x y", "git config remote.origin.url x", "git config --global alias.p push", "git -C /other push", "git -C ../x status", "cd /other && git push", "cd ~", "cd", "cd ../..",
    "git switch other && git push", "git checkout -b other; git push", "GIT_DIR=/x git push", "export GIT_DIR=/x; git push", "GH_REPO=x/y gh pr view", "git worktree add ../w", "bash -c 'git remote -v; git config x y'"]) {
    expect(refused(c), c).toContain("Refused: this turn belongs to PR Steward");
  }
  for (const c of ["cd src && git status", "git -C /w/tree status", "git switch other", "git checkout -- file.ts", "git fetch origin && git merge origin/main && git push"]) expect(refused(c), c).toBeNull();
});

test("a push is judged by the branch the worktree is on, not the one the watch expects", () => {
  expect(refused("git push", { head: () => "main" })).toContain("must be on");
  expect(refused("git push origin HEAD", { head: () => undefined })).toContain("cannot tell");
  // The upstream the worktree really has: a push that follows it to another branch is refused.
  expect(refused("git push", { upstream: () => "origin/main" })).toContain("push to main");
  expect(refused("git push", { upstream: () => `origin/${B}` })).toBeNull();
  // A helper agent of the turn has no worktree of the watch's: it pushes nothing.
  expect(refused("git push", { dir: undefined, head: undefined })).toContain("helper");
  expect(refused("git status", { dir: undefined, head: undefined })).toBeNull();
});

test("a GitHub server's tools read and comment in this turn, and nothing else", () => {
  for (const t of ["mcp__github__create_issue", "mcp__github__create_pull_request", "mcp__github__update_pull_request", "github.push_files", "mcp__github__fork_repository", "mcp__github__delete_comment", "gh__create_branch", "scm__update_pull_request_branch"]) expect(tool(t), t).toContain("Refused");
  for (const t of ["mcp__github__get_pull_request", "mcp__github__list_commits", "mcp__github__search_issues", "mcp__github__add_issue_comment", "mcp__build__run_tests", "Bash"]) expect(tool(t), t).toBeNull();
});

test("curl to GitHub writes nothing", () => {
  for (const c of ["curl -X POST https://api.github.com/repos/a/b/issues -d '{}'", "curl -d x https://api.github.com/graphql", "wget --method=POST https://api.github.com/x"]) expect(refused(c), c).toContain("Refused");
  expect(refused("curl -s https://api.github.com/repos/a/b/pulls/12")).toBeNull();
});
