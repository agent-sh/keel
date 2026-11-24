// One review for a tree, its pure part: the branches a coordinator's agents left, read as one diff. Each
// branch's diff against the base is parsed once a head (parseDiff, on the read thread), its files are put in
// areas by their paths (areasOf: a folder, or the feature a file of a shared folder names), the hunks of two
// branches that change the same lines of the base are found (overlapsOf), and an order to land them in is
// proposed from those overlaps (landOrder). The part that runs git and the queue is src/board/tree-review.ts.
// This file runs on the read thread too, so it imports nothing of the daemon.
import { headerPath } from "../safety/patch.ts";

// ---- one branch's diff

// A hunk of a branch's diff against its merge base with the base: base lines `old`..`old+oldN-1` became
// `new`..`new+newN-1`. `lines` are the hunk's lines as git wrote them (' ', '+', '-', '\'); empty when the
// branch's diff was past what is kept (`cut` on its file).
export type DiffHunk = { old: number; oldN: number; new: number; newN: number; head: string; lines: string[] };
export type FileStatus = "A" | "M" | "D" | "B";
export type DiffFile = { path: string; status: FileStatus; added: number; removed: number; hunks: DiffHunk[]; cut?: true };
export type ParsedDiff = { files: DiffFile[]; lines: number; cut: boolean };

// Lines of a branch's diff kept with their text; past it hunks keep their places and counts only.
export const KEEP_LINES = 6_000;

