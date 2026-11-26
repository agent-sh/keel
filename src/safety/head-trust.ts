// Who wrote the head of a pull request a session starts at. A request from a fork can write any file of its
// tree, the instruction files, skills, hook file and check names a session reads as the repository's own, so
// the head is trusted only when its author is the owner or can write to the base repository (or the request
// is a branch of the repository itself). Anything else, and anything that cannot be read, is held:
//
// - the instruction files come from the base: the merge base's tree (the head's own are read as files, like
//   any other text in the tree, and are never added to the prompt);
// - the head's skills, hook file and check names do not load or run;
// - the owner trusts the head from the session's chip, and then it behaves as any repository's tree.
//
// The lookup asks the code host's own tool (`gh`, `glab`) for the request's author and whether it is a fork,
// then for the author's permission on the base repository. Pure parts are exported for the tests.
import type { Store } from "../core/store.ts";
import { git, gitEnv } from "../core/git.ts";
import { outputOf } from "../core/proc.ts";
import { isInstructionPath } from "./instruction-files.ts";
import type { Host } from "../worktree/pr-head.ts";

export type HeadState = "held" | "trusted" | "owner";
export type HeadRow = {
  path: string;            // the worktree: the root of the tree the files are read from
  session_id: string;
  number: number;
  host: Host;
  author: string | null;
  fork: number | null;     // 1 a fork, 0 a branch of the repository, null not known
  state: HeadState;
  why: string;
  base_ref: string | null;
  merge_base: string | null;
  head_commit: string;
  base_files: string;      // JSON: the base's instruction files, by path from the root
  decided: number;
};
export type Held = { root: string; session_id: string; number: number; why: string; base(path: string): string | null };

// What is asked of the host, as the lookup reads it.
export type Who = { known: boolean; author?: string; fork?: boolean; permission?: string; viewer?: string; baseRef?: string; note?: string };
export type Run = (bin: string, args: string[], cwd: string) => Promise<{ code: number; out: string }>;

const WRITES = new Set(["write", "maintain", "admin"]);
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[bot\])?$/;

// Whether the head is trusted, and the sentence that says why (or why not).
export function judge(w: Who): { trusted: boolean; why: string } {
  if (!w.known) return { trusted: false, why: w.note || "who wrote the head could not be read" };
  const by = w.author ? ` by ${w.author}` : "";
  if (w.fork === false) return { trusted: true, why: `a branch of the repository itself${by}` };
  if (w.fork === undefined) return { trusted: false, why: "whether the request is from a fork could not be read" };
  if (w.viewer && w.author && w.viewer.toLowerCase() === w.author.toLowerCase()) return { trusted: true, why: "your own pull request from a fork" };
  if (w.permission && WRITES.has(w.permission.toLowerCase())) return { trusted: true, why: `a fork by ${w.author}, who can write to the repository (${w.permission.toLowerCase()})` };
  return { trusted: false, why: `a fork by ${w.author ?? "someone"}, who does not have write access to the repository${w.permission ? ` (${w.permission.toLowerCase()})` : ""}` };
}

const json = (s: string): any => { try { return JSON.parse(s); } catch { return undefined; } };

// GitHub: gh pr view for the author and the fork, then the author's permission and the signed-in user.
async function github(run: Run, o: { named: string; cwd: string }): Promise<Who> {
  const gh = process.env.KEEL_GH_BIN || "gh";
  const v = await run(gh, ["pr", "view", o.named, "--json", "author,isCrossRepository,headRepositoryOwner,baseRefName,url"], o.cwd);
  const j = v.code === 0 ? json(v.out) : undefined;
  if (!j) return { known: false, note: "gh could not read the pull request, so who wrote its head is not known" };
  const author = typeof j.author?.login === "string" ? j.author.login : undefined;
  const fork = typeof j.isCrossRepository === "boolean" ? j.isCrossRepository : undefined;
  const baseRef = typeof j.baseRefName === "string" ? j.baseRefName : undefined;
  if (!author || !LOGIN.test(author) || fork === undefined) return { known: false, note: "gh did not say who wrote the head", baseRef };
  if (!fork) return { known: true, author, fork, baseRef };
  const repo = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(String(j.url ?? ""))?.[1];
  const [perm, me] = await Promise.all([
    repo ? run(gh, ["api", `repos/${repo}/collaborators/${author}/permission`], o.cwd) : Promise.resolve({ code: 1, out: "" }),
    run(gh, ["api", "user"], o.cwd),
  ]);
  const p = perm.code === 0 ? json(perm.out) : undefined;
  const u = me.code === 0 ? json(me.out) : undefined;
  return {
    known: true, author, fork, baseRef,
    ...(typeof (p?.role_name ?? p?.permission) === "string" ? { permission: p.role_name ?? p.permission } : {}),
    ...(typeof u?.login === "string" ? { viewer: u.login } : {}),
  };
}

