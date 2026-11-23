// The overlap forecast, its pure part: what `git merge-tree --write-tree`
// says of two branch tips, where in each side's file the two changes meet,
// what changed since the last check, and the words a session is told.
// The scan that runs git and keeps the rows is src/worktree/overlap-scan.ts.

// One side's change against the merge base, as `git diff -U0` heads it:
// base lines `old`..`old+oldN-1` became `new`..`new+newN-1` on that side.
export type Hunk = { old: number; oldN: number; new: number; newN: number };
// Where the two changes of a file meet, in each side's own file: [first, last]
// line (last < first: lines were only removed there, after line `last`).
export type Clash = { a: [number, number]; b: [number, number] };
export type ConflictFile = { path: string; clashes: Clash[] };
export type Result = { conflict: false } | { conflict: true; files: string[] } | { error: string };

// `git merge-tree --write-tree --name-only -z --no-messages A B`: the tree,
// then each conflicted path, then an empty field. Exit 1 is a conflict (also
// one that names no file, a directory rename), 0 is clean, anything else is
// git failing (unrelated histories, a missing object): never read as clean.
export function parseMergeTree(out: string, code: number, err = ""): Result {
  if (code === 0) return { conflict: false };
  if (code !== 1) return { error: err.trim().split("\n").at(-1) || `git merge-tree exit ${code}` };
  const fields = out.split("\0");
  const files: string[] = [];
  for (const f of fields.slice(1)) {
    if (!f) break;
    if (!files.includes(f)) files.push(f);
  }
  return { conflict: true, files };
}

// The hunk heads of a `git diff -U0` of one file.
export function parseHunks(diff: string): Hunk[] {
  const out: Hunk[] = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    out.push({ old: Number(m[1]), oldN: m[2] === undefined ? 1 : Number(m[2]), new: Number(m[3]), newN: m[4] === undefined ? 1 : Number(m[4]) });
  }
  return out;
}

// A diff of several files cut into each file's part, by its header
// (`diff --git a/P b/P`: a path-limited diff detects no rename). A path git
// would quote is not found here, and its caller diffs it alone.
export function splitDiff(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of diff.split(/^(?=diff --git )/m)) {
    const head = part.slice(0, part.indexOf("\n") >>> 0);
    const rest = head.slice("diff --git a/".length);
    if (!head.startsWith("diff --git a/") || (rest.length - 3) % 2) continue;
    const half = (rest.length - 3) / 2;
    const path = rest.slice(0, half);
    if (rest.slice(half) === ` b/${path}`) out.set(path, part);
  }
  return out;
}

// A hunk as the stretch of the base it takes, counted in the boundaries
// between lines (0 is before line 1): a change of lines L..L+n-1 is [L-1,
// L+n-1], an insertion after line L is [L, L]. Two changes meet when their
// stretches touch: git's merge conflicts on adjacent changes too.
const span = (h: Hunk): [number, number] => (h.oldN === 0 ? [h.old, h.old] : [h.old - 1, h.old - 1 + h.oldN]);
const meet = (x: [number, number], y: [number, number]) => x[0] <= y[1] && y[0] <= x[1];
const sideLines = (hs: Hunk[]): [number, number] => {
  const first = Math.min(...hs.map((h) => (h.newN === 0 ? h.new + 1 : h.new)));
  const last = Math.max(...hs.map((h) => (h.newN === 0 ? h.new : h.new + h.newN - 1)));
  return [first, last];
};

// Where the two sides' changes of one file meet: groups of hunks that touch
// each other, through either side, each with its lines on both sides.
export function clashes(a: Hunk[], b: Hunk[]): Clash[] {
  const groups: { a: Hunk[]; b: Hunk[] }[] = [];
  const used = new Set<Hunk>();
  for (const ha of a) {
    if (used.has(ha)) continue;
    const g = { a: [ha], b: [] as Hunk[] };
    used.add(ha);
    // Grow the group until no hunk of either side touches it.
    for (let grew = true; grew;) {
      grew = false;
      for (const hb of b) if (!used.has(hb) && g.a.some((x) => meet(span(x), span(hb)))) { g.b.push(hb); used.add(hb); grew = true; }
      for (const hx of a) if (!used.has(hx) && g.b.some((y) => meet(span(hx), span(y)))) { g.a.push(hx); used.add(hx); grew = true; }
    }
    if (g.b.length) groups.push(g);
  }
  return groups.map((g) => ({ a: sideLines(g.a), b: sideLines(g.b) }));
}

