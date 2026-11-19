// Managed git worktrees: a session can start in a fresh worktree of its
// repository on its own branch, be parked (its working state saved to a ref,
// the directory removed) and restored, open a pull request from its branch,
// and show the branch's diff for review.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { Shadow, type DiffResult } from "../safety/shadow.ts";

export type Worktree = {
  session_id: string;
  repo_root: string;
  path: string;
  branch: string;
  base: string;          // the ref it started from (a branch name, else a commit)
  base_commit: string;
  state: "active" | "parked" | "removed";
  snapshot_ref: string | null;
  created: number;
  updated: number;
};
export type WorktreeStatus = Worktree & { exists: boolean; dirty: number; commits_ahead: number; unknown?: string };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS worktrees (session_id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL, base_commit TEXT NOT NULL, state TEXT NOT NULL, snapshot_ref TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
`;

export class GitError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export async function git(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string; ok?: boolean } = {}): Promise<string> {
  const p = Bun.spawn(["git", ...args], {
    cwd, env: { ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: "0", ...opts.env },
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000,
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) {
    if (opts.ok) return "";
    throw new GitError(`git ${args[0]}: ${err.trim().split("\n").slice(-3).join(" ") || `exit ${code}`}`);
  }
  return out;
}

async function run(cwd: string, argv: string[]): Promise<{ out: string; err: string; code: number }> {
  const p = Bun.spawn(argv, { cwd, env: { ...process.env, GH_PROMPT_DISABLED: "1" }, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 120_000 });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

// A pull request's checks in a few words: a failure wins, then what waits, a
// cancelled or skipped check is not a failure.
export function summarizeChecks(rows: any[]) {
  const status = (c: any): string => {
    const v = String(c.conclusion || c.state || c.status || "").toUpperCase();
    if (["SUCCESS", "NEUTRAL"].includes(v)) return "passed";
    if (["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"].includes(v)) return "failed";
    if (v === "CANCELLED") return "cancelled";
    if (v === "SKIPPED" || v === "STALE") return "skipped";
    if (v === "ACTION_REQUIRED") return "action_required";
    return "pending";
  };
  const list = rows.map((c) => ({ name: String(c.name || c.context || "check"), status: status(c), url: c.detailsUrl || c.targetUrl || undefined, workflow: c.workflowName || undefined }));
  const n = (s: string) => list.filter((x) => x.status === s).length;
  const summary = !list.length ? "none" : n("failed") ? "failing" : n("pending") ? "pending" : n("action_required") ? "action_required" : "passing";
  return { summary, passed: n("passed"), failed: n("failed"), pending: n("pending"), cancelled: n("cancelled"), skipped: n("skipped"), action_required: n("action_required"), rows: list };
}

// A branch name from the first words of the title.
const slug = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 4).join("-").slice(0, 28).replace(/-$/, "") || "session";

export class Worktrees {
  constructor(private store: Store, private root: string) {
    store.migrate(SCHEMA);
  }

  get(sessionId: string): Worktree | undefined {
    return this.store.db.query<Worktree, [string]>("SELECT * FROM worktrees WHERE session_id = ?").get(sessionId) ?? undefined;
  }
  all(): Worktree[] {
    return this.store.db.query<Worktree, []>("SELECT * FROM worktrees ORDER BY created DESC").all();
  }
  private put(w: Worktree) {
    w.updated = Date.now();
    this.store.db.query(`INSERT INTO worktrees (session_id, repo_root, path, branch, base, base_commit, state, snapshot_ref, created, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET repo_root = excluded.repo_root, path = excluded.path, branch = excluded.branch, base = excluded.base, base_commit = excluded.base_commit, state = excluded.state, snapshot_ref = excluded.snapshot_ref, updated = excluded.updated`)
      .run(w.session_id, w.repo_root, w.path, w.branch, w.base, w.base_commit, w.state, w.snapshot_ref, w.created, w.updated);
  }

  // The repository a folder belongs to: its main checkout's root.
  async repoOf(dir: string): Promise<{ root: string; top: string } | null> {
    const top = (await git(dir, ["rev-parse", "--show-toplevel"], { ok: true })).trim();
    if (!top) return null;
    const common = (await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    return { root: common.endsWith("/.git") ? dirname(common) : top, top };
  }

  // A new worktree of the repository `workspace` is in, on a new branch from
  // `base` (default: what the folder has checked out). Returns the folder the
  // session works in (the same subfolder inside the worktree).
  async create(sessionKey: string, workspace: string, title: string, base?: string): Promise<{ wt: Omit<Worktree, "session_id">; cwd: string }> {
    const repo = await this.repoOf(workspace);
    if (!repo) throw new GitError(`not a git repository: ${workspace}`, 400);
    const ref = base?.trim() || (await git(repo.top, ["symbolic-ref", "--quiet", "--short", "HEAD"], { ok: true })).trim() || "HEAD";
    if (!/^[\w./@^~-]+$/.test(ref)) throw new GitError(`not a ref name: ${ref}`, 400);
    const baseCommit = (await git(repo.top, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
    const short = sessionKey.replace(/-/g, "").slice(-6);
    const branch = `keel/${slug(title)}-${short}`;
    const path = join(this.root, `${basename(repo.root)}-${short}`);
    mkdirSync(this.root, { recursive: true });
    await git(repo.root, ["worktree", "add", "-q", "-b", branch, path, baseCommit]);
    // Ignored files the repository asks to carry (.worktreeinclude, as Claude Code reads it): .env and the like.
    if (existsSync(join(repo.top, ".worktreeinclude"))) {
      const list = (await git(repo.top, ["ls-files", "-z", "--others", "--ignored", "--exclude-from=.worktreeinclude"], { ok: true })).split("\0").filter(Boolean);
      for (const f of list) {
        mkdirSync(dirname(join(path, f)), { recursive: true });
        copyFileSync(join(repo.top, f), join(path, f));
      }
    }
    const now = Date.now();
    return {
      wt: { repo_root: repo.root, path, branch, base: ref === "HEAD" ? baseCommit : ref, base_commit: baseCommit, state: "active", snapshot_ref: null, created: now, updated: now },
      cwd: join(path, relative(repo.top, workspace)),
    };
  }

  adopt(sessionId: string, wt: Omit<Worktree, "session_id">) {
    this.put({ ...wt, session_id: sessionId });
  }

  async status(w: Worktree): Promise<WorktreeStatus> {
    const exists = existsSync(w.path);
    if (!exists) return { ...w, exists, dirty: 0, commits_ahead: 0 };
    try {
      const [st, ahead] = await Promise.all([
        git(w.path, ["status", "--porcelain", "-z"]),
        git(w.path, ["rev-list", "--count", `${w.base_commit}..HEAD`]),
      ]);
      return { ...w, exists, dirty: st.split("\0").filter(Boolean).length, commits_ahead: Number(ahead.trim()) || 0 };
    } catch (e) {
      return { ...w, exists, dirty: 0, commits_ahead: 0, unknown: (e as Error).message };
    }
  }

  // Save the working state (uncommitted and untracked files) as a commit on a
  // private ref, so nothing is lost when the directory goes.
  private async snapshot(w: Worktree): Promise<string> {
    return this.saveState(w.path, `refs/keel/parked/${w.session_id}`, `keel: parked working state of ${w.branch}`);
  }

  private async saveState(dir: string, ref: string, message: string): Promise<string> {
    const gitDir = (await git(dir, ["rev-parse", "--absolute-git-dir"])).trim();
    const index = join(gitDir, `keel-park-${crypto.randomUUID()}`);
    try {
      const env = { GIT_INDEX_FILE: index };
      await git(dir, ["read-tree", "HEAD"], { env });
      await git(dir, ["add", "-A"], { env });
      const tree = (await git(dir, ["write-tree"], { env })).trim();
      const commit = (await git(dir, ["commit-tree", tree, "-p", "HEAD", "-m", message])).trim();
      await git(dir, ["update-ref", ref, commit]);
      return ref;
    } finally {
      rmSync(index, { force: true });
    }
  }

  // Put a saved working state back into `dir` as uncommitted work.
  private async applyState(dir: string, ref: string) {
    const snap = (await git(dir, ["rev-parse", ref])).trim();
    const gone = (await git(dir, ["diff", "--name-only", "-z", "--diff-filter=D", "HEAD", snap])).split("\0").filter(Boolean);
    await git(dir, ["checkout", snap, "--", "."]);
    for (const f of gone) rmSync(join(dir, f), { force: true });
    await git(dir, ["reset", "-q"]);
  }

  // Take the working state out of `dir`: tracked files back to HEAD, new files removed.
  private async clearState(dir: string) {
    const added = (await git(dir, ["diff", "--cached", "--name-only", "-z", "--diff-filter=A", "HEAD"])).split("\0").filter(Boolean);
    if (added.length) await git(dir, ["rm", "-q", "--cached", "--", ...added]);
    await git(dir, ["checkout", "HEAD", "--", "."], { ok: true });
    await git(dir, ["reset", "-q"]);
    const untracked = (await git(dir, ["ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
    for (const f of [...untracked, ...added]) rmSync(join(dir, f), { force: true });
  }

  private async dirty(dir: string): Promise<number> {
    return (await git(dir, ["status", "--porcelain", "-z"])).split("\0").filter(Boolean).length;
  }

  // Handoff: a session in the main checkout moves to a new worktree on its own
  // branch, its uncommitted work with it (the main checkout is left at HEAD;
  // the work is also kept on refs/keel/handoff/<session>).
  async toWorktree(s: Session): Promise<{ wt: Omit<Worktree, "session_id">; cwd: string; moved: number }> {
    const cur = this.get(s.id);
    if (cur && cur.state === "active") throw new GitError("the session already works in a worktree");
    const repo = await this.repoOf(s.workspace);
    if (!repo) throw new GitError(`not a git repository: ${s.workspace}`, 400);
    if (repo.top !== repo.root) throw new GitError("the session's folder is a worktree Keel does not manage; open a session in the main checkout to move it", 400);
    const moved = await this.dirty(repo.top);
    const ref = `refs/keel/handoff/${s.id}`;
    if (moved) await this.saveState(repo.top, ref, `keel: work moved to a worktree from ${s.workspace}`);
    // A fresh key: an earlier handoff's branch may still exist.
    const made = await this.create(cur ? `${s.id}${Date.now().toString(36)}` : s.id, s.workspace, s.title);
    if (moved) {
      await this.applyState(made.wt.path, ref);
      await this.clearState(repo.top);
    }
    return { ...made, moved };
  }

  // Handoff back: the main checkout switches to the worktree's branch and gets
  // its uncommitted work; the worktree folder goes (the branch can be checked
  // out in one place only). Refused while the main checkout has work of its own.
  async toMain(w: Worktree, s: Session): Promise<{ cwd: string; branch: string; previous: string | null; moved: number }> {
    if (w.state !== "active" || !existsSync(w.path)) throw new GitError(`the worktree is ${w.state === "active" ? "not on disk" : w.state}; restore it first`);
    const mainDirty = await this.dirty(w.repo_root);
    if (mainDirty) throw new GitError(`the main checkout has ${mainDirty} changed file${mainDirty === 1 ? "" : "s"} of its own: commit or stash them first`);
    const moved = await this.dirty(w.path);
    const ref = `refs/keel/handoff/${s.id}`;
    if (moved) await this.saveState(w.path, ref, `keel: work moved to the main checkout from ${w.branch}`);
    const previous = (await git(w.repo_root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { ok: true })).trim() || null;
    await git(w.repo_root, ["worktree", "remove", "--force", w.path]);
    await git(w.repo_root, ["checkout", "-q", w.branch]);
    if (moved) await this.applyState(w.repo_root, ref);
    this.put({ ...w, state: "removed", snapshot_ref: null });
    return { cwd: join(w.repo_root, relative(w.path, s.workspace)), branch: w.branch, previous, moved };
  }

  // Retention: past the newest `keep` worktrees, those of sessions that are
  // archived or gone are removed, each with a snapshot of its working state
  // so it can be restored. Running and live sessions keep theirs.
  async prune(keep: number, busy: (sessionId: string) => boolean): Promise<{ removed: string[]; kept: number }> {
    const live = this.all().filter((w) => w.state !== "removed");
    const removed: string[] = [];
    for (const w of live.slice(keep)) {
      const s = this.store.session(w.session_id);
      if (s && !s.archived) continue;
      if (busy(w.session_id)) continue;
      const st = await this.status(w);
      if (st.unknown) continue; // git cannot read it: never removed
      if (w.state === "parked") { this.put({ ...w, state: "removed" }); removed.push(w.session_id); continue; }
      const r = await this.remove(w, true);
      if (r.removed) removed.push(w.session_id);
    }
    return { removed, kept: live.length - removed.length };
  }

  async park(w: Worktree): Promise<Worktree> {
    if (w.state !== "active") throw new GitError(`the worktree is ${w.state}`);
    const ref = await this.snapshot(w);
    await git(w.repo_root, ["worktree", "remove", "--force", w.path]);
    const next = { ...w, state: "parked" as const, snapshot_ref: ref };
    this.put(next);
    return next;
  }

  async restore(w: Worktree): Promise<Worktree> {
    if (w.state === "active") throw new GitError("the worktree is active");
    if (!w.snapshot_ref && w.state === "removed") throw new GitError("the worktree was removed without a snapshot", 400);
    await git(w.repo_root, ["worktree", "prune"], { ok: true });
    await git(w.repo_root, ["worktree", "add", "-q", w.path, w.branch]);
    if (w.snapshot_ref) {
      await this.applyState(w.path, w.snapshot_ref); // the saved work comes back uncommitted, as it was
      await git(w.repo_root, ["update-ref", "-d", w.snapshot_ref], { ok: true });
    }
    const next = { ...w, state: "active" as const, snapshot_ref: null };
    this.put(next);
    return next;
  }

  // Remove the directory. Work in it (changes or commits) keeps it unless
  // `snapshot`, which saves the working state first; the branch goes only when
  // it carries nothing.
  async remove(w: Worktree, snapshot: boolean): Promise<{ removed: boolean; reason?: string; snapshot_ref?: string | null; branch_deleted: boolean }> {
    const st = await this.status(w);
    if (st.unknown) return { removed: false, reason: `git cannot read the worktree's state: ${st.unknown}`, branch_deleted: false };
    if (st.exists && (st.dirty || st.commits_ahead) && !snapshot)
      return { removed: false, reason: `it holds work: ${st.dirty} changed files, ${st.commits_ahead} commits`, branch_deleted: false };
    let ref = w.snapshot_ref;
    if (st.exists) {
      if (st.dirty) ref = await this.snapshot(w);
      await git(w.repo_root, ["worktree", "remove", "--force", w.path]);
    }
    let branchDeleted = false;
    if (!st.commits_ahead && !ref) {
      await git(w.repo_root, ["branch", "-D", w.branch], { ok: true });
      branchDeleted = true;
    }
    this.put({ ...w, state: "removed", snapshot_ref: ref });
    return { removed: true, snapshot_ref: ref, branch_deleted: branchDeleted };
  }

  // The base a branch is compared with: the managed worktree's, else what
  // origin/HEAD names, else a local main or master. Nothing is fetched.
  private async defaultBase(cwd: string): Promise<string | null> {
    const origin = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { ok: true })).trim();
    if (origin) return origin;
    for (const b of ["main", "master"]) if ((await git(cwd, ["rev-parse", "--verify", "--quiet", b], { ok: true })).trim()) return b;
    return null;
  }

  // Everything the branch carries over its merge base, uncommitted and untracked work included.
  async branchDiff(s: Session): Promise<DiffResult & { is_git: boolean; missing?: boolean; branch: string | null; base: string | null; merge_base: string | null; commits: number }> {
    if (!existsSync(s.workspace)) return { is_git: true, missing: true, branch: this.get(s.id)?.branch ?? null, base: null, merge_base: null, commits: 0, files: [], diff: "", truncated: false };
    const top = (await git(s.workspace, ["rev-parse", "--show-toplevel"], { ok: true })).trim();
    if (!top) return { is_git: false, branch: null, base: null, merge_base: null, commits: 0, files: [], diff: "", truncated: false };
    const w = this.get(s.id);
    const branch = (await git(top, ["symbolic-ref", "--quiet", "--short", "HEAD"], { ok: true })).trim() || null;
    const base = w?.base ?? (await this.defaultBase(top));
    const mb = base ? (await git(top, ["merge-base", "HEAD", base], { ok: true })).trim() || null : null;
    const from = mb ?? (await git(top, ["rev-parse", "HEAD"])).trim();
    const commits = mb ? Number((await git(top, ["rev-list", "--count", `${mb}..HEAD`])).trim()) || 0 : 0;
    const gitDir = (await git(top, ["rev-parse", "--absolute-git-dir"])).trim();
    const sh = new Shadow("", top, gitDir);
    const tree = await sh.snapshot();
    const fromTree = (await git(top, ["rev-parse", `${from}^{tree}`])).trim();
    return { is_git: true, branch, base, merge_base: mb, commits, ...(await sh.diff(fromTree, tree)) };
  }

  // The change a review looks at: uncommitted work (tracked and untracked) over
  // HEAD, the branch over its merge base with `base`, or one commit.
  async changeDiff(s: Session, scope: "uncommitted" | "branch" | "commit", ref?: string): Promise<DiffResult & { target: string }> {
    if (!existsSync(s.workspace)) throw new GitError("the session's folder is not on disk (a parked worktree?)", 400);
    const top = (await git(s.workspace, ["rev-parse", "--show-toplevel"], { ok: true })).trim();
    if (!top) throw new GitError("the session's folder is not in a git repository", 400);
    if (ref && !/^[\w./@^~-]+$/.test(ref)) throw new GitError(`not a ref name: ${ref}`, 400);
    const gitDir = (await git(top, ["rev-parse", "--absolute-git-dir"])).trim();
    const sh = new Shadow("", top, gitDir);
    const head = (await git(top, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], { ok: true })).trim() || "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    if (scope === "uncommitted") return { ...(await sh.diff(head, await sh.snapshot())), target: "HEAD" };
    if (scope === "commit") {
      const c = (await git(top, ["rev-parse", "--verify", `${ref || "HEAD"}^{commit}`])).trim();
      const parent = (await git(top, ["rev-parse", "--verify", "--quiet", `${c}^^{tree}`], { ok: true })).trim() || "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      return { ...(await sh.diff(parent, (await git(top, ["rev-parse", `${c}^{tree}`])).trim())), target: c.slice(0, 12) };
    }
    const base = ref || this.get(s.id)?.base || (await this.defaultBase(top));
    if (!base) throw new GitError("no base branch to compare with: name one", 400);
    const mb = (await git(top, ["merge-base", "HEAD", base], { ok: true })).trim();
    if (!mb) throw new GitError(`no merge base with ${base}`, 400);
    return { ...(await sh.diff((await git(top, ["rev-parse", `${mb}^{tree}`])).trim(), await sh.snapshot())), target: base };
  }

  async pr(w: Worktree): Promise<{ pr: any; available: boolean; error?: string }> {
    const r = await run(w.path, ["gh", "pr", "view", w.branch, "--json", "number,url,title,state,isDraft,headRefOid,baseRefName,reviewDecision,statusCheckRollup"]);
    if (r.code === 0) {
      const pr = JSON.parse(r.out);
      const local = (await git(w.path, ["rev-parse", "HEAD"], { ok: true })).trim();
      return { pr: { ...pr, statusCheckRollup: undefined, checks: summarizeChecks(pr.statusCheckRollup ?? []), head_matches: !local || pr.headRefOid === local }, available: true };
    }
    if (/no pull requests found/i.test(r.err)) return { pr: null, available: true };
    return { pr: null, available: false, error: r.err.trim().slice(0, 300) || `gh exit ${r.code}` };
  }

  // Push the branch and open a pull request against the base branch.
  async openPr(w: Worktree, opts: { title?: string; body?: string; draft?: boolean }): Promise<{ url: string }> {
    const st = await this.status(w);
    if (!st.exists) throw new GitError("the worktree is not on disk; restore it first");
    if (st.dirty) throw new GitError(`commit first: ${st.dirty} files are not committed`);
    if (!st.commits_ahead) throw new GitError("the branch has no commits over its base");
    const remote = (await git(w.path, ["remote"], { ok: true })).split("\n").map((x) => x.trim()).filter(Boolean);
    if (!remote.includes("origin")) throw new GitError("the repository has no origin remote", 400);
    await git(w.path, ["push", "-u", "origin", `${w.branch}:${w.branch}`]);
    const base = /^[0-9a-f]{40}$/.test(w.base) ? null : w.base.replace(/^origin\//, "");
    const argv = ["gh", "pr", "create", "--head", w.branch];
    if (base) argv.push("--base", base);
    if (opts.title) argv.push("--title", opts.title, "--body", opts.body ?? "");
    else argv.push("--fill");
    if (opts.draft) argv.push("--draft");
    const r = await run(w.path, argv);
    if (r.code !== 0) throw new GitError(`gh pr create: ${r.err.trim().slice(0, 400)}`, 502);
    return { url: r.out.trim().split("\n").pop()! };
  }
}
