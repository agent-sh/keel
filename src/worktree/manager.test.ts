import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { summarizeChecks, Worktrees } from "./manager.ts";

// Each test here runs git a dozen times or more, and on a busy disk one git
// command takes half a second: the 5 s default was passed in whole-suite runs.
setDefaultTimeout(20_000);

test("pull request checks in a few words", () => {
  expect(summarizeChecks([]).summary).toBe("none");
  expect(summarizeChecks([{ name: "a", conclusion: "SUCCESS" }, { name: "b", conclusion: "CANCELLED" }]).summary).toBe("passing");
  expect(summarizeChecks([{ name: "a", conclusion: "SUCCESS" }, { name: "b", status: "IN_PROGRESS" }]).summary).toBe("pending");
  const r = summarizeChecks([{ name: "a", conclusion: "FAILURE" }, { context: "ci/x", state: "PENDING" }]);
  expect(r.summary).toBe("failing");
  expect(r.rows.map((x) => x.status)).toEqual(["failed", "pending"]);
});

test("a worktree folder removed with git is not an empty branch", async () => {
  const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `wt-${process.pid}`);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
  try {
    g(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a"), "a\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "init");
    const wts = new Worktrees(new Store(join(root, "state")), join(root, "wts"));
    const { wt } = await wts.create("s1", repo, "work", undefined);
    wts.adopt("s1", wt);
    writeFileSync(join(wt.path, "b"), "b\n");
    g(wt.path, "add", "-A");
    g(wt.path, "commit", "-qm", "work");
    g(repo, "worktree", "remove", wt.path);
    expect((await wts.status(wts.get("s1")!)).commits_ahead).toBe(1);
    const r = await wts.remove(wts.get("s1")!, false);
    expect(r.branch_deleted).toBe(false);
    expect(g(repo, "rev-list", "--count", `main..${wt.branch}`)).toBe("1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
