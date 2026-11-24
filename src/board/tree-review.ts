// One review for a tree: the branches a session's agents left, read as one diff by area, each hunk with the
// agent, branch, review verdict and checks the work board holds of it (src/board/board.ts), the hunks of two
// branches that change the same lines side by side with what git's merge of the two says, and the owner's
// decision per area: land (through the landing queue, in the order proposed from the overlaps), send back to
// the agents with a note, or drop. The pure part is src/board/tree.ts.
//
// Cheap by design: each branch head's diff is read from git once (two calls: its merge base and its diff,
// limited by a numstat first) and parsed on the read thread; what git's merge of two tips says is asked only
// for pairs whose hunks meet, and kept for those tips. Nothing of a repository is written.
import type { Store } from "../core/store.ts";
import { git } from "../core/git.ts";
import type { Result } from "../worktree/overlap.ts";
import { areasOf, inOrder, Keep, landOrder, namesLine, overlapsOf, pairsOf, type BranchDiff, type DiffFile, type DiffHunk, type Order, type Overlap, type ParsedDiff } from "./tree.ts";
import { toLand, type Board, type BoardRow, type Verdict } from "./rules.ts";

// The owner's decisions: one a branch of an area, with the mark of what the branch changed there then.
const SCHEMA = `CREATE TABLE IF NOT EXISTS tree_review (root TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, repo TEXT NOT NULL, area TEXT NOT NULL,
  branch TEXT NOT NULL, head TEXT NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (root, repo, area, branch))`;
// When the owner last cleared an area's decisions: a send-back after it is a new one, delivered even with
// the same note to the same head (the key agents.send stores an input once by names it).
const CLEARS = `CREATE TABLE IF NOT EXISTS tree_review_clears (root TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, repo TEXT NOT NULL, area TEXT NOT NULL,
  at INTEGER NOT NULL, PRIMARY KEY (root, repo, area))`;

const AT_ONCE = 4;              // git calls of one review at a time
const GIT_MS = 20_000;          // one git call
// Branch heads' diffs kept: each holds up to KEEP_LINES lines of hunks (src/board/tree.ts), so a few trees'
// worth. A merge's answer is a word and a few file names: a tree of 30 branches that all meet asks 465 a
// view, and this keeps that for four such trees.
const DIFFS_KEPT = 512;
export const MERGES_KEPT = 2048;
const VIEW_MS = 2_000;          // a view read again within this is the same answer
// A branch whose numstat counts more changed lines than this is diffed for its first files only, up to it:
// the rest is listed with its counts.
const DIFF_LINES = 20_000;
const HUNK_LINES = 400;         // lines of one hunk the area view sends; the rest are counted

// `head`: the mark of what the branch changed in the area when it was made; `current`: it still changes the same.
export type Decision = { branch: string; head: string; action: "land" | "back" | "drop"; note: string; at: number; outcome: string; current: boolean };
export type TreeBranch = {
  agent: string; session_id: string; title: string; state: string; branch: string; head: string; merge_base: string | null;
  verdict: Verdict | null; review_by: string | null; review_line: string;
  checks: BoardRow["checks"]; ready: boolean; working: boolean; base_conflict: boolean | null;
  files: number; added: number; removed: number; cut: boolean; error?: string; queue: BoardRow["queue"];
  pictures: BoardRow["pictures"] | null; // its head's before and after pictures, when its repository names them
};
export type AreaFile = { path: string; branches: { branch: string; status: DiffFile["status"]; added: number; removed: number }[] };
export type TreeArea = {
  key: string; files: AreaFile[]; branches: string[]; added: number; removed: number; hunks: number; overlaps: string[];
  order: string[]; decisions: Decision[];
  // The other areas the area's branches change too: landing it lands them as well.
  carries: Record<string, string[]>;
  // Each branch's mark of what it changes here (a decision is recorded with it).
  marks: Record<string, string>;
};
export type TreePair = { a: string; b: string; files: string[]; conflict: boolean | null; conflict_files: string[]; note: string };
export type TreeOverlap = Overlap & { area: string; note: string; conflict: boolean | null };
export type TreeView = {
  session_id: string; repo: string | null; repos: string[]; base: string | null; base_tip: string | null;
  branches: TreeBranch[]; areas: TreeArea[]; overlaps: TreeOverlap[]; pairs: TreePair[]; order: Order;
  skipped: { landed: number; empty: number; gone: number };
  // Branches the proposed order leaves out, and why: the agent works, or the owner sent it back or dropped
  // an area it changes, and what it changes there is the same since.
  held: Record<string, string>;
  at: number; took_ms: number; stats: { diffs: number; kept: number; merges: number; git: number };
};
export type AreaHunk = DiffHunk & { branch: string; index: number; overlap: string | null; more: number };
export type AreaDetail = { key: string; files: { path: string; hunks: AreaHunk[]; cut: string[] }[] };

