// What a project's .mcp.json entry runs, and where its approvals are kept.
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentKey, isAgentKey, projectFile, projectKey, runnable } from "./project.ts";

test("a project server's address and headers read none of the owner's variables; its command does as Claude Code does", () => {
  const env = { DATABASE_URL: "postgres://u:pw@db/x", GH_PAT: "ghp_x", SENTRY_DSN: "https://k@s/1", NPM_AUTH: "npmA", OPENAI_API_KEY: "sk-x", HOME: "/h" };
  const http = runnable({ type: "http", url: "https://x.example/mcp?a=${DATABASE_URL}&b=${GH_PAT}&r=${REGION:-eu}", headers: { A: "${SENTRY_DSN}", B: "Bearer ${NPM_AUTH}" } }, env);
  expect(http.url).toBe("https://x.example/mcp?a=&b=&r=eu");
  expect(http.headers).toEqual({ A: "", B: "Bearer " });
  const stdio = runnable({ command: "${HOME}/bin/srv", args: ["--home=${HOME}"], env: { T: "${OPENAI_API_KEY}" } }, env);
  expect(stdio).toMatchObject({ command: "/h/bin/srv", args: ["--home=/h"], env: { T: "sk-x" } });
});

test("a worktree of a repository keeps its approvals under the main checkout", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "keel-project-")));
  const main = join(dir, "main"), wt = join(dir, "wt");
  mkdirSync(join(main, "sub"), { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { stdio: "ignore" });
  git("init", "-q", main);
  writeFileSync(join(main, ".mcp.json"), "{}");
  git("-C", main, "add", "-A");
  git("-C", main, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
  git("-C", main, "worktree", "add", "-q", "--detach", wt);
  expect(projectKey(main)).toBe(main);
  expect(projectKey(wt)).toBe(main);
  // The file is the worktree's own, found from a folder below it.
  mkdirSync(join(wt, "deep"), { recursive: true });
  expect(projectFile(join(wt, "deep"))).toEqual({ root: wt, file: join(wt, ".mcp.json") });
});

test("a project folder whose name ends in .md is a project's key, not an agent file's", () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "keel-agent-key-")));
  mkdirSync(join(d, "notes.md"));
  mkdirSync(join(d, "app", ".claude", "agents"), { recursive: true });
  writeFileSync(join(d, "app", ".claude", "agents", "reviewer.md"), "---\nname: reviewer\n---\n");
  expect(isAgentKey(projectKey(join(d, "notes.md")))).toBe(false);
  expect(isAgentKey(agentKey(join(d, "app", ".claude", "agents", "reviewer.md")))).toBe(true);
  expect(isAgentKey(d)).toBe(false);
});
