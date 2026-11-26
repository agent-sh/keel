// A turn nobody started merges, approves, turns on auto-merge and force-pushes nothing, in every mode.
import { expect, test } from "bun:test";
import { decide, type Facts, type Mode } from "./policy.ts";
import { splitCommand } from "./shell.ts";
import * as unattended from "./unstarted.ts";

const { unstartedAct } = unattended;

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
  // A request to a forge's merge or approve route by any program.
  "curl -X PUT -H 'Authorization: token x' https://api.github.com/repos/o/r/pulls/12/merge", "curl -XPUT https://api.github.com/repos/o/r/pulls/12/merge -d '{}'", "wget --method=PUT -qO- https://git.example.com/api/v3/repos/o/r/pulls/12/merge",
  "curl -X POST https://api.github.com/repos/o/r/merges -d '{\"base\":\"main\",\"head\":\"x\"}'", "glab api -X PUT projects/9/merge_requests/4/merge", "glab api projects/9/merge_requests/4/approve -X POST",
  "curl -d '{\"event\":\"APPROVE\"}' https://api.github.com/repos/o/r/pulls/12/reviews", "curl -d '{\"query\":\"mutation { mergePullRequest(input: {pullRequestId: 1}) { clientMutationId } }\"}' https://api.github.com/graphql",
  "python3 -c \"import urllib.request as u; u.urlopen(u.Request('https://api.github.com/repos/o/r/pulls/12/merge', method='PUT'))\"", "sh -c 'curl -X PUT https://api.github.com/repos/o/r/pulls/12/merge'",
  // gh api with the request in a file, and an alias made to run it by another name.
  "gh api graphql --input q.json", "gh api graphql -F query=@q.graphql", "gh api repos/o/r/pulls/12/reviews --input review.json", "gh api -X PATCH repos/o/r/git/refs/heads/main --input ref.json",
  "gh alias set m 'pr merge'", "gh alias set --shell mm '!gh pr merge $1'", "gh alias import aliases.yml",
  "git -c alias.p='push --force' p", "git -c alias.p=!sh p", "git --config-env=alias.p=PUSH p", "git config alias.p 'push -f'", "git config --global alias.m '!gh pr merge'", "git config --file x.cfg alias.p 'push -f'",
  // A push that deletes.
  "git push origin --delete feature", "git push --delete origin feature", "git push -d origin feature", "git push origin :feature", "git push origin :refs/tags/v1", "git push --prune origin", "git push origin --tags --prune",
  "cd /w/repo && git status && gh pr merge 12", "FOO=1 gh pr merge 12", "env GH_TOKEN=x gh pr merge 12", "bash -c 'gh pr merge 12'", "sh -c \"git push -f origin x\"", "eval 'gh pr merge 12'", "echo 1 | xargs gh pr merge",
];
const ALLOWED = [
  "gh pr view 12", "gh pr list", "gh pr create --fill", "gh pr comment 12 -b merge", "gh pr review 12 --comment -b ok", "gh pr review 12 -r -b no", "gh pr checks 12", "gh pr diff 12",
  "gh api repos/o/r/pulls/12/merge", "gh api repos/o/r/pulls/12", "gh api repos/o/r/pulls/12/reviews", "gh api repos/o/r/pulls/12/reviews -f event=COMMENT -f body=x", "gh api graphql -f query='query { viewer { login } }'",
  "gh alias list", "gh alias delete m", "git config alias.p", "git config --get alias.p", "git config user.name x", "git -c user.name=x commit -m y", "git config --list",
  "curl https://api.github.com/repos/o/r/pulls/12", "curl -X POST https://api.github.com/repos/o/r/pulls/12/comments -d '{}'", "curl -d '{\"event\":\"COMMENT\"}' https://api.github.com/repos/o/r/pulls/12/reviews",
  "curl -d '{\"query\":\"query { viewer { login } }\"}' https://api.github.com/graphql", "grep -rn mergePullRequest src", "cat repos/o/r/merges", "ls /w/repos/a/b/merges", "rg 'pulls/1/merge' docs",
  "git push --dry-run origin main", "git push origin HEAD:refs/heads/x:y", "git push origin feature:feature", "gh api repos/o/r/pulls/12/comments -f body=x",
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

test("an unreadable shell needs the owner, without hiding a known act beside it", () => {
  const line = "cat <<$X\ntext\n$X\nprintf done";
  for (const mode of MODES) {
    for (const command of [line, `bash -c '${line}'`]) {
      const d = run(mode, command, () => false);
      if (mode === "read-only" || mode === "plan") expect(d).toHaveProperty("deny", expect.stringContaining("could not be parsed"));
      else expect(d).toEqual({ ask: expect.objectContaining({ unparsed: true, ownerOnly: true, suggest: [] }) });
    }
    expect(run(mode, `bash -c '${line}'; gh pr merge 12`, () => false)).toHaveProperty("deny", expect.stringContaining("no message of the owner's"));
  }
});

test("an unreadable document fed to a shell asks, and its readable prefix keeps its verdict", () => {
  const continued = "bash <<'EOF'\nprintf %s $\\\n(true)\nprintf after\nEOF";
  const partial = "bash <<'EOF'\nprintf first\nprintf \"unfinished\nEOF";
  for (const line of [continued, partial])
    expect(run("full-auto", line, () => false)).toHaveProperty("ask.unparsed", true);
  expect(run("full-auto", partial.replace("printf first", "gh pr merge 12"), () => false))
    .toHaveProperty("deny", expect.stringContaining("no message of the owner's"));
  const f: Facts = { ...facts("full-auto", () => true), keel: (p) => p === "/state/record" ? "it changes Keel's state" : null };
  expect(decide({ kind: "shell", command: partial.replace("printf first", "printf note > /state/record"), cwd: f.workspace }, f))
    .toHaveProperty("deny", expect.stringContaining("Keel's state"));
  expect(run("full-auto", "cat <<'EOF'\nprintf \"unfinished\nEOF", () => false)).toHaveProperty("allow", true);
});

test("nesting above the old unstarted traversal limit is not a parse failure", () => {
  const nest = (n: number): string => n ? `bash -c ${JSON.stringify(nest(n - 1))}` : "printf done";
  for (let n = 5; n <= 8; n++) expect(run("full-auto", nest(n), () => false)).toHaveProperty("allow", true);
  expect(unstartedAct(splitCommand(nest(9)))).toBe(unattended.TOO_DEEP);
  expect(run("ask", nest(9), () => false)).toHaveProperty("ask.why", expect.stringContaining("deeper than the rules read"));
});

test("the unattended guard still reads long inline scripts", () => {
  const script = (n: number) => `# ${"padding ".repeat(n)}\n`;
  const merge = `bash -c '${script(2200)}gh pr merge 12'`;
  const force = [...Array.from({ length: 5 }, () => `bash -c '${script(450)}:'`), "eval 'git push --force origin main'"].join("\n");
  let nested = "gh pr merge 12";
  for (let n = 0; n < 6; n++) nested = `bash -c ${JSON.stringify(nested)}`;
  for (const line of [merge, force, nested])
    expect(run("full-auto", line, () => false)).toHaveProperty("deny", expect.stringContaining("no message of the owner's"));
});

test("unreadable documents keep the fallback text rules even where the shell feeder is not read", () => {
  const body = "<<'DOC'\nprintf \"unfinished\nrm -rf /h\nDOC";
  for (const line of [
    `bash <(cat ${body}\n)`,
    `cat > script.sh ${body}\nbash script.sh`,
    `ssh example.invalid bash ${body}`,
    `docker exec -i fixture sh ${body}`,
  ]) {
    expect(run("full-auto", line, () => false)).toMatchObject({ ask: { unparsed: true, ownerOnly: true, why: expect.stringContaining("deletes a root or home directory recursively") } });
    expect(run("auto", line, () => false)).toHaveProperty("deny", expect.stringContaining("never runs without the owner"));
  }
});

test("a readable high-risk part does not hide an unreadable document handed to another shell", () => {
  for (const shell of ["bash /dev/stdin", "bash -c 'sh -s'"]) {
    const line = `rm -rf /h\n${shell} <<'DOC'\nprintf "unfinished\nDOC`;
    expect(run("full-auto", line, () => false)).toMatchObject({ ask: { unparsed: true, ownerOnly: true, why: expect.stringContaining("deletes the home directory recursively") } });
  }
});

test("unreadable inline shell scripts keep the never-allowed text check", () => {
  const body = "'echo $\\\n(true)\nrm -rf /h'";
  for (const command of [
    `bash <<< ${body}`,
    `echo ${body} | bash`,
    `printf '%s\\n' ${body} | sh`,
    `watch -n1 ${body}`,
    `bash -c ${body}`,
    `eval ${body}`,
    `echo x | xargs -I{} sh -c ${body}`,
    `find . -maxdepth 0 -exec sh -c ${body} \\;`,
  ]) {
    expect({ command, verdict: run("auto", command) }).toMatchObject({ verdict: { deny: expect.stringContaining("never runs without the owner") } });
    expect(run("full-auto", command)).toHaveProperty("ask.unparsed", true);
  }
  expect(run("full-auto", `printf '%s\\n' ${body}`)).toHaveProperty("allow", true);
});