export type TreeDeps = {
  board(root: string, fresh: boolean): Promise<Board>;
  merge(repo: string, a: string, b: string): Promise<Result>;
  noAttrs(repo: string): Promise<string[]>;
  // The branches of the forecast that conflict with the base at their tip now (live branches only).
  baseConflicts(repo: string): Map<string, string>; // branch → the tip the forecast judged
  parse(text: string): Promise<ParsedDiff>;
};

type Kept = { mergeBase: string | null; parsed: ParsedDiff; error?: string };

// A few git calls at a time, across the reviews of every tree.
class Gate {
  private n = 0;
  private waiting: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(f: () => Promise<T>): Promise<T> {
    if (this.n >= this.max) await new Promise<void>((ok) => this.waiting.push(ok));
    this.n++;
    try { return await f(); } finally { this.n--; this.waiting.shift()?.(); }
  }
}

const short = (s: string) => s.slice(0, 9);
const bare = (b: string) => b.replace(/^refs\/(heads|remotes)\//, "");

export class TreeReview {
  private diffs = new Keep<string, Promise<Kept>>(DIFFS_KEPT);
  private merges = new Keep<string, Promise<Result>>(MERGES_KEPT);
  private views = new Keep<string, { at: number; view: Promise<TreeView> }>(256);
  private gate = new Gate(AT_ONCE);
  stats = { diffs: 0, merges: 0, git: 0 };

  constructor(private store: Store, private d: TreeDeps) {
    store.migrate(SCHEMA);
    store.migrate(CLEARS);
  }

  forget(root: string) { for (const k of [...this.views.keys()]) if (k.startsWith(`${root}\0`)) this.views.delete(k); }

  private git(repo: string, args: string[]) {
    this.stats.git++;
    return this.gate.run(() => git(repo, args, { read: true, timeout: GIT_MS }));
  }

  // A branch head's diff against its merge base with the base tip, read once.
  private diffOf(repo: string, baseTip: string, head: string): Promise<Kept> {
    const key = `${repo}\0${baseTip}\0${head}`;
    const kept = this.diffs.get(key);
    if (kept) return kept;
    const p = (async (): Promise<Kept> => {
      this.stats.diffs++;
      const mb = await this.git(repo, ["merge-base", baseTip, head]);
      const from = mb.code === 0 ? mb.out.trim().split("\n")[0]! : "";
      if (!from) return { mergeBase: null, parsed: { files: [], lines: 0, cut: false }, error: mb.err.trim().split("\n").at(-1) || "no merge base with the base" };
      const attrs = await this.d.noAttrs(repo);
      const opts = [...attrs, "-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames"];
      const num = await this.git(repo, [...opts, "--numstat", "-z", from, head]);
      if (num.code !== 0) return { mergeBase: from, parsed: { files: [], lines: 0, cut: false }, error: num.err.trim().split("\n").at(-1) || "git diff failed" };
      const counts = numstat(num.out);
      let total = 0;
      const within: string[] = [];
      for (const c of counts) { total += c.added + c.removed; if (total <= DIFF_LINES) within.push(c.path); }
      const limited = total > DIFF_LINES;
      const r = await this.git(repo, [...opts, "-U3", from, head, ...(limited ? ["--", ...within.map((p) => `:(literal)${p}`)] : [])]);
      if (r.code !== 0) return { mergeBase: from, parsed: { files: [], lines: 0, cut: false }, error: r.err.trim().split("\n").at(-1) || "git diff failed" };
      const parsed = await this.d.parse(r.out);
      if (limited) {
        // The files past the limit: their counts, with no hunks.
        const have = new Set(parsed.files.map((f) => f.path));
        for (const c of counts) if (!have.has(c.path)) parsed.files.push({ path: c.path, status: c.binary ? "B" : "M", added: c.added, removed: c.removed, hunks: [], cut: true });
        parsed.cut = true;
      }
      return { mergeBase: from, parsed };
    })();
    this.diffs.set(key, p);
    // A git that failed is asked again next time.
    p.then((k) => { if (k.error && this.diffs.is(key, p)) this.diffs.delete(key); }, () => this.diffs.delete(key));
    return p;
  }

  private mergeOf(repo: string, a: string, b: string): Promise<Result> {
    const key = `${repo}\0${a}\0${b}`;
    const kept = this.merges.get(key);
    if (kept) return kept;
    const p = this.gate.run(() => { this.stats.merges++; return this.d.merge(repo, a, b); });
    this.merges.set(key, p);
    p.then((r) => { if ("error" in r && this.merges.is(key, p)) this.merges.delete(key); }, () => this.merges.delete(key));
    return p;
  }

  view(root: string, o: { fresh?: boolean; repo?: string } = {}): Promise<TreeView> {
    const key = `${root}\0${o.repo ?? ""}`;
    const kept = this.views.get(key);
    if (kept && !o.fresh && Date.now() - kept.at < VIEW_MS) return kept.view;
    const view = this.build(root, o);
    const entry = { at: Date.now(), view };
    this.views.set(key, entry);
    view.catch(() => { if (this.views.is(key, entry)) this.views.delete(key); });
    return view;
  }

  private async build(root: string, o: { fresh?: boolean; repo?: string }): Promise<TreeView> {
    const t0 = performance.now();
    const before = { ...this.stats };
    const board = await this.d.board(root, !!o.fresh);
    const withBranch = board.rows.filter((r) => r.branch && r.repo);
    const repos = [...new Set(withBranch.map((r) => r.repo!))];
    // The repository with the most branches to land, unless one is asked for.
    const count = (repo: string) => withBranch.filter((r) => r.repo === repo && toLand(r)).length;
    const repo = o.repo && repos.includes(o.repo) ? o.repo : [...repos].sort((a, b) => count(b) - count(a))[0] ?? null;
    const at = board.repos.find((x) => x.repo === repo);
    const empty: TreeView = { session_id: root, repo, repos, base: at?.base ? bare(at.base) : null, base_tip: at?.base_tip ?? null, branches: [], areas: [], overlaps: [], pairs: [], order: { steps: [], why: {} }, skipped: { landed: 0, empty: 0, gone: 0 }, held: {}, at: Date.now(), took_ms: 0, stats: { diffs: 0, kept: 0, merges: 0, git: 0 } };
    if (!repo || !at?.base_tip) return { ...empty, took_ms: Math.round(performance.now() - t0) };
    const baseTip = at.base_tip;
    const mine = withBranch.filter((r) => r.repo === repo);
    const skipped = {
      landed: mine.filter((r) => r.landed?.state === "yes").length,
      empty: mine.filter((r) => r.landed?.state === "nothing").length,
      gone: mine.filter((r) => !r.head).length,
    };
    // One row a branch: the newest agent that holds it.
    const rows = [...new Map(mine.filter((r) => r.head && toLand(r)).map((r) => [r.branch!, r])).values()];
    const kept = await Promise.all(rows.map((r) => this.diffOf(repo, baseTip, r.head!)));
    const forecast = this.d.baseConflicts(repo);
    const diffs: BranchDiff[] = rows.map((r, i) => ({ branch: r.branch!, mergeBase: kept[i]!.mergeBase ?? "", files: kept[i]!.parsed.files }));
    // Against the base: the forecast's word when it judged this tip, else git's merge of the tip and the base, kept.
    const againstBase = await Promise.all(rows.map(async (r) => {
      if (forecast.get(r.branch!) === r.head) return true;
      const m = await this.mergeOf(repo, baseTip, r.head!);
      return "error" in m ? null : m.conflict;
    }));
    const branches: TreeBranch[] = rows.map((r, i) => {
      const k = kept[i]!;
      const files = k.parsed.files;
      const v = r.review;
      const verdict = v ? v.verdict : null;
      const checksOk = !r.checks || r.checks.state === "none" || (r.checks.state === "known" && !r.checks.failed.length);
      return {
        agent: r.id, session_id: r.session_id, title: r.title, state: r.state, branch: r.branch!, head: r.head!, merge_base: k.mergeBase,
        verdict, review_by: v ? v.by : null, review_line: v?.line ?? "",
        checks: r.checks, ready: verdict === "approved" && v?.current !== false && checksOk,
        working: r.state === "running" || r.state === "waiting", base_conflict: againstBase[i]!,
        files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0),
        cut: k.parsed.cut, ...(k.error ? { error: k.error } : {}), queue: r.queue, pictures: r.pictures ?? null,
      };
    });
    const byBranch = new Map(branches.map((b) => [b.branch, b]));

    // Areas from every changed path of every branch.
    const area = areasOf([...new Set(diffs.flatMap((d) => d.files.map((f) => f.path)))]);
    // What each branch changes in each area, as one mark: its files and their changed lines, not where they
    // sit. A decision holds while the mark it was made on does, so a rebase that changes nothing there keeps it.
    const marks = new Map<string, Map<string, string>>();
    for (const d of diffs) {
      const parts = new Map<string, string[]>();
      for (const f of d.files) {
        const k = area.get(f.path)!;
        parts.set(k, [...(parts.get(k) ?? []), `${f.path}\0${f.status}\0${f.added}\0${f.removed}\0${f.hunks.map((h) => h.lines.join("\n")).join("\0")}`]);
      }
      for (const [k, ps] of parts) marks.set(k, (marks.get(k) ?? new Map()).set(d.branch, Bun.hash(ps.sort().join("\x01")).toString(36)));
    }
    const overlaps = overlapsOf(diffs);
    const raw = pairsOf(overlaps);
    const tipOf = (b: string) => byBranch.get(b)!.head;
    const pairs: TreePair[] = await Promise.all(raw.map(async (p) => {
      const m = await this.mergeOf(repo, tipOf(p.a), tipOf(p.b));
      const conflict = "error" in m ? null : m.conflict;
      const cf = "conflict" in m && m.conflict ? m.files : [];
      return { ...p, conflict, conflict_files: cf, note: pairNote(p.a, p.b, p.files, m) };
    }));
    const pairOf = (a: string, b: string) => pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
    const decisions = this.decisions(root, repo, marks);
    const held: Record<string, string> = {};
    const where = (k: string) => (k === "." ? "top level" : k);
    for (const b of branches) if (b.working) held[b.branch] = "its agent is still working: wait for its report";
    for (const [k, ds] of decisions) for (const d of ds) {
      if (!d.current || held[d.branch] || !byBranch.has(d.branch)) continue;
      if (d.action === "back") held[d.branch] = `you sent it back in ${where(k)} and it has not changed it there since`;
      else if (d.action === "drop") held[d.branch] = `it changes ${where(k)}, which you dropped`;
    }
    const order = landOrder(branches.filter((b) => !held[b.branch]).map((b) => ({ branch: b.branch, ready: b.ready, baseConflict: b.base_conflict === true, size: b.added + b.removed })), pairs);
    const tOverlaps: TreeOverlap[] = overlaps.map((ov) => {
      const ps = ov.branches.flatMap((a, i) => ov.branches.slice(i + 1).map((b) => pairOf(a, b)!)).filter(Boolean);
      const conflict = ps.some((p) => p.conflict && p.conflict_files.includes(ov.path)) ? true : ps.every((p) => p.conflict !== null) ? false : null;
      return { ...ov, area: area.get(ov.path)!, conflict, note: overlapNote(ov, ps, order) };
    });

    const areas = new Map<string, TreeArea>();
    for (const d of diffs) for (const f of d.files) {
      const k = area.get(f.path)!;
      const a = areas.get(k) ?? { key: k, files: [], branches: [], added: 0, removed: 0, hunks: 0, overlaps: [], order: [], decisions: [], carries: {}, marks: Object.fromEntries(marks.get(k) ?? []) };
      let af = a.files.find((x) => x.path === f.path);
      if (!af) a.files.push((af = { path: f.path, branches: [] }));
      af.branches.push({ branch: d.branch, status: f.status, added: f.added, removed: f.removed });
      if (!a.branches.includes(d.branch)) a.branches.push(d.branch);
      a.added += f.added;
      a.removed += f.removed;
      a.hunks += f.hunks.length;
      areas.set(k, a);
    }
    for (const ov of tOverlaps) areas.get(ov.area)?.overlaps.push(ov.id);
    const overlapped = new Set(tOverlaps.map((ov) => ov.path));
    const areasOfBranch = new Map<string, Set<string>>();
    for (const a of areas.values()) for (const b of a.branches) areasOfBranch.set(b, (areasOfBranch.get(b) ?? new Set()).add(a.key));
    for (const a of areas.values()) {
      a.files.sort((x, y) => fileRank(overlapped, x.path, x.branches.length) - fileRank(overlapped, y.path, y.branches.length) || x.path.localeCompare(y.path));
      a.branches.sort();
      a.order = inOrder(order, a.branches);
      a.decisions = (decisions.get(a.key) ?? []).filter((d) => a.branches.includes(d.branch));
      for (const b of a.branches) {
        const other = [...areasOfBranch.get(b)!].filter((k) => k !== a.key).sort();
        if (other.length) a.carries[b] = other;
      }
    }
    // Areas with overlaps first, then the larger ones.
    const list = [...areas.values()].sort((x, y) => Number(y.overlaps.length > 0) - Number(x.overlaps.length > 0) || (y.added + y.removed) - (x.added + x.removed) || x.key.localeCompare(y.key));
    const after = this.stats;
    return {
      ...empty, branches, areas: list, overlaps: tOverlaps, pairs, order, skipped, held,
      took_ms: Math.round(performance.now() - t0),
      stats: { diffs: after.diffs - before.diffs, kept: rows.length - (after.diffs - before.diffs), merges: after.merges - before.merges, git: after.git - before.git },
    };
  }

  // One area's hunks, each with its branch and the overlap it is part of. Read from the kept diffs.
  async area(root: string, key: string, repo?: string): Promise<AreaDetail | undefined> {
    const v = await this.view(root, { repo });
    const a = v.areas.find((x) => x.key === key);
    if (!a || !v.repo || !v.base_tip) return undefined;
    const ovOf = new Map<string, string>();
    for (const ov of v.overlaps) if (ov.area === key) for (const h of ov.hunks) ovOf.set(`${ov.path}\0${h.branch}\0${h.index}`, ov.id);
    const files: AreaDetail["files"] = [];
    for (const b of v.branches) {
      if (!a.branches.includes(b.branch)) continue;
      const k = await this.diffOf(v.repo, v.base_tip, b.head);
      for (const f of k.parsed.files) {
        if (!a.files.some((x) => x.path === f.path)) continue;
        let out = files.find((x) => x.path === f.path);
        if (!out) files.push((out = { path: f.path, hunks: [], cut: [] }));
        if (f.cut) out.cut.push(b.branch);
        f.hunks.forEach((h, index) => out!.hunks.push({ ...h, lines: h.lines.slice(0, HUNK_LINES), more: Math.max(0, h.lines.length - HUNK_LINES), branch: b.branch, index, overlap: ovOf.get(`${f.path}\0${b.branch}\0${index}`) ?? null }));
      }
    }
    // In the order the area lists them: files with overlapping hunks first, then those several branches change.
    const place = new Map(a.files.map((f, i) => [f.path, i]));
    files.sort((x, y) => (place.get(x.path) ?? 0) - (place.get(y.path) ?? 0));
    for (const f of files) f.hunks.sort((x, y) => x.old - y.old || x.branch.localeCompare(y.branch));
    return { key, files };
  }

  // ---- the owner's decisions

  private decisions(root: string, repo: string, marks: Map<string, Map<string, string>>): Map<string, Decision[]> {
    const rows = this.store.db.query<Omit<Decision, "current"> & { area: string }, [string, string]>("SELECT area, branch, head, action, note, outcome, at FROM tree_review WHERE root = ? AND repo = ? ORDER BY at").all(root, repo);
    const out = new Map<string, Decision[]>();
    for (const r of rows) {
      const { area, ...d } = r;
      out.set(area, [...(out.get(area) ?? []), { ...d, current: marks.get(area)?.get(d.branch) === d.head }]);
    }
    return out;
  }

  record(root: string, repo: string, area: string, d: { branches: { branch: string; head: string }[]; action: Decision["action"]; note: string; outcome: string }) {
    const at = Date.now();
    this.store.db.transaction(() => {
      for (const b of d.branches) this.store.db.query("INSERT INTO tree_review (root, repo, area, branch, head, action, note, outcome, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(root, repo, area, branch) DO UPDATE SET head = excluded.head, action = excluded.action, note = excluded.note, outcome = excluded.outcome, at = excluded.at")
        .run(root, repo, area, b.branch, b.head, d.action, d.note, d.outcome, at);
    })();
    this.forget(root);
  }

  undo(root: string, repo: string, area: string) {
    this.store.db.transaction(() => {
      this.store.db.query("DELETE FROM tree_review WHERE root = ? AND repo = ? AND area = ?").run(root, repo, area);
      this.store.db.query("INSERT INTO tree_review_clears (root, repo, area, at) VALUES (?, ?, ?, ?) ON CONFLICT(root, repo, area) DO UPDATE SET at = excluded.at").run(root, repo, area, Date.now());
    })();
    this.forget(root);
  }

  // When the owner last cleared the area's decisions (0: never).
  cleared(root: string, repo: string, area: string): number {
    return this.store.db.query<{ at: number }, [string, string, string]>("SELECT at FROM tree_review_clears WHERE root = ? AND repo = ? AND area = ?").get(root, repo, area)?.at ?? 0;
  }
}

