// The work board: per agent of a session's tree, its task, state, branch and head, the named checks that
// passed on its head's tree, the latest review of its branch with the verdict line, whether the base holds
// its head (or the same patches), and whether what runs holds it. Every column is read from what the
// daemon keeps or git says, never from what a model wrote about its work; a reviewer's verdict line is
// quoted as its. The database is read on the read thread (src/board/facts.ts), git in processes of its
// own, a few at a time; nothing waits on the loop. A board is kept for a few seconds, and what git said of
// a pair of commits for as long as the daemon runs (a pair's answer never changes).
import { existsSync } from "node:fs";
import { checksOnTree, type ChecksOn } from "../automation/landing.ts";
import { namedFor, repoOf } from "../checks/ledger.ts";
import { git } from "../core/git.ts";
import type { Store } from "../core/store.ts";
import { readsOf } from "../server/reads.ts";
import type { AgentFact, Facts, TreeRun } from "./facts.ts";
import { landedFrom, liveFrom, pickReview, queueLanded, toLand, type Board, type BoardRow, type Deploy, type Landed } from "./rules.ts";

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

  read(root: string, fresh = false): Promise<Board> {
    this.stats.reads++;
    const kept = this.boards.get(root);
    if (kept && (!fresh || Date.now() - kept.at < 250) && Date.now() - kept.at < KEEP_MS) return kept.board;
    const board = this.build(root);
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
    const p = (async (): Promise<Landed> => {
      if (madeFrom && head === madeFrom) return { state: "nothing" };
      const anc = await this.git(repo, ["merge-base", "--is-ancestor", head, into], undefined, by);
      if (anc.err === "late") return { state: "unknown", why: "the board's time for git ran out" };
      const ancestor = anc.code === 0 ? true : anc.code === 1 ? false : null;
      if (ancestor === true && !madeFrom && since != null) {
        const t = await this.git(repo, ["log", "-1", "--format=%ct", head], undefined, by);
        const headTime = t.code === 0 ? Number(t.out.trim()) || null : null;
        return headTime === null ? { state: "unknown", why: "its worktree keeps no start, and git did not say when its head was made" } : landedFrom({ head, madeFrom, ancestor, cherry: undefined, headTime, since: Math.floor(since / 1000) - 60 });
      }
      if (ancestor !== false) return landedFrom({ head, madeFrom, ancestor, cherry: undefined });
      const ch = await this.git(repo, ["cherry", into, head], undefined, by);
      if (ch.err === "late") return { state: "unknown", why: "the board's time for git ran out" };
      return landedFrom({ head, madeFrom, ancestor, cherry: ch.code === 0 ? ch.out : undefined });
    })();
    this.pairs.set(key, p);
    if (this.pairs.size > PAIRS) this.pairs.delete(this.pairs.keys().next().value!);
    // A git that failed is asked again next time.
    p.then((l) => { if (l.state === "unknown" && this.pairs.get(key) === p) this.pairs.delete(key); }, () => this.pairs.delete(key));
    return p;
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
    const runs = trees.size ? await reads.run("board.checks", { trees: [...new Set(trees.values())] }) as TreeRun[] : [];
    const runsOf = new Map<string, TreeRun[]>();
    for (const r of runs) runsOf.set(r.tree, [...(runsOf.get(r.tree) ?? []), r]);
    const named = new Map<string, ReturnType<typeof namedFor>>();
    for (const r of rows.values()) {
      if (!r.branch || !r.repo || r.checks) continue;
      if (!named.has(r.repo)) { const at = repoOf(r.repo); named.set(r.repo, at ? namedFor(at) : undefined); }
      const n = named.get(r.repo)?.checks ?? [];
      const tree = r.head ? trees.get(r.head) : undefined;
      r.checks = checksOf(n, tree, tree ? runsOf.get(tree) ?? [] : []);
    }

    // The latest review of each branch (never its own agent's or one it started), and its newest landing queue entry.
    const parentOf = new Map(facts.agents.map((a) => [a.session_id, a.parent_id]));
    const sessionOf = new Map(facts.agents.map((a) => [a.id, a.session_id]));
    const lineage = { parentOf: (s: string) => parentOf.get(s), sessionOf: (id: string) => sessionOf.get(id) };
    for (const r of rows.values()) {
      if (!r.branch) continue;
      r.review = pickReview(facts.reviews, r, lineage) ?? null;
      const who = r.review && r.review.how === "task" ? rows.get(r.review.by) : undefined;
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
      for (const d of ds) {
        const h = await this.holds(r.repo!, r.head!, d.sha, null, by);
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
    queue: null, live: null,
  };
}

function checksOf(named: readonly { name: string; run: string; dir: string }[], tree: string | undefined, runs: TreeRun[]): ChecksOn {
  if (!named.length) return { state: "none" };
  if (!tree) return { state: "unknown", why: "the tree of its head could not be read" };
  const by = new Map(named.map((c) => [c.name, c.dir]));
  const mine = runs.filter((r) => { const dir = by.get(r.name); return dir !== undefined && (dir === "*" || dir === r.dir); });
  return { state: "known", ...checksOnTree(named, mine) };
}