export function parseDiff(text: string, keep = KEEP_LINES): ParsedDiff {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let kept = 0, cut = false, inHead = false;
  for (const raw of text.split("\n")) {
    const path = headerPath(raw);
    if (path !== null) {
      cur = { path, status: "M", added: 0, removed: 0, hunks: [] };
      files.push(cur);
      hunk = null;
      inHead = true;
      continue;
    }
    if (!cur) continue;
    if (inHead) {
      if (raw.startsWith("new file")) { cur.status = "A"; continue; }
      if (raw.startsWith("deleted file")) { cur.status = "D"; continue; }
      if (raw.startsWith("Binary files")) { cur.status = "B"; continue; }
      if (!raw.startsWith("@@")) continue;
    }
    if (raw.startsWith("@@")) {
      inHead = false;
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
      if (!m) { hunk = null; continue; }
      hunk = { old: Number(m[1]), oldN: m[2] === undefined ? 1 : Number(m[2]), new: Number(m[3]), newN: m[4] === undefined ? 1 : Number(m[4]), head: raw, lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const c = raw[0];
    if (c !== "+" && c !== "-" && c !== " " && c !== "\\") continue;
    if (c === "+") cur.added++;
    else if (c === "-") cur.removed++;
    if (kept < keep) { hunk.lines.push(raw); kept++; }
    else if (!cur.cut) { cur.cut = true; cut = true; }
  }
  return { files, lines: kept, cut };
}

// ---- areas

// Folders that hold the sources of a part rather than a part: an area goes one folder further under them.
const ROOTS = new Set(["src", "lib", "app", "apps", "pkg", "packages", "internal", "cmd", "source", "sources", "crates", "modules"]);
// Folders whose files are of many features (a page's components, the routes, the tests): their files join a
// feature they name, and none of them is a feature itself.
const SHARED = new Set(["components", "component", "lib", "libs", "utils", "util", "helpers", "routes", "route", "views", "pages", "features",
  "test", "tests", "e2e", "spec", "specs", "__tests__", "docs", "doc", "scripts", "styles", "assets", "common", "shared", "types", "hooks", "api", "server", "client"]);

export const TOP = ".";
// The folder area of a path: its first two folders, one further while the last is a sources folder.
export function folderOf(path: string): string {
  const dirs = path.split("/").slice(0, -1);
  if (!dirs.length) return TOP;
  let n = Math.min(2, dirs.length);
  while (n < dirs.length && ROOTS.has(dirs[n - 1]!)) n++;
  return dirs.slice(0, n).join("/");
}

// The words of a file's name: "WorkBoard.tsx" and "work-board.spec.ts" are work, board.
export function wordsOf(name: string): string[] {
  const stem = name.replace(/\.[^.]*$/, "");
  return stem.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
const sameWord = (a: string, b: string) => a === b || a === `${b}s` || b === `${a}s`;

// Each path's area. A folder area whose last folder is not a shared one is a feature, named by that folder;
// a file of a shared folder whose name (or a folder under the shared one) holds a feature's name joins that
// feature: src/server/routes/board.ts and ui/src/components/WorkBoard.tsx join src/board.
export function areasOf(paths: readonly string[]): Map<string, string> {
  const folder = new Map(paths.map((p) => [p, folderOf(p)]));
  const features = new Map<string, string>(); // name → its area
  for (const a of [...new Set(folder.values())].sort()) {
    if (a === TOP) continue;
    const name = a.split("/").at(-1)!.toLowerCase();
    if (name.length < 3 || SHARED.has(name) || ROOTS.has(name)) continue;
    if (!features.has(name)) features.set(name, a);
  }
  const out = new Map<string, string>();
  for (const p of paths) {
    const own = folder.get(p)!;
    const name = own.split("/").at(-1)!.toLowerCase();
    if (!(own === TOP || SHARED.has(name) || ROOTS.has(name))) { out.set(p, own); continue; }
    // The file's name and the folders under its area's own (src/server/routes/board.ts: routes, board).
    const under = own === TOP ? [] : p.slice(own.length + 1).split("/").slice(0, -1).map((w) => w.toLowerCase());
    const words = [...wordsOf(p.split("/").at(-1)!), ...under];
    let best: string | undefined;
    for (const [f, area] of features) {
      if (area === own || !words.some((w) => sameWord(w, f))) continue;
      if (!best || f.length > best.length || (f.length === best.length && f < best)) best = f;
    }
    out.set(p, best ? features.get(best)! : own);
  }
  return out;
}

// ---- the hunks of two branches that meet

// A hunk as the stretch of the base it takes, counted in the boundaries between lines (0 is before line 1),
// as the overlap forecast counts them (src/worktree/overlap.ts): changes that touch meet, as git's merge says.
const span = (h: { old: number; oldN: number }): [number, number] => (h.oldN === 0 ? [h.old, h.old] : [h.old - 1, h.old - 1 + h.oldN]);
const meet = (x: [number, number], y: [number, number]) => x[0] <= y[1] && y[0] <= x[1];

export type BranchDiff = { branch: string; mergeBase: string; files: DiffFile[] };
// Hunks of two or more branches in one file that change the same lines of the base (through each other).
// `approx`: the branches left the base at different commits, so their line numbers are of different files.
export type Overlap = { id: string; path: string; hunks: { branch: string; index: number }[]; branches: string[]; approx: boolean };

export function overlapsOf(diffs: readonly BranchDiff[]): Overlap[] {
  const byPath = new Map<string, { branch: string; mb: string; index: number; s: [number, number] }[]>();
  for (const d of diffs) for (const f of d.files) {
    const l = byPath.get(f.path) ?? [];
    f.hunks.forEach((h, index) => l.push({ branch: d.branch, mb: d.mergeBase, index, s: span(h) }));
    // A file one side added or removed whole with no hunks (a binary, an empty file) meets the other at its start.
    if (!f.hunks.length) l.push({ branch: d.branch, mb: d.mergeBase, index: -1, s: [0, Number.MAX_SAFE_INTEGER] });
    byPath.set(f.path, l);
  }
  const out: Overlap[] = [];
  for (const [path, hs] of [...byPath].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (new Set(hs.map((h) => h.branch)).size < 2) continue;
    // Groups of hunks of different branches that meet, through any of them.
    const parent = hs.map((_, i) => i);
    const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)));
    for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
      if (hs[i]!.branch !== hs[j]!.branch && meet(hs[i]!.s, hs[j]!.s)) parent[root(i)] = root(j);
    }
    const groups = new Map<number, typeof hs>();
    hs.forEach((h, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), h]));
    for (const g of groups.values()) {
      const branches = [...new Set(g.map((h) => h.branch))].sort();
      if (branches.length < 2) continue;
      const hunks = g.filter((h) => h.index >= 0).map((h) => ({ branch: h.branch, index: h.index })).sort((a, b) => a.branch.localeCompare(b.branch) || a.index - b.index);
      out.push({ id: `${path}#${out.filter((o) => o.path === path).length}`, path, hunks, branches, approx: new Set(g.map((h) => h.mb)).size > 1 });
    }
  }
  return out;
}

// The branch pairs that overlap, with the files they meet in.
export function pairsOf(overlaps: readonly Overlap[]): { a: string; b: string; files: string[] }[] {
  const m = new Map<string, { a: string; b: string; files: string[] }>();
  for (const o of overlaps) for (let i = 0; i < o.branches.length; i++) for (let j = i + 1; j < o.branches.length; j++) {
    const [a, b] = [o.branches[i]!, o.branches[j]!];
    const k = `${a}\0${b}`;
    const p = m.get(k) ?? { a, b, files: [] };
    if (!p.files.includes(o.path)) p.files.push(o.path);
    m.set(k, p);
  }
  return [...m.values()];
}

