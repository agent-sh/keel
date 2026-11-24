// Managed git worktrees: a session can start in a fresh worktree of its
// repository on its own branch, be parked (its working state saved to a ref,
// the directory removed) and restored, open a pull request from its branch,
// and show the branch's diff for review.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { Shadow, type DiffResult } from "../safety/shadow.ts";
import { addAll, git as gitCall, gitEnv, gitReach, innerWork, locate, nestedIn, type GitFetch } from "../core/git.ts";
import { readText } from "../core/proc.ts";
import { contains, realOf } from "../core/paths.ts";
import { prTarget, type Host } from "./pr-head.ts";

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
// exists: the folder is on disk; branch_missing: the branch ref is gone;
// unknown: git could not say what the branch holds (then nothing is removed);
// inner: the repositories inside it (a submodule, a nested clone) that hold
// work no snapshot of the worktree keeps. They count in `dirty`.
// inner_unpushed: every one of them is clean and holds only commits that none of its remotes has.
export type WorktreeStatus = Worktree & { exists: boolean; dirty: number; commits_ahead: number; branch_missing?: boolean; unknown?: string; inner?: string[]; inner_unpushed?: boolean };

// The uncommitted work in a folder: what git's status lists, and every
// repository inside it that holds work of its own. Such a repository is one
// entry however much it holds. The outer status does not look inside one
// (the daemon's git never runs there from outside, src/core/git.ts), so each
// submodule is asked through its own view.
// - `held`: the submodules with uncommitted work or commits of their own
//   that none of their remotes has;
// - `nested`: the repositories the outer one does not track, also below a
//   folder it does not track. They are in no tree at all;
// - `inner`: both. A snapshot of the outer tree keeps none of it, and what a
//   submodule committed lives in a git directory that goes with a worktree;
// - `unpushed`: all of `inner` is submodules that are clean and hold only
//   commits none of their remotes has (what to do about it differs);
// - `unknown`: the ones that cannot be read, never read as clean.
// (Untracked files are counted whatever status.showUntrackedFiles says: with it off they would go unseen.)
async function workIn(dir: string): Promise<{ dirty: number; inner: string[]; held: string[]; nested: string[]; unknown: string[]; unpushed: boolean }> {
  const [st, others, work] = await Promise.all([git(dir, ["status", "--porcelain", "-z", "--untracked-files=normal"]), git(dir, ["ls-files", "-o", "--exclude-standard", "-z"]), innerWork(dir)]);
  const listed = new Set<string>();
  const recs = st.split("\0").filter(Boolean);
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]!;
    listed.add(rec.slice(3).replace(/\/$/, ""));
    if (rec[0] === "R" || rec[0] === "C") i++; // the name it had before follows
  }
  const nested = nestedIn(others);
  const held = [...new Set([...work.dirty, ...work.unpushed])];
  return { dirty: listed.size + work.dirty.filter((p) => !listed.has(p)).length, inner: [...held, ...nested], held, nested, unknown: work.unknown, unpushed: !work.dirty.length && !nested.length && work.unpushed.length > 0 };
}
const cannotRead = (paths: string[]) => `a repository inside it could not be read (${paths.slice(0, 3).join(", ")}${paths.length > 3 ? " and more" : ""})`;
// `unpushed`: all of them are clean and hold commits that none of their remotes has.
const notKept = (paths: string[], unpushed = false) => `${paths.length === 1 ? "a repository inside it holds" : `${paths.length} repositories inside it hold`} ${unpushed ? "commits of its own that none of its remotes has, which" : "work that"} a snapshot does not keep (${paths.slice(0, 3).join(", ")}${paths.length > 3 ? " and more" : ""}): ${unpushed ? "push them, or move it out, first" : "commit it there, or move it out, first"}`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS worktrees (session_id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, path TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL, base_commit TEXT NOT NULL, state TEXT NOT NULL, snapshot_ref TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL);
`;

export class GitError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

// git's worktree bookkeeping (.git/worktrees/<name>) is not safe for two
// commands at once: parallel agents of one repository failed to start with
// "failed to read .git/worktrees/<name>/commondir". Worktree commands of one
// repository run one after another.
const worktreeQueue = new Map<string, Promise<unknown>>();

// The tree of no files, what git compares a first commit with.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function git(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string; ok?: boolean; fetch?: GitFetch } = {}): Promise<string> {
  if (args[0] !== "worktree") return gitNow(cwd, args, opts);
  const run = (worktreeQueue.get(cwd) ?? Promise.resolve()).then(() => gitNow(cwd, args, opts));
  const tail = run.catch(() => {});
  worktreeQueue.set(cwd, tail);
  tail.then(() => { if (worktreeQueue.get(cwd) === tail) worktreeQueue.delete(cwd); });
  return run;
}

// A commit Keel makes for itself (a saved working state under its own ref) is
// the owner's when the machine has a git identity, and Keel's when it has
// none: git refuses to commit without one.
const KEEL_IDENT = { GIT_AUTHOR_NAME: "Keel", GIT_AUTHOR_EMAIL: "keel@localhost", GIT_COMMITTER_NAME: "Keel", GIT_COMMITTER_EMAIL: "keel@localhost" };
// Which of the two it is, is not read from git's words (they follow the
// machine's language): a commit git refuses is made once more under Keel's
// name. With no identity that one succeeds; anything else git refused, it
// refuses again, and that is the failure told.
async function ownCommit(dir: string, args: string[]): Promise<string> {
  try {
    return await git(dir, args);
  } catch (e) {
    if (!(e instanceof GitError)) throw e;
    return git(dir, args, { env: KEEL_IDENT });
  }
}

// Through the one place that runs git (src/core/git.ts): the repository's own
// config is not read, so nothing it names is run for the daemon.
async function gitNow(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string; ok?: boolean; fetch?: GitFetch }): Promise<string> {
  const { code, out, err } = await gitCall(cwd, args, { env: opts.env, input: opts.input, fetch: opts.fetch, timeout: 120_000 });
  if (code !== 0) {
    if (opts.ok) return "";
    throw new GitError(`git ${args[0]}: ${err.trim().split("\n").slice(-3).join(" ") || `exit ${code}`}`);
  }
  return out;
}

async function run(cwd: string, argv: string[]): Promise<{ out: string; err: string; code: number }> {
  // (gh runs git by itself: its calls read the repository as the daemon's do.)
  const p = Bun.spawn(argv, { cwd, env: { ...gitEnv(cwd), GH_PROMPT_DISABLED: "1" }, stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 120_000 });
  const [out, err, code] = await Promise.all([readText(p.stdout), readText(p.stderr), p.exited]);
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

// The branches Keel makes for its worktrees start with this.
export const BRANCH_PREFIX = "keel/";

export type BranchList = {
  default: string | null;
  branches: { name: string; kind: "local" | "remote"; at: number; session: { id: string; title: string } | null }[];
};

export class Worktrees {
  constructor(private store: Store, private root: string) {
    store.migrate(SCHEMA);
  }

  // Whether a row names a worktree of the kind Keel makes: a folder inside Keel's own worktree folder (where its
  // links land) on a branch of Keel's naming. A row that names anything else is not Keel's to remove.
  owns(w: Worktree): boolean {
    const root = realOf(this.root), at = realOf(w.path);
    return at !== root && contains(root, at) && w.branch.startsWith(BRANCH_PREFIX);
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
    // (Read from the files: see locate in src/core/git.ts.)
    const at = locate(dir);
    if (!at?.top) return null;
    return { root: at.common.endsWith("/.git") ? dirname(at.common) : at.top, top: at.top };
  }

  // A new worktree of the repository `workspace` is in, on a new branch from
  // `base` (default: what the folder has checked out). Returns the folder the
  // session works in (the same subfolder inside the worktree).
  // `madeFor`: the session whose reach bounds what the fill may fetch in a
  // partial clone (an agent's parent; GitOpts.fetch in src/core/git.ts); the
  // key itself when that is a session.
  async create(sessionKey: string, workspace: string, title: string, base?: string, madeFor: string = sessionKey): Promise<{ wt: Omit<Worktree, "session_id">; cwd: string }> {
    const repo = await this.repoOf(workspace);
    if (!repo) throw new GitError(`not a git repository: ${workspace}`, 400);
    const ref = base?.trim() || (await git(repo.top, ["symbolic-ref", "--quiet", "--short", "HEAD"], { ok: true })).trim() || "HEAD";
    if (!/^[\w./@^~-]+$/.test(ref)) throw new GitError(`not a ref name: ${ref}`, 400);
    const baseCommit = (await git(repo.top, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
    const short = sessionKey.replace(/-/g, "").slice(-6);
    const branch = `${BRANCH_PREFIX}${slug(title)}-${short}`;
    const path = join(this.root, `${basename(repo.root)}-${short}`);
    mkdirSync(this.root, { recursive: true });
    await git(repo.root, ["worktree", "add", "-q", "-b", branch, path, baseCommit], { fetch: gitReach(madeFor) });
    // Ignored files the repository asks to carry (.worktreeinclude, as Claude Code reads it): .env and the like.
    // The checkout and the branch exist now and no caller has recorded them: a step that throws removes both, so
    // nothing is left that no row names.
    try {
      if (existsSync(join(repo.top, ".worktreeinclude"))) {
        const list = (await git(repo.top, ["ls-files", "-z", "--others", "--ignored", "--exclude-from=.worktreeinclude"], { ok: true })).split("\0").filter(Boolean);
        for (const f of list) {
          mkdirSync(dirname(join(path, f)), { recursive: true });
          copyFileSync(join(repo.top, f), join(path, f));
        }
      }
    } catch (e) {
      const left: string[] = [];
      try { await git(repo.root, ["worktree", "remove", "--force", path]); } catch (f) { left.push(`the checkout ${path} (${(f as Error).message})`); }
      try { await git(repo.root, ["branch", "-D", branch]); } catch (f) { left.push(`the branch ${branch} (${(f as Error).message})`); }
      const was = (e as Error).message ?? String(e);
      throw new GitError(left.length ? `${was}; the new worktree could not be removed, left: ${left.join(", ")}` : `${was}; the new worktree and its branch ${branch} were removed`, (e as GitError).status ?? 500);
    }
    const now = Date.now();
    return {
      wt: { repo_root: repo.root, path, branch, base: ref === "HEAD" ? baseCommit : ref, base_commit: baseCommit, state: "active", snapshot_ref: null, created: now, updated: now },
      cwd: join(path, relative(repo.top, workspace)),
    };
  }

  // A new worktree at the head of a pull request (a merge request on GitLab) of the repository's origin:
  // its head is fetched by name into a ref of Keel's own, the worktree is made on a new branch at that
  // commit (pr-N in its name), and the ref is let go (the branch holds the commits). The fetch asks for
  // nothing: no terminal, askpass or ssh prompt. The ref is the host's (src/worktree/pr-head.ts).
  async atPr(sessionKey: string, workspace: string, pr: string | number, madeFor: string = sessionKey): Promise<{ wt: Omit<Worktree, "session_id">; cwd: string; number: number; commit: string; host: Host; origin: string; top: string }> {
    const repo = await this.repoOf(workspace);
    if (!repo) throw new GitError(`not a git repository: ${workspace}`, 400);
    const origin = (await git(repo.top, ["config", "--get", "remote.origin.url"], { ok: true })).trim();
    if (!origin) throw new GitError("this repository has no remote named origin to fetch the pull request from", 409);
    const t = prTarget(pr, origin);
    if ("error" in t) throw new GitError(t.error, 400);
    const own = `refs/keel/pr/${t.number}`;
    const ssh = process.env.GIT_SSH_COMMAND || "ssh";
    try {
      await git(repo.top, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "origin", `+${t.ref}:${own}`], {
        env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true", SSH_ASKPASS: "true", SSH_ASKPASS_REQUIRE: "never", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: `${ssh} -o BatchMode=yes` },
      });
    } catch (e) {
      const said = (e as Error).message.replace(/^git fetch: /, "");
      throw new GitError(`could not fetch ${t.ref} from origin (${origin.replace(/\/\/[^@/]*@/, "//")}): ${said}`, 409);
    }
    try {
      const commit = (await git(repo.top, ["rev-parse", "--verify", `${own}^{commit}`])).trim();
      const made = await this.create(sessionKey, workspace, `pr-${t.number}`, commit, madeFor);
      return { ...made, number: t.number, commit, host: t.host, origin, top: repo.top };
    } finally {
      await git(repo.top, ["update-ref", "-d", own], { ok: true });
    }
  }

  // What a new worktree can start from: the repository's default branch, the local branches by
  // recency, then the remote ones a local branch does not stand for, by recency. A branch that a
  // checkout has out names the newest open session working there. Nothing is fetched.
  async branches(workspace: string): Promise<BranchList> {
    const repo = await this.repoOf(workspace);
    if (!repo) throw new GitError(`not a git repository: ${workspace}`, 400);
    const refs = (await git(repo.top, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)\t%(committerdate:unix)", "refs/heads", "refs/remotes"], { ok: true })).split("\n").filter(Boolean)
      .map((l) => { const [ref, t] = l.split("\t"); return { ref: ref!, at: Number(t) || 0 }; });
    const local = refs.filter((r) => r.ref.startsWith("refs/heads/")).map((r) => ({ name: r.ref.slice(11), at: r.at }));
    const names = new Set(local.map((b) => b.name));
    const remote = refs.filter((r) => r.ref.startsWith("refs/remotes/") && !r.ref.endsWith("/HEAD")).map((r) => ({ name: r.ref.slice(13), at: r.at }))
      .filter((b) => !names.has(b.name.slice(b.name.indexOf("/") + 1)));
    // Who has what out: every checkout of the repository, and the sessions working in each.
    const out = await git(repo.top, ["worktree", "list", "--porcelain"], { ok: true });
    const open = this.store.sessions();
    const users = new Map<string, { id: string; title: string }>();
    for (const block of out.split("\n\n")) {
      const path = /^worktree (.+)$/m.exec(block)?.[1], branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
      if (!path || !branch) continue;
      const at = open.find((s) => s.workspace === path || s.workspace.startsWith(`${path}/`));
      if (at) users.set(branch, { id: at.id, title: at.title || at.id.slice(-6) });
    }
    const def = await this.defaultBase(repo.top);
    const short = def?.replace(/^origin\//, "");
    const fallback = (await git(repo.top, ["symbolic-ref", "--quiet", "--short", "HEAD"], { ok: true })).trim();
    const pick = short && names.has(short) ? short : def ?? (fallback || null);
    return {
      default: pick,
      branches: [
        ...local.map((b) => ({ name: b.name, kind: "local" as const, at: b.at, session: users.get(b.name) ?? null })),
        ...remote.map((b) => ({ name: b.name, kind: "remote" as const, at: b.at, session: null })),
      ],
    };
  }

  // A worktree of its own for an existing branch, which no checkout has out (an agent that takes over
  // the branch of one that is gone). Its base is what the workspace has out, as for a new branch.
  async attach(sessionKey: string, workspace: string, branch: string, madeFor: string = sessionKey): Promise<{ wt: Omit<Worktree, "session_id">; cwd: string }> {
    const repo = await this.repoOf(workspace);
    if (!repo) throw new GitError(`not a git repository: ${workspace}`, 400);
    if (!/^[\w./@-]+$/.test(branch) || branch.includes("..")) throw new GitError(`not a branch name: ${branch}`, 400);
    const ref = (await git(repo.top, ["symbolic-ref", "--quiet", "--short", "HEAD"], { ok: true })).trim() || "HEAD";
    const tip = (await git(repo.top, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])).trim();
    const baseCommit = (await git(repo.top, ["merge-base", ref, tip], { ok: true })).trim() || tip;
    // A worktree of Keel's that has it out for a session that is gone (deleted, archived) is taken over as
    // it is, with what is uncommitted there; one that another live session or the owner has out is not.
    const list = (await git(repo.root, ["worktree", "list", "--porcelain"], { ok: true })).split("\n\n");
    const out = list.map((b) => ({ path: /^worktree (.+)$/m.exec(b)?.[1], branch: /^branch (.+)$/m.exec(b)?.[1] })).find((x) => x.branch === `refs/heads/${branch}`)?.path;
    let path = join(this.root, `${basename(repo.root)}-${sessionKey.replace(/-/g, "").slice(-6)}`);
    if (out) {
      const row = this.store.db.query<Worktree, [string]>("SELECT * FROM worktrees WHERE path = ?").all(out);
      const live = row.some((r) => { const s = this.store.session(r.session_id); return !!s && !s.archived; });
      if (!row.length || live) throw new GitError(`${branch} is checked out at ${out}${live ? " for a session that is still there" : ""}`, 409);
      this.store.db.query("DELETE FROM worktrees WHERE path = ?").run(out);
      path = out;
    } else {
      mkdirSync(this.root, { recursive: true });
      await git(repo.root, ["worktree", "add", "-q", path, branch], { fetch: gitReach(madeFor) });
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
    // The folder gone (removed with git, or parked) is not an empty branch:
    // the branch is read from the repository itself.
    if (!exists) {
      try {
        const ref = (await git(w.repo_root, ["rev-parse", "--verify", "--quiet", `refs/heads/${w.branch}`], { ok: true })).trim();
        if (!ref) return { ...w, exists, dirty: 0, commits_ahead: 0, branch_missing: true };
        const ahead = (await git(w.repo_root, ["rev-list", "--count", `${w.base_commit}..${ref}`])).trim();
        return { ...w, exists, dirty: 0, commits_ahead: Number(ahead) || 0 };
      } catch (e) {
        return { ...w, exists, dirty: 0, commits_ahead: 0, unknown: (e as Error).message };
      }
    }
    try {
      const [work, ahead] = await Promise.all([
        workIn(w.path),
        git(w.path, ["rev-list", "--count", `${w.base_commit}..HEAD`]),
      ]);
      return {
        ...w, exists, dirty: work.dirty, commits_ahead: Number(ahead.trim()) || 0,
        ...(work.inner.length ? { inner: work.inner, ...(work.unpushed ? { inner_unpushed: true } : {}) } : {}), ...(work.unknown.length ? { unknown: cannotRead(work.unknown) } : {}),
      };
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
      // (Without git running inside a submodule or a nested repository: see addAll.)
      await addAll(dir, (args, input) => git(dir, args, { env, input }));
      const tree = (await git(dir, ["write-tree"], { env })).trim();
      const commit = (await ownCommit(dir, ["commit-tree", tree, "-p", "HEAD", "-m", message])).trim();
      await git(dir, ["update-ref", ref, commit]);
      return ref;
    } finally {
      rmSync(index, { force: true });
    }
  }

  // Put a saved working state back into `dir` as uncommitted work.
  private async applyState(dir: string, ref: string, sessionId: string) {
    const snap = (await git(dir, ["rev-parse", ref])).trim();
    const gone = (await git(dir, ["diff", "--name-only", "-z", "--diff-filter=D", "HEAD", snap, "--"])).split("\0").filter(Boolean);
    // (The files come back into the folder: a partial clone may fetch the ones it was promised.)
    await git(dir, ["checkout", snap, "--", "."], { fetch: gitReach(sessionId) });
    for (const f of gone) rmSync(join(dir, f), { force: true });
    await git(dir, ["reset", "-q"]);
  }

  // Take the working state out of `dir`: tracked files back to HEAD, new files removed.
  private async clearState(dir: string) {
    const added = (await git(dir, ["diff", "--cached", "--name-only", "-z", "--diff-filter=A", "HEAD", "--"])).split("\0").filter(Boolean);
    if (added.length) await git(dir, ["rm", "-q", "--cached", "--", ...added]);
    await git(dir, ["checkout", "HEAD", "--", "."], { ok: true });
    await git(dir, ["reset", "-q"]);
    const untracked = (await git(dir, ["ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
    for (const f of [...untracked, ...added]) rmSync(join(dir, f), { force: true });
  }

  // The uncommitted work of a folder, for a move. One it cannot read stops the move.
  private async work(dir: string) {
    const work = await workIn(dir);
    if (work.unknown.length) throw new GitError(`${dir}: ${cannotRead(work.unknown)}`);
    return work;
  }

  // Handoff: a session in the main checkout moves to a new worktree on its own
  // branch, its uncommitted work with it (the main checkout is left at HEAD;
  // the work is also kept on refs/keel/worktree-handoff/<session>).
  // `stayed`: the submodules whose own changes were left in the main checkout.
  async toWorktree(s: Session): Promise<{ wt: Omit<Worktree, "session_id">; cwd: string; moved: number; stayed?: string[] }> {
    const cur = this.get(s.id);
    if (cur && cur.state === "active") throw new GitError("the session already works in a worktree");
    const repo = await this.repoOf(s.workspace);
    if (!repo) throw new GitError(`not a git repository: ${s.workspace}`, 400);
    if (repo.top !== repo.root) throw new GitError("the session's folder is a worktree Keel does not manage; open a session in the main checkout to move it", 400);
    // The outer work moves. A submodule's own changes stay where they are, in
    // the main checkout, and nothing of them is lost. A repository the outer
    // one does not track cannot be moved or left behind cleanly: that stops it.
    const work = await this.work(repo.top);
    if (work.nested.length) throw new GitError(`${repo.top}: ${notKept(work.nested)}`);
    const moved = work.dirty;
    const ref = `refs/keel/worktree-handoff/${s.id}`;
    if (moved) await this.saveState(repo.top, ref, `keel: work moved to a worktree from ${s.workspace}`);
    // A fresh key: an earlier handoff's branch may still exist.
    const made = await this.create(cur ? `${s.id}${Date.now().toString(36)}` : s.id, s.workspace, s.title, undefined, s.id);
    if (moved) {
      await this.applyState(made.wt.path, ref, s.id);
      await this.clearState(repo.top);
    }
    return { ...made, moved, ...(work.held.length ? { stayed: work.held } : {}) };
  }

  // Handoff back: the main checkout switches to the worktree's branch and gets
  // its uncommitted work; the worktree folder goes (the branch can be checked
  // out in one place only). Refused while the main checkout has work of its own.
  async toMain(w: Worktree, s: Session): Promise<{ cwd: string; branch: string; previous: string | null; moved: number }> {
    if (w.state !== "active" || !existsSync(w.path)) throw new GitError(`the worktree is ${w.state === "active" ? "not on disk" : w.state}; restore it first`);
    const mainDirty = (await this.work(w.repo_root)).dirty;
    if (mainDirty) throw new GitError(`the main checkout has ${mainDirty} changed file${mainDirty === 1 ? "" : "s"} of its own: commit or stash them first`);
    // The worktree's folder goes: what a snapshot does not keep would go with it.
    const work = await this.work(w.path);
    if (work.inner.length) throw new GitError(`${w.path}: ${notKept(work.inner, work.unpushed)}`);
    const moved = work.dirty;
    const ref = `refs/keel/worktree-handoff/${s.id}`;
    if (moved) await this.saveState(w.path, ref, `keel: work moved to the main checkout from ${w.branch}`);
    const previous = (await git(w.repo_root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { ok: true })).trim() || null;
    await git(w.repo_root, ["worktree", "remove", "--force", w.path]);
    await git(w.repo_root, ["checkout", "-q", w.branch]);
    if (moved) await this.applyState(w.repo_root, ref, s.id);
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
    const st = await this.status(w);
    if (st.unknown) throw new GitError(`git cannot read the worktree's state: ${st.unknown}`);
    if (st.inner?.length) throw new GitError(notKept(st.inner, st.inner_unpushed));
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
    await git(w.repo_root, ["worktree", "add", "-q", w.path, w.branch], { fetch: gitReach(w.session_id) });
    if (w.snapshot_ref) {
      await this.applyState(w.path, w.snapshot_ref, w.session_id); // the saved work comes back uncommitted, as it was
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
    // With a snapshot too: the folder goes, and what is inside such a repository goes with it.
    if (st.exists && st.inner?.length) return { removed: false, reason: notKept(st.inner, st.inner_unpushed), branch_deleted: false };
    let ref = w.snapshot_ref;
    if (st.exists) {
      if (st.dirty) ref = await this.snapshot(w);
      await git(w.repo_root, ["worktree", "remove", "--force", w.path]);
    }
    let branchDeleted = false;
    if (!st.commits_ahead && !ref && !st.branch_missing) {
      try {
        await git(w.repo_root, ["branch", "-D", w.branch]);
        branchDeleted = true;
      } catch {} // still there: said so (branch_deleted false)
    }
    this.put({ ...w, state: "removed", snapshot_ref: ref });
    return { removed: true, snapshot_ref: ref, branch_deleted: branchDeleted };
  }

  // The worktree a caller found clean (leftovers.ts ownWorktree) goes, and its branch with it when it still
  // points at `sha`, the commit that was checked. git refuses a folder that changed since (a modified or
  // untracked file); only one whose submodules stop a plain remove is removed by force (the caller has checked
  // what is inside them).
  async removeClean(w: Worktree, sha: string | null): Promise<{ removed: boolean; reason?: string; branch_deleted: boolean }> {
    if (existsSync(w.path)) {
      try {
        await git(w.repo_root, ["worktree", "remove", w.path]);
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        if (!/submodule/i.test(e.message)) return { removed: false, reason: `git would not remove it: ${e.message}`, branch_deleted: false };
        try { await git(w.repo_root, ["worktree", "remove", "--force", w.path]); } catch (f) { return { removed: false, reason: `git would not remove it: ${(f as Error).message}`, branch_deleted: false }; }
      }
    }
    let branchDeleted = false;
    if (sha) try { await git(w.repo_root, ["update-ref", "-d", `refs/heads/${w.branch}`, sha]); branchDeleted = true; } catch {} // moved since: kept, and said (branch_deleted false)
    this.put({ ...w, state: "removed", snapshot_ref: null });
    return { removed: true, branch_deleted: branchDeleted };
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
  async branchDiff(s: Session, paths?: string[]): Promise<DiffResult & { is_git: boolean; missing?: boolean; branch: string | null; base: string | null; merge_base: string | null; commits: number }> {
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
    return { is_git: true, branch, base, merge_base: mb, commits, ...(await sh.diff(fromTree, tree, paths)) };
  }

  // The change a review looks at: uncommitted work (tracked and untracked) over
  // HEAD, the branch over its merge base with `base`, or one commit.
  async changeDiff(s: Session, scope: "uncommitted" | "branch" | "commit", ref?: string): Promise<DiffResult & { target: string; from: string; to: string }> {
    if (!existsSync(s.workspace)) throw new GitError("the session's folder is not on disk (a parked worktree?)", 400);
    const top = (await git(s.workspace, ["rev-parse", "--show-toplevel"], { ok: true })).trim();
    if (!top) throw new GitError("the session's folder is not in a git repository", 400);
    if (ref && !/^[\w./@^~-]+$/.test(ref)) throw new GitError(`not a ref name: ${ref}`, 400);
    const gitDir = (await git(top, ["rev-parse", "--absolute-git-dir"])).trim();
    const sh = new Shadow("", top, gitDir);
    // The two trees compared name the whole change (a review is keyed on them, not on a preview cut to fit).
    const between = async (from: string, to: string, target: string) => ({ ...(await sh.diff(from, to)), target, from, to });
    const head = (await git(top, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], { ok: true })).trim() || EMPTY_TREE;
    if (scope === "uncommitted") return between(head, await sh.snapshot(), "HEAD");
    if (scope === "commit") {
      const c = (await git(top, ["rev-parse", "--verify", `${ref || "HEAD"}^{commit}`])).trim();
      const parent = (await git(top, ["rev-parse", "--verify", "--quiet", `${c}^^{tree}`], { ok: true })).trim() || EMPTY_TREE;
      return between(parent, (await git(top, ["rev-parse", `${c}^{tree}`])).trim(), c.slice(0, 12));
    }
    const base = ref || this.get(s.id)?.base || (await this.defaultBase(top));
    if (!base) throw new GitError("no base branch to compare with: name one", 400);
    const mb = (await git(top, ["merge-base", "HEAD", base], { ok: true })).trim();
    if (!mb) throw new GitError(`no merge base with ${base}`, 400);
    return between((await git(top, ["rev-parse", `${mb}^{tree}`])).trim(), await sh.snapshot(), base);
  }

  // The commit that took a reviewed change of uncommitted work whole: the newest
  // hundred commits of HEAD, the oldest whose tree is the reviewed one and whose
  // parent's is the tree the review compared with. Null when none did (a part of
  // it committed, more work since, another branch checked out).
  async committedAs(s: Session, from: string, to: string): Promise<string | null> {
    if (!existsSync(s.workspace)) return null;
    const out = await git(s.workspace, ["log", "-n", "100", "--format=%H %T %P", "HEAD", "--"], { ok: true });
    const rows = out.trim().split("\n").filter(Boolean).map((l) => l.split(" "));
    const tree = new Map(rows.map((r) => [r[0]!, r[1]!]));
    for (let i = rows.length - 1; i >= 0; i--) {
      const [sha, t, parent] = rows[i]!;
      if (t !== to) continue;
      const before = !parent ? EMPTY_TREE : tree.get(parent) ?? (await git(s.workspace, ["rev-parse", "--verify", "--quiet", `${parent}^{tree}`], { ok: true })).trim();
      if (before === from) return sha!;
    }
    return null;
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
    await git(w.path, ["push", "origin", `${w.branch}:${w.branch}`]);
    // The branch's upstream, which `push -u` would record: written to the
    // repository's config file as a file (the push itself reads a view of it).
    const common = locate(w.path)?.common;
    if (common) for (const [k, v] of [["remote", "origin"], ["merge", `refs/heads/${w.branch}`]]) await gitCall(common, ["config", "--file", join(common, "config"), `branch.${w.branch}.${k}`, v!], { mode: "plain" });
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