// "lines 10-14", "line 7", "lines removed after line 3".
export function linesSay([first, last]: [number, number]): string {
  if (last < first) return `lines removed after line ${last}`;
  return first === last ? `line ${first}` : `lines ${first}-${last}`;
}

// What a recipient is told of a pair that newly conflicts. `files` are the
// files not told before (with where they meet when git's diff could say);
// `all` how many files conflict now. `you`: how the recipient stands to each
// side, said in its words.
export type Side = { branch: string; tip: string; who: string };
export const FILES_TOLD = 12; // a note names this many files; the rest is a count (the Branches view has them all)
export function conflictNote(mine: Side, other: Side, files: ConflictFile[], all: number, base: boolean): string {
  const shown = files.slice(0, FILES_TOLD).map((f) => {
    if (!f.clashes.length) return `${f.path} (both changed it; git's line diff cannot place it: a deletion, a rename or a binary file)`;
    return `${f.path} (${f.clashes.map((c) => `${mine.who === "your branch" ? "your" : `${mine.branch}'s`} ${linesSay(c.a)} against ${base ? `${other.branch}'s` : "its"} ${linesSay(c.b)}`).join("; ")})`;
  });
  const more = files.length > shown.length ? `, and ${files.length - shown.length} more` : "";
  const noFile = !files.length ? " (a conflict git names no file for, such as a directory renamed on one side)" : "";
  const older = all > files.length && files.length ? ` ${all - files.length} more ${all - files.length === 1 ? "file was" : "files were"} told before.` : "";
  const subject = mine.who === "your branch" ? `Your branch ${mine.branch}` : `${cap(mine.who)} ${mine.branch}`;
  const against = base ? `the base ${other.branch}` : `${other.branch}, ${other.who}`;
  const tail = base ? `Rebase onto ${other.branch} before landing.` : "Agree who lands first; the second rebases onto the first.";
  return `[harness] Overlap forecast: ${subject} would conflict with ${against}, in ${shown.join(", ")}${more}${noFile}.${older} Checked with git merge-tree at ${mine.branch} ${mine.tip.slice(0, 9)} and ${other.branch} ${other.tip.slice(0, 9)}; neither branch was touched. ${tail}`;
}
export const clearedNote = (mine: Side, other: Side, base: boolean) =>
  `[harness] Overlap forecast: ${mine.who === "your branch" ? `your branch ${mine.branch}` : `${mine.who} ${mine.branch}`} no longer conflicts with ${base ? "the base " : ""}${other.branch} (checked at ${mine.tip.slice(0, 9)} and ${other.tip.slice(0, 9)}).`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// What a check changes for one recipient of a pair. `told`: the files it was
// told of; `notice`: "conflict" when files conflict that it was not told of,
// "cleared" when it was told of a conflict that is gone, else nothing (a pair
// that stays clean, or a conflict it already knows).
export function decide(told: string[] | undefined, now: Result): { notice?: "conflict" | "cleared"; fresh: string[] } {
  if ("error" in now) return { fresh: [] }; // git could not say: nothing changes
  if (!now.conflict) return { notice: told !== undefined ? "cleared" : undefined, fresh: [] };
  const fresh = now.files.filter((f) => !told?.includes(f));
  // A conflict with no file named counts once, as itself.
  if (!now.files.length) return told === undefined ? { notice: "conflict", fresh: [] } : { fresh: [] };
  return fresh.length ? { notice: "conflict", fresh } : { fresh: [] };
}

// The pairs of branches to check: every two of them, in a stable order, and
// each with the base. A pair is known by its two names in that order.
export function pairsOf(branches: string[]): [string, string][] {
  const s = [...new Set(branches)].sort();
  const out: [string, string][] = [];
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) out.push([s[i]!, s[j]!]);
  return out;
}
