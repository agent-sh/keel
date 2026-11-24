// The work board: per agent of a session's tree, its task, state, branch and head, the named checks that
// passed on its head's tree, the latest review of its branch (approved or refused only from a structured verdict), whether the base holds
// its head (or the same patches), and whether what runs holds it. Every column is read from what the
// daemon keeps or git says, never from what a model wrote about its work; a reviewer's words are
// quoted as its. The database is read on the read thread (src/board/facts.ts), git in processes of its
// own, a few at a time; nothing waits on the loop. A board is kept for a few seconds, and what git said of
// a pair of commits for as long as the daemon runs (a pair's answer never changes).
import { during } from "../admin/activity.ts";
import { existsSync, readFileSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { checksOnTree } from "../automation/landing.ts";
import { namedFor, repoOf } from "../checks/ledger.ts";
import { git, gitNames } from "../core/git.ts";
import type { Store } from "../core/store.ts";
import { readsOf } from "../server/reads.ts";
import type { AgentFact, Facts, PairCheckRow, PictureRow, TreeRun } from "./facts.ts";
import { baseHolds } from "./held.ts";
import { FILE as PICTURES_FILE, readPictures } from "../pictures/config.ts";
import { liveFrom, liveSha, pickReview, queueLanded, toLand, type Board, type BoardChecks, type BoardRow, type Change, type Deploy, type Landed, type PairFact, type PictureFact, type Work } from "./rules.ts";

export type BoardDeps = {
  // The base a repository lands on, as a full ref (the landing queue's), or null when it has none.
  baseOf(repo: string): Promise<string | null>;
  // The commit this daemon was built from, when it was built from one.
  revision(): string | null;
};

const KEEP_MS = 3_000;          // a board read again within this is the same answer
const GIT_MS = 15_000;          // one git call of the board
const BOARD_MS = 30_000;        // every git call of one board: past it the rest is not asked, and says so
const AT_ONCE = 4;              // git calls of one board at a time
const PAIRS = 4_000;            // pairs of commits whose answer is kept
const WORKTREES = 40;           // worktrees of one board read for what they change
const UNTRACKED = 200;          // untracked files of one worktree listed
const COUNTED = 40;             // of them, the files whose lines are counted
const FILE_MAX = 256 * 1024;    // the most of one untracked file that is read for its lines
const TOTAL_MAX = 1024 * 1024;  // and of one worktree's untracked files together

const SHA = /^[0-9a-f]{40}$/;

async function pool<T>(items: T[], n: number, f: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await f(items[i++]!); }));
}

export class WorkBoard {
  private boards = new Map<string, { at: number; board: Promise<Board> }>();
  private pairs = new Map<string, Promise<Landed>>();
  stats = { reads: 0, built: 0, git: 0 };

  constructor(private store: Store, private deps: BoardDeps) {}

  // A board that a new fact makes old (a reviewer's verdict): read again next time.
  forget(root: string) { this.boards.delete(root); }

  read(root: string, fresh = false): Promise<Board> {
    this.stats.reads++;
    const kept = this.boards.get(root);
    if (kept && (!fresh || Date.now() - kept.at < 250) && Date.now() - kept.at < KEEP_MS) return kept.board;
    const board = during("task", () => this.build(root), "the work board of a tree");
    this.boards.set(root, { at: Date.now(), board });
    if (this.boards.size > 64) this.boards.delete(this.boards.keys().next().value!);
    board.catch(() => { if (this.boards.get(root)?.board === board) this.boards.delete(root); });
    return board;
  }

  // A git call of the board being built: none once the board's time for git is spent (`by`, a
  // performance.now() deadline), and none longer than what is left of it.
  private async git(repo: string, args: string[], input?: string, by = Infinity) {
    const left = by - performance.now();
    if (left < 250) return { code: -1, out: "", err: "late" };
    this.stats.git++;
    return git(repo, args, { read: true, timeout: Math.min(GIT_MS, Math.ceil(left)), ...(input === undefined ? {} : { input }) });
  }