// ---- the order to land in

// `ready`: approved on its head and no named check failed on it; `baseConflict`: the forecast finds it
// conflicting with the base; `size`: the lines it changes. A pair's `conflict`: what git's merge of the two
// tips said (null: not known); a pair git merges clean needs no order.
export type OrderBranch = { branch: string; ready: boolean; baseConflict: boolean; size: number };
export type OrderPair = { a: string; b: string; files: string[]; conflict: boolean | null };
export type Step = { branches: string[] };
export type Order = { steps: Step[]; why: Record<string, string> };

// Branches that meet nothing land in the first step. Of two that would conflict, the one first in this
// order lands first and the other is rebased onto it by its agent (the landing queue's rebase task): ready
// ones first, then those that do not conflict with the base, then the one that meets the most others (its
// rebase would be the most work), then the larger change, then by name. Each branch goes in the step after
// the last earlier branch it conflicts with, so a step holds no two branches that conflict.
export function landOrder(branches: readonly OrderBranch[], pairs: readonly OrderPair[]): Order {
  const edges = new Map<string, Map<string, string[]>>();
  const names = new Set(branches.map((b) => b.branch));
  for (const p of pairs) {
    if (p.conflict === false || !names.has(p.a) || !names.has(p.b)) continue;
    for (const [x, y] of [[p.a, p.b], [p.b, p.a]] as const) {
      const m = edges.get(x) ?? new Map<string, string[]>();
      m.set(y, p.files);
      edges.set(x, m);
    }
  }
  const degree = (b: string) => edges.get(b)?.size ?? 0;
  const sorted = [...branches].sort((x, y) => Number(y.ready) - Number(x.ready) || Number(x.baseConflict) - Number(y.baseConflict)
    || degree(y.branch) - degree(x.branch) || y.size - x.size || x.branch.localeCompare(y.branch));
  const stepOf = new Map<string, number>();
  const why: Record<string, string> = {};
  for (const b of sorted) {
    let step = 0, after: string | undefined;
    for (const [other] of edges.get(b.branch) ?? []) {
      const s = stepOf.get(other);
      if (s !== undefined && s + 1 > step) { step = s + 1; after = other; }
    }
    stepOf.set(b.branch, step);
    const files = after ? edges.get(b.branch)!.get(after)! : [];
    why[b.branch] = after ? `after ${after}: they change the same lines of ${files.slice(0, 2).join(", ")}${files.length > 2 ? ` (+${files.length - 2})` : ""}; it is rebased onto it`
      : b.baseConflict ? "conflicts with the base: its agent rebases it first"
      : degree(b.branch) ? `lands first of the branches it meets${b.ready ? "" : " (not approved yet)"}`
      : "meets no other branch";
  }
  const steps: Step[] = [];
  for (const b of sorted) {
    const s = stepOf.get(b.branch)!;
    while (steps.length <= s) steps.push({ branches: [] });
    steps[s]!.branches.push(b.branch);
  }
  return { steps, why };
}

// The branches of an area in the order proposed for the whole tree.
export const inOrder = (order: Order, branches: Iterable<string>): string[] => {
  const want = new Set(branches);
  return order.steps.flatMap((s) => s.branches).filter((b) => want.has(b));
};

// ---- what the review keeps

// A bounded map that forgets the entry read longest ago: a read moves its entry to the newest place, so
// what every view reads again (a pair's merge, a head's diff) stays while what no view reads goes first.
export class Keep<K, V> {
  private m = new Map<K, V>();
  constructor(readonly max: number) {}
  get size() { return this.m.size; }
  get(k: K): V | undefined {
    const v = this.m.get(k);
    if (v === undefined) return undefined;
    this.m.delete(k);
    this.m.set(k, v);
    return v;
  }
  set(k: K, v: V): V {
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
    return v;
  }
  delete(k: K) { return this.m.delete(k); }
  // Without moving it: whether the entry is still this one.
  is(k: K, v: V) { return this.m.get(k) === v; }
  keys() { return this.m.keys(); }
}

// A list of names in one line: the first `max`, then how many more.
export function namesLine(names: readonly string[], max = 5): string {
  return names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} (+${names.length - max} more)`;
}
