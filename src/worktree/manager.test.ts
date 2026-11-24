import { expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// Parking keeps the working state as a commit on a ref of Keel's own. It is
// made under Keel's name: a machine with no git identity (a fresh home, a
// container) parks and restores a worktree like any other.
test("a worktree parks and comes back where git has no identity to commit under", async () => {
  const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `wt-park-${process.pid}`);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
  // No configured identity, and none guessed from the machine's name.
  const none: Record<string, string | undefined> = {
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true",
    GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined, EMAIL: undefined,
  };
  const before = Object.fromEntries(Object.keys(none).map((k) => [k, process.env[k]]));
  try {
    g(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a"), "a\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "init");
    const wts = new Worktrees(new Store(join(root, "state")), join(root, "wts"));
    const { wt } = await wts.create("s1", repo, "work", undefined);
    wts.adopt("s1", wt);
    writeFileSync(join(wt.path, "todo.md"), "not committed\n");
    for (const [k, v] of Object.entries(none)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    const parked = await wts.park(wts.get("s1")!);
    expect(parked.state).toBe("parked");
    expect(existsSync(wt.path)).toBe(false);
    const back = await wts.restore(parked);
    expect(back.state).toBe("active");
    expect(readFileSync(join(wt.path, "todo.md"), "utf8")).toBe("not committed\n");
  } finally {
    for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(root, { recursive: true, force: true });
  }
});

// A saved working state is a commit Keel makes for itself, under its own ref:
// the owner's when git has an identity, Keel's when it has none.
test("a parked worktree's saved state is the owner's commit, and Keel's where git has no identity", async () => {
  const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `wt-ident-${process.pid}`);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
  const kept = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM };
  // No identity from the machine: only what the repository itself says.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  try {
    g(repo, "init", "-q", "-b", "main");
    g(repo, "config", "user.name", "The Owner");
    g(repo, "config", "user.email", "owner@example.test");
    writeFileSync(join(repo, "a"), "a\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "init");
    const wts = new Worktrees(new Store(join(root, "state")), join(root, "wts"));
    const author = async (session: string) => {
      const { wt } = await wts.create(session, repo, session, undefined);
      wts.adopt(session, wt);
      writeFileSync(join(wt.path, "b"), "b\n");
      const parked = await wts.park(wts.get(session)!);
      return g(repo, "log", "-1", "--format=%an <%ae>", parked.snapshot_ref!);
    };
    expect(await author("s1")).toBe("The Owner <owner@example.test>");
    g(repo, "config", "--unset", "user.name");
    g(repo, "config", "--unset", "user.email");
    g(repo, "config", "user.useConfigOnly", "true");
    expect(await author("s2")).toBe("Keel <keel@localhost>");
  } finally {
    for (const [k, v] of [["GIT_CONFIG_GLOBAL", kept.global], ["GIT_CONFIG_SYSTEM", kept.system]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("the branches a worktree can start from: the default, local by recency, then remote, with who has one out", async () => {
  const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `wt-branches-${process.pid}`);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const g = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8", env: { ...process.env, GIT_COMMITTER_DATE: date.next } }).trim();
  const date = { next: "2026-01-01T00:00:00Z" };
  const at = (d: string, f: () => string) => { date.next = d; return f(); };
  try {
    g(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a"), "a\n");
    g(repo, "add", "-A");
    at("2026-01-01T00:00:00Z", () => g(repo, "commit", "-qm", "init"));
    // Each branch's tip is a commit of its own on a day of its own: old is the oldest, dev the newest.
    for (const [name, day] of [["old", "02"], ["dev", "03"]] as const) {
      g(repo, "checkout", "-q", "-b", name, "main");
      writeFileSync(join(repo, name), `${name}\n`);
      g(repo, "add", "-A");
      at(`2026-01-${day}T00:00:00Z`, () => g(repo, "commit", "-qm", name));
    }
    g(repo, "checkout", "-q", "main");
    // A remote-only branch, and one that a local branch stands for.
    g(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    g(repo, "update-ref", "refs/remotes/origin/feature", "HEAD");
    g(repo, "update-ref", "refs/remotes/origin/dev", "HEAD");
    g(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const store = new Store(join(root, "state"));
    const wts = new Worktrees(store, join(root, "wts"));
    const s = store.createSession({ workspace: repo, model: "m", title: "holds dev" });
    const made = await wts.create(s.id, repo, "holds", "dev");
    wts.adopt(s.id, made.wt);
    store.updateSession(s.id, { workspace: made.cwd });
    // The session works on a branch of its own: the list names it, a base it came from is not "out".
    const r = await wts.branches(repo);
    expect(r.default).toBe("main");
    expect(r.branches.filter((b) => b.kind === "local").map((b) => b.name).sort()).toEqual(["dev", "keel/holds-" + s.id.replace(/-/g, "").slice(-6), "main", "old"].sort());
    expect(r.branches.filter((b) => b.kind === "remote").map((b) => b.name)).toEqual(["origin/feature"]);
    expect(r.branches.find((b) => b.name === made.wt.branch)?.session?.title).toBe("holds dev");
    expect(r.branches.find((b) => b.name === "dev")?.session).toBe(null);
    const local = r.branches.filter((b) => b.kind === "local");
    expect(local.map((b) => b.name).filter((n) => ["old", "dev", "main"].includes(n))).toEqual(["dev", "old", "main"]);
    // A base of its own names the commit the worktree starts from.
    const from = await wts.create("s2", repo, "from dev", "dev");
    expect(from.wt.base).toBe("dev");
    await expect(wts.branches(join(root, "nowhere"))).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