  // Whether `into` holds `head`: as an ancestor, else as the same patch for each of its commits.
  // `since`: when the agent started (ms), for a branch with no record of where it started.
  private holds(repo: string, head: string, into: string, madeFrom: string | null, by: number, since: number | null = null): Promise<Landed> {
    const key = `${repo}\0${head}\0${into}\0${madeFrom ?? ""}\0${madeFrom ? "" : since ?? ""}`;
    const kept = this.pairs.get(key);
    if (kept) return kept;
    const p = baseHolds((args) => this.git(repo, args, undefined, by), head, into, { madeFrom, since });
    this.pairs.set(key, p);
    if (this.pairs.size > PAIRS) this.pairs.delete(this.pairs.keys().next().value!);
    // A git that failed is asked again next time.
    p.then((l) => { if (l.state === "unknown" && this.pairs.get(key) === p) this.pairs.delete(key); }, () => this.pairs.delete(key));
    return p;
  }

  // What the commits of a branch change over the base (the answer for a pair of commits never changes: kept).
  private spans = new Map<string, Promise<Change | null | undefined>>();
  private span(repo: string, base: string, head: string, by: number): Promise<Change | null | undefined> {
    const key = `${repo}\0${base}\0${head}`;
    const kept = this.spans.get(key);
    if (kept) return kept;
    const p = this.git(repo, ["diff", "--shortstat", "--no-renames", `${base}...${head}`], undefined, by).then((r) => (r.code === 0 ? shortstat(r.out) : undefined));
    this.spans.set(key, p);
    if (this.spans.size > PAIRS) this.spans.delete(this.spans.keys().next().value!);
    // (A git that failed or ran out of time is asked again next time.)
    p.then((c) => { if (c === undefined && this.spans.get(key) === p) this.spans.delete(key); }, () => this.spans.delete(key));
    return p;
  }

  // Whether the commits of a branch change a file under some folders (the answer for a pair of commits never changes: kept).
  private touched = new Map<string, Promise<boolean>>();
  private touches(repo: string, base: string, head: string, folders: string[], by: number): Promise<boolean> {
    const key = `${repo}\0${base}\0${head}\0${folders.join("\0")}`;
    const kept = this.touched.get(key);
    if (kept) return kept;
    const p = this.git(repo, ["diff", "--quiet", "--no-renames", `${base}...${head}`, "--", ...folders], undefined, by).then((r) => {
      if (r.code !== 0 && r.code !== 1) this.touched.delete(key);
      return r.code === 1;
    });
    this.touched.set(key, p);
    if (this.touched.size > PAIRS) this.touched.delete(this.touched.keys().next().value!);
    return p;
  }

  // What a worktree holds uncommitted (tracked changes against its head, and its untracked files, a few of them
  // counted by their lines) and what its commits change over the base. Both are bounded: the listing of untracked
  // files, how many are read and how much of each, and the board's time for git.
  private async changes(repo: string, dir: string, base: string | null, head: string, ahead: number | undefined, by: number): Promise<Work | null> {
    const [branch, tracked, listed] = await Promise.all([
      base && ahead !== 0 ? this.span(repo, base, head, by) : Promise.resolve(null),
      this.git(dir, ["diff", "--shortstat", "--no-renames", "HEAD"], undefined, by),
      gitNames(dir, ["ls-files", "-o", "--exclude-standard", "-z"], UNTRACKED + 1, Math.max(250, Math.min(GIT_MS, Math.ceil(by - performance.now())))),
    ]);
    this.stats.git += 2;
    if (tracked.code !== 0 || listed.failed || listed.none) return null;
    const uncommitted: Change = shortstat(tracked.out) ?? { files: 0, added: 0, removed: 0 };
    if (listed.late || listed.names.length > UNTRACKED) uncommitted.more = true;
    const names = listed.names.slice(0, UNTRACKED);
    uncommitted.files += names.length;
    let left = TOTAL_MAX;
    for (const name of names.slice(0, COUNTED)) {
      const lines = await linesOf(join(dir, name), Math.min(FILE_MAX, left));
      if (lines === undefined) { uncommitted.more = true; continue; }
      left -= lines.read;
      uncommitted.added += lines.n;
      if (lines.cut) uncommitted.more = true;
    }
    if (names.length > COUNTED) uncommitted.more = true;
    return { uncommitted: uncommitted.files ? uncommitted : null, branch: branch ?? null };
  }

