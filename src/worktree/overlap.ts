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

// What a session is told, as one note a request: each branch once, the
// files where it meets each other branch (never the lines: the Branches view
// has them), within NOTE_CHARS. A coordinator holding many agents' branches
// gets one short note, not a note a pair: pairs past the budget are a count.
// `who`: how the recipient stands to a side, in its words.
// `edits`: the conflict is of this side's edits that are not committed yet.
export type Side = { branch: string; tip: string; who: string; edits?: true };
// `held`: for a conflict with the base, how many conflicts of the branch with other branches wait until it is rebased.
export type Told = { mine: Side; other: Side; files: string[]; all: number; base: boolean; held?: number };
export type Gone = { mine: Side; other: Side; base: boolean };
export const FILES_TOLD = 4; // files named a pair; the rest is a count
// The budget of a session's failure notice (src/automation/failures.ts), for the same reason:
// what the harness adds to a request is read by the model at every later step.
export const NOTE_CHARS = 2_500;
// Other branches named on one branch's line, so a coordinator's note reaches its other branches too.
export const PER_BRANCH = 4;
const side = (s: Side) => (s.who === "your branch" ? `your branch ${s.branch}${s.edits ? " (its edits not committed yet)" : ""}` : `${s.branch} (${s.who}${s.edits ? ", its edits not committed yet" : ""})`);
const lead = (s: Side) => (s.who === "your branch" ? `Your branch ${s.branch}${s.edits ? " (its edits not committed yet)" : ""}` : side(s));
const against = (t: { other: Side; base: boolean }) => (t.base ? `the base ${t.other.branch}` : side(t.other));
function filesSay(t: Told): string {
  const shown = t.files.slice(0, FILES_TOLD);
  const more = t.files.length - shown.length;
  const before = t.all - t.files.length;
  const extra = [more > 0 ? `${more} more` : "", before > 0 && t.files.length ? `${before} told before` : ""].filter(Boolean).join(", ");
  const names = shown.length ? shown.join(", ") : "a conflict git names no file for (a directory renamed on one side)";
  return extra ? `${names} (+${extra})` : names;
}
export function forecastNote(conflicts: Told[], gone: Gone[]): string {
  const head = "[harness] Overlap forecast (git merge-tree; no branch was touched).";
  const tail = conflicts.length ? "Agree who lands first; the second rebases onto the first. A branch that conflicts with the base rebases onto it before landing." : "";
  const groups = new Map<string, { mine: Side; parts: string[] }>();
  for (const t of [...conflicts].sort((a, b) => Number(b.base) - Number(a.base))) {
    const g = groups.get(t.mine.branch) ?? { mine: t.mine, parts: [] };
    g.parts.push(`with ${against(t)}: ${filesSay(t)}${t.held ? ` (rebase onto it first: ${t.held === 1 ? "its conflict with another branch waits" : `its conflicts with ${t.held} other branches wait`} until then)` : ""}`);
    groups.set(t.mine.branch, g);
  }
  const lines: string[] = [];
  let used = head.length + tail.length + 120, left = 0;
  const add = (line: string, pairs: number) => {
    if (used + line.length + 1 > NOTE_CHARS) { left += pairs; return; }
    lines.push(line);
    used += line.length + 1;
  };
  for (const g of groups.values()) {
    const line = `- ${lead(g.mine)} would conflict ${g.parts.join("; ")}.`;
    if (g.parts.length <= PER_BRANCH && used + line.length + 1 <= NOTE_CHARS) { add(line, g.parts.length); continue; }
    // A branch with many pairs: a few, as many as fit, the rest counted (every branch gets its line first).
    // (Room is kept for the count that ends the line.)
    let part = `- ${lead(g.mine)} would conflict`, n = 0;
    for (const p of g.parts) { if (n === PER_BRANCH || used + part.length + p.length + 32 > NOTE_CHARS) break; part += `${n ? ";" : ""} ${p}`; n++; }
    const cut = part + ` (and ${g.parts.length - n} more).`;
    if (n && used + cut.length + 1 <= NOTE_CHARS) add(cut, 0); else left += g.parts.length;
  }
  if (gone.length) add(`- No longer conflicting: ${gone.map((c) => `${c.mine.branch} with ${c.base ? "the base " : ""}${c.other.branch}`).join("; ")}.`, gone.length);
  if (left) lines.push(`${left} more ${left === 1 ? "pair is" : "pairs are"} not listed here; check one with git merge-tree --write-tree --name-only A B (the owner's Branches view lists them all).`);
  return [head, ...lines, tail].filter(Boolean).join("\n");
}
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

// Which conflicts between two branches wait. A branch that conflicts with the
// base is told once to rebase onto it; until it does, its conflicts with
// other branches are not told to anyone: a rebase may remove them or change
// their files, and most pair conflicts in a busy repository come from such a
// branch. A pair waits while either side conflicts with the base; once that
// conflict is gone the pair is told as it is then (still real or gone).
export type PairState = { a: string; b: string; base: boolean; conflict: boolean };
export const pairKey = (a: string, b: string) => `${a}\0${b}`;
export function waiting(pairs: readonly PairState[]): Set<string> {
  const stale = new Set(pairs.filter((p) => p.base && p.conflict).map((p) => p.a));
  return new Set(pairs.filter((p) => !p.base && p.conflict && (stale.has(p.a) || stale.has(p.b))).map((p) => pairKey(p.a, p.b)));
}

// The pairs of branches to check: every two of them, in a stable order, and
// each with the base. A pair is known by its two names in that order.
export function pairsOf(branches: string[]): [string, string][] {
  const s = [...new Set(branches)].sort();
  const out: [string, string][] = [];
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) out.push([s[i]!, s[j]!]);
  return out;
}
