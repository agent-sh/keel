// Links and redirect files a command leaves in the git data a worktree shares: found after it, set aside, and the
// worktree's own git goes on working. A scratch repository with a linked worktree.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { realOf } from "../core/paths.ts";
import { plantsSaid, scanPlants, settle } from "./plants.ts";
import { checkoutsOf } from "./refwatch.ts";
import { sharedRefusal } from "./shared-branches.ts";

const hasGit = !!Bun.which("git");

test.skipIf(!hasGit)("a link or an alternates file a command leaves in the shared git data is set aside; git in the worktree and the main checkout goes on", () => {
  const dir = realOf(mkdtempSync(join(process.env.TMPDIR ?? ".", "plants-")));
  const env = { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (cwd: string, ...a: string[]) => {
    const r = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", ...a], { cwd, env });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  try {
    const main = join(dir, "main"), agent = join(dir, "agent"), quarantine = join(dir, "q");
    git(dir, "init", "-q", main);
    writeFileSync(join(main, "a"), "a\n");
    git(main, "add", "a");
    git(main, "commit", "-qm", "a");
    git(main, "worktree", "add", "-q", "-b", "keel/x", agent);
    const common = join(main, ".git");
    const s = checkoutsOf(agent, "keel/x", "main")!;
    // The owner's own, there before the command: a link they keep, an alternates file.
    mkdirSync(join(dir, "store"));
    symlinkSync(join(dir, "store"), join(common, "refs", "keep"));
    writeFileSync(join(common, "objects", "info", "alternates"), `${join(dir, "store")}\n`);
    const refs = git(main, "for-each-ref");
    const before = scanPlants(common, s.gitDir);
    // What a script of the agent's does.
    symlinkSync("/etc/passwd", join(common, "refs", "heads", "x"));
    mkdirSync(join(common, "logs", "refs", "heads"), { recursive: true });
    symlinkSync("/etc/hostname", join(common, "logs", "refs", "heads", "y"));
    mkdirSync(join(common, "objects", "ab"), { recursive: true });
    symlinkSync("/etc/passwd", join(common, "objects", "ab", "cdef"));
    symlinkSync("/etc", join(common, "objects", "zz"));
    writeFileSync(join(common, "objects", "info", "alternates"), "/etc\n");
    writeFileSync(join(common, "objects", "info", "http-alternates"), "http://x\n");
    writeFileSync(join(s.gitDir, "commondir"), "/somewhere\n");
    const ordinaryBefore = readFileSync(join(s.gitDir, "gitdir"), "utf8");
    const done = settle(before.plants, scanPlants(common, s.gitDir, before.marks).plants, s.gitDir, quarantine);
    const said = plantsSaid(done, common)!;
    expect(done.map((d) => `${d.what} ${d.path.slice(common.length)}`).sort()).toEqual([
      "changed /objects/info/alternates",
      "changed /worktrees/agent/commondir",
      "file /objects/info/http-alternates",
      "link /logs/refs/heads/y",
      "link /objects/ab/cdef",
      "link /objects/zz",
      "link /refs/heads/x",
    ].sort());
    expect(said).toContain("a link at refs/heads/x");
    // The links are gone from the store and kept in the quarantine, as links (never followed); what was there is as it was.
    for (const p of ["refs/heads/x", "logs/refs/heads/y", "objects/ab/cdef", "objects/zz", "objects/info/http-alternates"]) expect(existsSync(join(common, p)) || (() => { try { lstatSync(join(common, p)); return true; } catch { return false; } })()).toBe(false);
    expect(done.find((d) => d.path.endsWith("refs/heads/x"))!.kept).toBe(join(quarantine, `${join(common, "refs/heads/x").slice(1).replace(/\//g, "%")}`));
    expect(readlinkSync(done.find((d) => d.path.endsWith("refs/heads/x"))!.kept!)).toBe("/etc/passwd");
    expect(readFileSync(join(common, "objects", "info", "alternates"), "utf8")).toBe(`${join(dir, "store")}\n`);
    expect(readFileSync(join(s.gitDir, "commondir"), "utf8")).toBe("../..\n");
    expect(readFileSync(join(s.gitDir, "gitdir"), "utf8")).toBe(ordinaryBefore);
    expect(readlinkSync(join(common, "refs", "keep"))).toBe(join(dir, "store"));
    // Nothing else is said: a second look finds nothing new.
    expect(settle(before.plants, scanPlants(common, s.gitDir, before.marks).plants, s.gitDir, quarantine)).toEqual([]);
    // git in the worktree (its own folder under .git/worktrees) and in the main checkout is as before.
    expect(git(main, "for-each-ref")).toBe(refs);
    writeFileSync(join(agent, "b"), "b\n");
    git(agent, "add", "b");
    git(agent, "commit", "-qm", "b");
    expect(git(agent, "rev-parse", "--abbrev-ref", "HEAD")).toBe("keel/x");
    expect(git(main, "log", "--format=%s", "keel/x")).toBe("b\na");
    // And the commands that would have made them are refused before they run.
    for (const line of [`ln -s /etc/passwd ${common}/refs/heads/x`, `echo /etc > ${common}/objects/info/alternates`, `echo /somewhere > ${s.gitDir}/commondir`, `echo "gitdir: /somewhere" > ${agent}/.git`]) {
      expect([line, sharedRefusal(line, agent, dir, s) !== null]).toEqual([line, true]);
    }
    expect(sharedRefusal("git add b && git commit -qm c && git gc -q", agent, dir, s)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("what is not new is the repository's own: no entries, no note", () => {
  expect(plantsSaid([], "/r/.git")).toBeUndefined();
});

test.skipIf(!hasGit)("the gate looks for what a worktree agent's command left in the shared git data, and says it in the result", async () => {
  const { Bus } = await import("../core/bus.ts");
  const { Store } = await import("../core/store.ts");
  const { Gate } = await import("./gate.ts");
  const dir = realOf(mkdtempSync(join(process.env.TMPDIR ?? ".", "plants-gate-")));
  const env = { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (cwd: string, ...a: string[]) => { const r = Bun.spawnSync(["git", "-c", "init.defaultBranch=main", ...a], { cwd, env }); if (r.exitCode !== 0) throw new Error(r.stderr.toString()); };
  try {
    const main = join(dir, "main"), agent = join(dir, "agent");
    git(dir, "init", "-q", main);
    git(main, "commit", "-q", "--allow-empty", "-m", "a");
    git(main, "worktree", "add", "-q", "-b", "keel/x", agent);
    const store = new Store(join(dir, "state"));
    store.db.run("CREATE TABLE IF NOT EXISTS worktrees (session_id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL, base_commit TEXT NOT NULL, state TEXT NOT NULL, snapshot_ref TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)");
    store.db.query("INSERT INTO worktrees VALUES ('a1', ?, ?, 'keel/x', 'main', '', 'active', NULL, 0, 0)").run(main, agent);
    const session = { id: "a1", workspace: agent, parent_id: "p" } as never;
    const bash = { name: "Bash", readOnly: false, kind: "shell", description: "", input_schema: { type: "object", properties: { command: {} } }, run: async () => ({ content: "" }) } as never;
    const g = new Gate(store, new Bus(), () => false);
    g.setPerm("a1", { mode: "full-auto", sandbox: "off" });
    const call = { id: "c1", tool: bash, input: { command: "python3 plant.py" }, ctx: { sessionId: "a1", cwd: agent, signal: new AbortController().signal, spillDir: agent, seen: new Map() } } as never;
    expect(await g.beforeTool(session, call)).not.toHaveProperty("deny");
    symlinkSync("/etc/passwd", join(main, ".git", "refs", "heads", "x"));
    const said = await g.refsChanged("a1", "c1");
    expect(said?.planted).toContain("a link at refs/heads/x");
    expect(existsSync(join(main, ".git", "refs", "heads", "x"))).toBe(false);
    // A command that only reads is not watched.
    expect(await g.beforeTool(session, { ...(call as object), id: "c2", input: { command: "git status" } } as never)).not.toHaveProperty("deny");
    symlinkSync("/etc/passwd", join(main, ".git", "refs", "heads", "x"));
    expect(await g.refsChanged("a1", "c2")).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