  private async build(root: string): Promise<Board> {
    const t0 = performance.now();
    const by = t0 + BOARD_MS;
    this.stats.built++;
    const reads = readsOf(this.store);
    const facts = await reads.run("board.facts", { root }) as Facts;
    const rows = new Map<string, BoardRow>();
    for (const a of facts.agents) rows.set(a.id, rowOf(a));

    // Each repository: its base and the tips of its branches, in one call.
    const byRepo = new Map<string, AgentFact[]>();
    for (const a of facts.agents) if (a.branch && a.repo_root && !a.machine) byRepo.set(a.repo_root, [...(byRepo.get(a.repo_root) ?? []), a]);
    const repos: Board["repos"] = [];
    const trees = new Map<string, string>(); // head -> its tree
    const work: (() => Promise<void>)[] = [];
    const revision = this.deps.revision();
    let worktrees = 0;
    await pool([...byRepo.keys()], AT_ONCE, async (repo) => {
      const base = await this.deps.baseOf(repo).catch(() => null);
      const f = "%(refname)%00%(objectname)";
      let listed = base ? await this.git(repo, ["for-each-ref", `--format=${f}%00%(ahead-behind:${base})`, "refs/heads"], undefined, by) : undefined;
      const counted = !!listed && listed.code === 0;
      if (!counted) listed = await this.git(repo, ["for-each-ref", `--format=${f}`, "refs/heads"], undefined, by);
      const tips = new Map<string, { sha: string; ahead?: number; behind?: number }>();
      for (const l of (listed!.code === 0 ? listed!.out : "").split("\n").filter(Boolean)) {
        const [ref, sha, ab] = l.split("\0");
        const [ahead, behind] = (ab ?? "").split(" ").map(Number);
        tips.set(ref!, { sha: sha!, ...(counted ? { ahead, behind } : {}) });
      }
      const baseTip = base ? tips.get(base)?.sha ?? ((await this.git(repo, ["rev-parse", "-q", "--verify", base], undefined, by)).out.trim() || null) : null;
      // What runs: the commit the after-land step last passed on, and this daemon's build when this repository holds it.
      const deploys: Deploy[] = [];
      const after = facts.deploys.find((d) => d.repo === repo);
      if (after) deploys.push({ sha: after.to_sha, how: "after step passed", at: after.ended });
      if (revision) {
        const r = await this.git(repo, ["rev-parse", "-q", "--verify", `${revision}^{commit}`], undefined, by);
        if (r.code === 0 && SHA.test(r.out.trim()) && r.out.trim() !== after?.to_sha) deploys.push({ sha: r.out.trim(), how: "this daemon", at: null });
      }
      repos.push({ repo, base: base?.replace(/^refs\/(heads|remotes)\//, "") ?? null, base_tip: baseTip, deploys });
      const agents = byRepo.get(repo)!;
      const heads: string[] = [];
      for (const a of agents) {
        const r = rows.get(a.id)!;
        const tip = tips.get(`refs/heads/${a.branch}`);
        r.base = base?.replace(/^refs\/(heads|remotes)\//, "") ?? a.base;
        if (!tip) { r.landed = { state: "unknown", why: "its branch is gone" }; r.checks = { state: "unknown", why: "its branch is gone" }; continue; }
        r.head = tip.sha;
        r.ahead = tip.ahead ?? null;
        r.behind = tip.behind ?? null;
        heads.push(tip.sha);
        r.together = togetherOf(facts.pairs, repo, a.branch!, tip.sha, (b) => tips.get(`refs/heads/${b}`)?.sha, (b) => agents.find((x) => x.branch === b)?.id ?? null);
        // What its worktree changes: read for the newest agents' worktrees, never more than WORKTREES a board.
        if (r.worktree === "here" && a.wt_path && !a.machine && worktrees++ < WORKTREES) work.push(async () => { r.work = await this.changes(repo, a.wt_path!, baseTip, tip.sha, tip.ahead, by); });
        if (!baseTip) { r.landed = { state: "unknown", why: "the repository has no base branch" }; continue; }
        work.push(async () => {
          r.landed = await this.holds(repo, tip.sha, baseTip, a.base_commit, by, a.created);
        });
      }
      // The heads' trees, in one call.
      const uniq = [...new Set(heads)];
      if (uniq.length) {
        const t = await this.git(repo, ["cat-file", "--batch-check=%(objectname)"], uniq.map((h) => `${h}^{tree}`).join("\n") + "\n", by);
        const got = t.code === 0 ? t.out.split("\n") : [];
        uniq.forEach((h, i) => { const tree = got[i]?.trim(); if (tree && SHA.test(tree)) trees.set(h, tree); });
      }
    });
    await pool(work, AT_ONCE, (f) => f());

    // The checks on each head's tree, by the names its repository gives them.
    const runs = trees.size ? await reads.run("board.checks", { trees: [...new Set(trees.values())], heads: [...rows.values()].filter((r) => r.head && r.branch).map((r) => ({ head: r.head!, session: r.session_id })) }) as TreeRun[] : [];
    const runsOf = new Map<string, TreeRun[]>();
    for (const r of runs) runsOf.set(r.tree, [...(runsOf.get(r.tree) ?? []), r]);
    const named = new Map<string, ReturnType<typeof namedFor>>();
    for (const r of rows.values()) {
      if (!r.branch || !r.repo || r.checks) continue;
      if (!named.has(r.repo)) { const at = repoOf(r.repo); named.set(r.repo, at ? namedFor(at) : undefined); }
      const n = named.get(r.repo)?.checks ?? [];
      const tree = r.head ? trees.get(r.head) : undefined;
      r.checks = checksOf(n, tree, tree ? runsOf.get(tree) ?? [] : [], r.head ? runs.filter((x) => x.head === r.head && x.session_id === r.session_id && x.tree !== tree) : []);
    }

    // The before and after pictures of each head, by its repository (its main checkout or its common git directory).
    const heads = [...new Set([...rows.values()].map((r) => r.head).filter((h): h is string => !!h))];
    const pics = heads.length ? await reads.run("board.pictures", { heads }) as PictureRow[] : [];
    for (const r of rows.values()) {
      if (!r.head || !r.repo) continue;
      const p = pics.find((x) => x.head === r.head && (x.repo === r.repo || x.common.startsWith(`${r.repo}/`) || x.common === r.repo));
      if (p) r.pictures = pictureFact(p);
    }
    // A head with no run yet, in a repository that names pictures, whose branch changes its page: "none", taken
    // when someone opens them (the card's pictures, the tree review's, the Review panel: src/pictures/run.ts).
    const pagesOf = new Map<string, string[] | null>();
    const pages = (repo: string) => {
      if (!pagesOf.has(repo)) { let v: string[] | null = null; try { v = readPictures(readFileSync(join(repo, PICTURES_FILE), "utf8")).config?.pages ?? null; } catch {} pagesOf.set(repo, v); }
      return pagesOf.get(repo)!;
    };
    await pool([...rows.values()].filter((r) => !r.pictures && r.head && r.repo && r.base && r.branch && pages(r.repo)), AT_ONCE, async (r) => {
      if (await this.touches(r.repo!, r.base!, r.head!, pages(r.repo!)!, by)) r.pictures = noPictures(r.head!);
    });

    // The latest review of each branch (never its own agent's or one it started), and its newest landing queue entry.
    for (const r of rows.values()) {
      if (!r.branch) continue;
      r.review = pickReview(facts.reviews, r) ?? null;
      const who = r.review && (r.review.how === "task" || r.review.how === "verdict") ? rows.get(r.review.by) : undefined;
      if (who && !who.reviews.includes(r.branch)) who.reviews.push(r.branch);
      const q = facts.queue.filter((x) => x.branch === r.branch && (!r.repo || x.repo === r.repo)).sort((a, b) => b.updated - a.updated)[0];
      if (q) r.queue = { id: q.id, state: q.state, why: q.why, landed: q.landed, tip: q.tip, current: !!r.head && q.tip === r.head, updated: q.updated };
      if (r.landed) r.landed = queueLanded(r.landed, r.queue);
    }
    // Live: whichever deploy of its repository holds a landed head.
    const deploysOf = new Map(repos.map((x) => [x.repo, x.deploys]));
    await pool([...rows.values()].filter((r) => r.landed?.state === "yes" && r.head && r.repo), AT_ONCE, async (r) => {
      const ds = deploysOf.get(r.repo!) ?? [];
      if (!ds.length) { r.live = { state: "unknown", why: "no deploy record: the landing names no after step, and this daemon is not built from this repository" }; return; }
      const held = [];
      // (A head the queue landed that git does not see on the base: the commit the queue put there.)
      const sha = liveSha(r)!;
      for (const d of ds) {
        const h = await this.holds(r.repo!, sha, d.sha, null, by);
        held.push({ deploy: d, holds: h });
        if (h.state === "yes") break;
      }
      r.live = liveFrom(held);
    });
    // Live agents first, then work not landed yet, then the rest; newest first within each (as Claude Code's
    // task list keeps finished work below running work).
    const rank = (r: BoardRow) => (r.state === "running" || r.state === "waiting" ? 0 : toLand(r) ? 1 : 2);
    const ordered = [...rows.values()].sort((a, b) => rank(a) - rank(b) || b.created - a.created);
    return { session_id: root, rows: ordered, total: facts.total, repos, at: Date.now(), took_ms: Math.round(performance.now() - t0) };
  }
}

// "3 files changed, 12 insertions(+), 4 deletions(-)": git's one line of what a diff changes, none for no change.
export function shortstat(out: string): Change | null {
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(out);
  return m ? { files: Number(m[1]), added: Number(m[2] ?? 0), removed: Number(m[3] ?? 0) } : null;
}

// The lines of an untracked file, read up to `max` bytes: none for a link or a binary file, undefined when it could not be read.
async function linesOf(path: string, max: number): Promise<{ n: number; read: number; cut: boolean } | undefined> {
  if (max <= 0) return undefined;
  try {
    if (!(await lstat(path)).isFile()) return { n: 0, read: 0, cut: false };
    const f = await open(path, "r");
    try {
      const buf = Buffer.alloc(max + 1);
      const { bytesRead } = await f.read(buf, 0, max + 1, 0);
      const cut = bytesRead > max;
      const used = buf.subarray(0, Math.min(bytesRead, max));
      if (used.subarray(0, 8000).includes(0)) return { n: 0, read: used.length, cut: false };
      let n = 0;
      for (const b of used) if (b === 10) n++;
      if (used.length && used[used.length - 1] !== 10 && !cut) n++;
      return { n, read: used.length, cut };
    } finally { await f.close(); }
  } catch { return undefined; }
}

function rowOf(a: AgentFact): BoardRow {
  let reviews: string[] = [];
  // (An agent with a branch of its own whose task named another branch is that branch's reviewer only
  // when its review counted: added where it is picked.)
  try { reviews = a.reviews ? (JSON.parse(a.reviews) as { branch: string; how?: string }[]).filter((x) => x.how !== "task" || !a.branch).map((x) => x.branch) : []; } catch {}
  const branch = a.branch ?? null;
  const remote = !!a.machine && !!branch;
  return {
    id: a.id, session_id: a.session_id, parent_id: a.parent_id, depth: a.depth, title: a.title, type: a.type, model: a.model,
    state: a.status, created: a.created, ended: a.ended ?? null, machine: a.machine ?? null,
    branch, repo: a.repo_root ?? null, base: a.base ?? null, head: null, ahead: null, behind: null,
    worktree: !branch ? null : a.wt_path && a.wt_state === "active" && existsSync(a.wt_path) ? "here" : "gone",
    checks: !branch ? null : remote ? { state: "unknown", why: "its branch is on another machine" } : !a.repo_root ? { state: "unknown", why: "no worktree record names its repository" } : null,
    review: null, reviews,
    landed: !branch ? null : remote ? { state: "unknown", why: "its branch is on another machine" } : !a.repo_root ? { state: "unknown", why: "no worktree record names its repository" } : null,
    queue: null, live: null, work: null, together: branch ? [] : null, pictures: null,
  };
}

// The pairs a branch was checked in at its head, whose other head is its branch's now, newest first.
function togetherOf(rows: PairCheckRow[], repo: string, branch: string, head: string, tipOf: (b: string) => string | undefined, agentOf: (b: string) => string | null): PairFact[] {
  const out: PairFact[] = [];
  const seen = new Set<string>();
  for (const p of rows) {
    if (p.repo !== repo) continue;
    const mine = p.branch1 === branch && p.tip1 === head ? 1 : p.branch2 === branch && p.tip2 === head ? 2 : 0;
    if (!mine) continue;
    const [w, wt] = mine === 1 ? [p.branch2, p.tip2] : [p.branch1, p.tip1];
    if (tipOf(w) !== wt || seen.has(w)) continue;
    seen.add(w);
    let checks: PairFact["checks"] = [];
    try { checks = p.checks ? JSON.parse(p.checks) : []; } catch {}
    out.push({ with: w, with_agent: agentOf(w), head, with_head: wt, base_tip: p.base_tip, state: p.state as PairFact["state"], why: p.why, detail: p.detail, checks, error: p.error, at: p.ended ?? p.started });
  }
  return out;
}

function checksOf(named: readonly { name: string; run: string; dir: string }[], tree: string | undefined, runs: TreeRun[], uncommitted: TreeRun[] = []): BoardChecks {
  if (!named.length) return { state: "none" };
  if (!tree) return { state: "unknown", why: "the tree of its head could not be read" };
  const by = new Map(named.map((c) => [c.name, c.dir]));
  const of = (list: TreeRun[]) => list.filter((r) => { const dir = by.get(r.name); return dir !== undefined && (dir === "*" || dir === r.dir); });
  const on = checksOnTree(named, of(runs));
  // A check that decided on files the commit does not hold, and on no commit of this head: said apart from "not run".
  const off = of(uncommitted).length ? checksOnTree(named, of(uncommitted)) : undefined;
  const passed = off?.passed.filter((n) => !on.passed.includes(n) && !on.failed.includes(n)) ?? [];
  const failed = off?.failed.filter((n) => !on.passed.includes(n) && !on.failed.includes(n)) ?? [];
  return { state: "known", ...on, ...(passed.length || failed.length ? { uncommitted: { passed, failed } } : {}) };
}

const noPictures = (head: string): PictureFact => ({
  id: 0, state: "none", why: null, head, merge_base: null, counts: { changed: 0, unstable: 0, new: 0, gone: 0, unread: 0, same: 0 },
  specs: [], sides: { before: { state: "none" }, after: { state: "none" } }, differ: [], kept: false,
});

function pictureFact(p: PictureRow): PictureFact {
  const parse = <T>(t: string | null, none: T): T => { try { return t ? JSON.parse(t) as T : none; } catch { return none; } };
  const pairs = parse<{ name: string; state: string; w?: number; h?: number; boxes?: PictureFact["differ"][number]["boxes"] }[]>(p.pairs, []);
  const counts = { changed: 0, unstable: 0, new: 0, gone: 0, unread: 0, same: 0 };
  for (const x of pairs) if (x.state in counts) counts[x.state as keyof typeof counts]++;
  const sel = parse<{ specs?: { path: string }[] } | null>(p.selection, null);
  const sides = parse<PictureFact["sides"]>(p.sides, { before: { state: "none" }, after: { state: "none" } });
  return {
    id: p.id, state: p.state as PictureFact["state"], why: p.why, head: p.head, merge_base: p.merge_base, counts,
    specs: (sel?.specs ?? []).map((s) => s.path), sides, kept: !!p.kept,
    differ: pairs.filter((x) => x.state === "changed" || x.state === "new" || x.state === "gone").slice(0, 4).map((x) => ({ name: x.name, state: x.state, w: x.w, h: x.h, boxes: x.boxes })),
  };
}