// Where a file of an area is listed: with hunks of two branches that meet, then changed by several, then the rest.
const fileRank = (overlapped: Set<string>, path: string, branches: number) => (overlapped.has(path) ? 0 : branches > 1 ? 1 : 2);

// What a pair's merge says, in one line.
export function pairNote(a: string, b: string, files: string[], m: Result): string {
  const list = (f: string[]) => f.slice(0, 3).join(", ") + (f.length > 3 ? ` (+${f.length - 3})` : "");
  if ("error" in m) return `${a} and ${b} change the same lines of ${list(files)}; git could not merge them to say more (${m.error})`;
  if (!m.conflict) return `${a} and ${b} change lines next to each other in ${list(files)}, and git merges them clean`;
  return `${a} and ${b} would conflict in ${m.files.length ? list(m.files) : "a change git names no file for"} (git merge-tree)`;
}

function overlapNote(ov: Overlap, pairs: TreePair[], order: Order): string {
  const conflicting = pairs.filter((p) => p.conflict && p.conflict_files.includes(ov.path));
  const steps = new Map(order.steps.flatMap((s, i) => s.branches.map((b) => [b, i] as const)));
  const approx = ov.approx ? " (they left the base at different commits: the lines are each side's own)" : "";
  if (!conflicting.length) return `${pairs.some((p) => p.conflict === null) ? "git could not say whether these merge" : "these hunks meet, and git merges them clean"}${approx}.`;
  const first = [...ov.branches].sort((x, y) => (steps.get(x) ?? 99) - (steps.get(y) ?? 99))[0]!;
  const rest = ov.branches.filter((b) => b !== first);
  return `Would conflict when landing (git merge-tree): ${first} lands first, then ${namesLine(rest)} ${rest.length === 1 ? "is" : "are"} rebased onto it by ${rest.length === 1 ? "its agent" : "their agents"}${approx}.`;
}

// `git diff --numstat -z`: added, removed and the path a file ("-" counts for a binary).
export function numstat(out: string): { path: string; added: number; removed: number; binary: boolean }[] {
  const res: { path: string; added: number; removed: number; binary: boolean }[] = [];
  for (const rec of out.split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(rec.replace(/^\n/, ""));
    if (!m) continue;
    res.push({ path: m[3]!, added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]), binary: m[1] === "-" });
  }
  return res;
}

// The words an agent is sent when the owner sends an area back.
export function backText(o: { area: string; note: string; branch: string; head: string; files: string[]; others: string[] }): string {
  const files = o.files.slice(0, 8).join(", ") + (o.files.length > 8 ? ` (+${o.files.length - 8} more)` : "");
  return [
    `[owner review] The owner reviewed your branch ${o.branch} (at ${short(o.head)}) in the tree review and sent back its changes in ${o.area}: ${files}.`,
    o.note.trim() ? `The owner's note: ${o.note.trim()}` : "The owner left no note: read the files again against your task.",
    o.others.length ? `Other agents' branches change the same area: ${o.others.join(", ")}.` : "",
    "Work on the same branch, commit, and end your turn with a report: the owner reviews the area again on your new head.",
  ].filter(Boolean).join("\n");
}