// GitLab: glab mr view for the author and the projects, then the author's access level (30, a developer, writes).
async function gitlab(run: Run, o: { named: string; cwd: string }): Promise<Who> {
  const glab = process.env.KEEL_GLAB_BIN || "glab";
  const v = await run(glab, ["mr", "view", o.named, "-F", "json"], o.cwd);
  const j = v.code === 0 ? json(v.out) : undefined;
  if (!j) return { known: false, note: "glab could not read the merge request, so who wrote its head is not known" };
  const author = typeof j.author?.username === "string" ? j.author.username : undefined;
  const src = j.source_project_id, dst = j.target_project_id;
  const baseRef = typeof j.target_branch === "string" ? j.target_branch : undefined;
  if (!author || !LOGIN.test(author) || src === undefined || dst === undefined) return { known: false, note: "glab did not say who wrote the head", baseRef };
  if (src === dst) return { known: true, author, fork: false, baseRef };
  const id = j.author?.id;
  const [perm, me] = await Promise.all([
    Number.isSafeInteger(id) && Number.isSafeInteger(dst) ? run(glab, ["api", `projects/${dst}/members/all/${id}`], o.cwd) : Promise.resolve({ code: 1, out: "" }),
    run(glab, ["api", "user"], o.cwd),
  ]);
  const level = perm.code === 0 ? json(perm.out)?.access_level : undefined;
  const u = me.code === 0 ? json(me.out) : undefined;
  return {
    known: true, author, fork: true, baseRef,
    ...(typeof level === "number" ? { permission: level >= 30 ? "write" : "read" } : {}),
    ...(typeof u?.username === "string" ? { viewer: u.username } : {}),
  };
}

// `named`: what the owner gave (the number, or the address), which both tools take.
export async function whoWroteHead(run: Run, o: { host: Host; named: string; cwd: string; origin: string; hasHost: boolean }): Promise<Who> {
  try {
    // A repository on this machine has no host to ask; a test's stand-in tool is asked all the same.
    if (!o.hasHost && !(o.host === "github" ? process.env.KEEL_GH_BIN : process.env.KEEL_GLAB_BIN)) return { known: false, note: "origin is not on a code host this machine can ask who wrote the head" };
    return await (o.host === "gitlab" ? gitlab : github)(run, o);
  } catch (e) {
    return { known: false, note: `who wrote the head could not be read: ${(e as Error).message}` };
  }
}

// Each tool is asked with no prompt and a time limit; its own sign-in is what it uses.
export const runTool: Run = async (bin, args, cwd) => {
  try {
    const p = Bun.spawn([bin, ...args], { cwd, env: { ...gitEnv(cwd), GH_PROMPT_DISABLED: "1", GLAB_NO_PROMPT: "1", NO_COLOR: "1" }, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 20_000 });
    const { out, code } = await outputOf(p, { where: bin });
    return { code, out };
  } catch {
    return { code: 127, out: "" };
  }
};

const FILE_MAX = 200_000;
const FILES_MAX = 100;

// The registry the readers of a tree ask (the instruction filter, the hook file, the named checks, the gate):
// the head held at a path, if the path is in one.
export const headHold: { of?: (path: string) => Held | undefined } = {};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS head_trust (path TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, number INTEGER NOT NULL, host TEXT NOT NULL,
  author TEXT, fork INTEGER, state TEXT NOT NULL, why TEXT NOT NULL, base_ref TEXT, merge_base TEXT, head_commit TEXT NOT NULL, base_files TEXT NOT NULL DEFAULT '{}', decided INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS head_trust_session ON head_trust(session_id);
`;

export class HeadTrust {
  private rows = new Map<string, HeadRow>();
  private files = new Map<string, Record<string, string>>();

  constructor(private store: Store, private run: Run = runTool) {
    store.migrate(SCHEMA);
    for (const r of store.db.query<HeadRow, []>("SELECT * FROM head_trust").all()) this.rows.set(r.path, r);
    headHold.of = (p) => this.held(p);
  }

  // The tree's root when `path` is in one whose head is held.
  held(path: string): Held | undefined {
    for (const r of this.rows.values()) {
      if (r.state !== "held" || !(path === r.path || path.startsWith(r.path + "/"))) continue;
      return { root: r.path, session_id: r.session_id, number: r.number, why: r.why, base: (p) => this.baseText(r, p) };
    }
    return undefined;
  }

  private baseText(r: HeadRow, path: string): string | null {
    let files = this.files.get(r.path);
    if (!files) { files = json(r.base_files) ?? {}; this.files.set(r.path, files!); }
    return files![path.slice(r.path.length + 1)] ?? null;
  }

  forSession(sessionId: string): HeadRow | undefined {
    for (const r of this.rows.values()) if (r.session_id === sessionId) return r;
    return undefined;
  }

  // The instruction files of the base's tree: every file a model family's chain loads (src/safety/instruction-files.ts), by path from the root.
  private async baseFiles(top: string, commit: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const list = (await git(top, ["ls-tree", "-r", "--name-only", "-z", commit], { read: true })).out.split("\0").filter((f) => f && isInstructionPath(f)).slice(0, FILES_MAX);
    for (const f of list) {
      const r = await git(top, ["show", `${commit}:${f}`], { read: true });
      if (r.code === 0) out[f] = r.out.slice(0, FILE_MAX);
    }
    return out;
  }

  // The commit the head and the base branch share. The branch the host names, as origin has it or as it is
  // here, else the branch origin points at, else the one the main checkout has out. Nothing is fetched.
  private async mergeBase(top: string, head: string, baseRef?: string): Promise<{ ref: string; commit: string } | null> {
    const first = async (...cands: (string | undefined)[]) => {
      for (const c of cands) {
        if (!c || !/^[\w./@-]+$/.test(c)) continue;
        const r = await git(top, ["merge-base", head, `${c}^{commit}`], { read: true });
        const commit = r.out.trim();
        if (r.code === 0 && commit) return { ref: c, commit };
      }
      return null;
    };
    const origin = (await git(top, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { read: true })).out.trim();
    const here = (await git(top, ["symbolic-ref", "--quiet", "--short", "HEAD"], { read: true })).out.trim();
    return first(baseRef && `origin/${baseRef}`, baseRef, origin, here);
  }

  // Decide the head of a session's worktree and keep the decision. A head that is not trusted keeps the base's
  // instruction files with the row.
  async record(o: { sessionId: string; path: string; top: string; number: number; host: Host; named: string; origin: string; hasHost: boolean; commit: string }): Promise<HeadRow> {
    const who = await whoWroteHead(this.run, { host: o.host, named: o.named, cwd: o.top, origin: o.origin, hasHost: o.hasHost });
    const v = judge(who);
    let base: { ref: string; commit: string } | null = null;
    let files: Record<string, string> = {};
    if (!v.trusted) {
      base = await this.mergeBase(o.top, o.commit, who.baseRef);
      if (base) files = await this.baseFiles(o.top, base.commit);
    }
    const row: HeadRow = {
      path: o.path, session_id: o.sessionId, number: o.number, host: o.host, author: who.author ?? null, fork: who.fork === undefined ? null : who.fork ? 1 : 0,
      state: v.trusted ? "trusted" : "held", why: v.why, base_ref: base?.ref ?? null, merge_base: base?.commit ?? null, head_commit: o.commit, base_files: JSON.stringify(files), decided: Date.now(),
    };
    this.store.db.query(`INSERT INTO head_trust (path, session_id, number, host, author, fork, state, why, base_ref, merge_base, head_commit, base_files, decided)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET session_id = excluded.session_id, number = excluded.number, host = excluded.host, author = excluded.author, fork = excluded.fork,
      state = excluded.state, why = excluded.why, base_ref = excluded.base_ref, merge_base = excluded.merge_base, head_commit = excluded.head_commit, base_files = excluded.base_files, decided = excluded.decided`)
      .run(row.path, row.session_id, row.number, row.host, row.author, row.fork, row.state, row.why, row.base_ref, row.merge_base, row.head_commit, row.base_files, row.decided);
    this.rows.set(row.path, row);
    this.files.delete(row.path);
    return row;
  }

  // The owner trusts the session's head: its files load as any repository's tree does.
  trust(sessionId: string): HeadRow | undefined {
    const r = this.forSession(sessionId);
    if (!r || r.state !== "held") return r;
    const next: HeadRow = { ...r, state: "owner", decided: Date.now() };
    this.store.db.query("UPDATE head_trust SET state = 'owner', decided = ? WHERE path = ?").run(next.decided, r.path);
    this.rows.set(r.path, next);
    return next;
  }

  // What the page shows.
  view(sessionId: string) {
    const r = this.forSession(sessionId);
    return r ? { held: r.state === "held", state: r.state, number: r.number, author: r.author, fork: r.fork === null ? null : r.fork === 1, why: r.why, base_ref: r.base_ref, merge_base: r.merge_base, head_commit: r.head_commit } : null;
  }
}
