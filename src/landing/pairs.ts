// Branches checked together, the pure part: which pairs of live branches touch related code, what a
// pair runs, the key its result is kept by, and the verdict and words of a result. The part that runs
// git and the checks is src/landing/together.ts.
//
// Two branches are related when they change the same file, when a file one changes imports a file the
// other changes, or when a test reaches both: a test one of them changed, or a test that imports (in up
// to REACH steps) a file each of them changed. Imports are read from the files' own import lines
// (relative imports of JavaScript and TypeScript, Python's modules, a Go package's folder); a repository
// whose files say none of that is related by shared files only.
//
// A hub file (hubsOf: one much of the repository's work touches, or one many of its files import)
// relates a pair only where both change lines of it near each other (nearHunks): two branches that each
// edit the turn loop somewhere are the common case, not a sign the two break each other, and checking
// every such pair costs a run on nearly every pair. An import of a hub relates nothing, and a walk from
// a test stops at a hub.
import { dirname, join, normalize } from "node:path";
import type { Check } from "../checks/named.ts";

// One live branch: its tip and the files it changed since it left the base (deleted ones too), and of
// the hub files among them the line ranges it changed there (the base's numbering, from and to).
export type Side = { branch: string; tip: string; files: string[]; hunks?: ReadonlyMap<string, readonly (readonly [number, number])[]> };
export type Why = "file" | "import" | "test";
export type Related = { a: string; b: string; why: Why; detail: string; tests: string[] };
// A file and the files of the tree it imports.
export type Graph = Map<string, Set<string>>;

// A test reaches what it imports, and what those import: a module's direct collaborators (the
// accounts-and-provenance shape: a test of the provenance stamp, the stamp, the accounts rule it reads).
// A third step relates 59% of this repository's live pairs instead of 49% (below), most of them
// through a module's collaborators' collaborators.
export const REACH = 2;

const JS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const jsLike = (p: string) => JS.some((e) => p.endsWith(e));
const DEFAULT_TEST = /(^|\/)(test_[^/]+\.py|[^/]+_test\.(go|py)|[^/]+\.(test|spec)\.[cm]?[jt]sx?)$/;

// The pattern `git grep -E` is given to find the lines that import (the parse below reads them).
export const IMPORT_LINES = `(from|import|require)[[:space:]]*\\(?[[:space:]]*["'][^"']+["']|^[[:space:]]*(from[[:space:]]+[.A-Za-z_][.A-Za-z0-9_]*[[:space:]]+import|import[[:space:]]+[A-Za-z_][.A-Za-z0-9_]*)`;
// The files whose import lines are read.
export const IMPORT_PATHS = [...JS.map((e) => `*${e}`), "*.py"];

// What one import line of `path` names, as the candidate files of the tree it may be.
export function candidatesOf(path: string, line: string): string[][] {
  const out: string[][] = [];
  if (jsLike(path)) {
    for (const m of line.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1]!;
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      const at = normalize(join(dirname(path), spec));
      if (at.startsWith("..")) continue;
      const bare = at.replace(/\.[cm]?jsx?$/, "");
      out.push([at, ...JS.map((e) => bare + e), ...JS.map((e) => `${at}/index${e}`)]);
    }
    return out;
  }
  if (path.endsWith(".py")) {
    const m = /^\s*from\s+(\.*)([A-Za-z_][\w.]*)?\s+import\s+([\w\s,*()]+)|^\s*import\s+([A-Za-z_][\w.]*)/.exec(line);
    if (!m) return out;
    const mod = (name: string, from: string) => { const p = name.replace(/\./g, "/"); const at = from ? normalize(join(from, p)) : p; return [`${at}.py`, `${at}/__init__.py`, ...(from ? [] : [`src/${p}.py`, `src/${p}/__init__.py`])]; };
    if (m[4]) { out.push(mod(m[4], "")); return out; }
    const dots = m[1]!.length, name = m[2] ?? "";
    let from = "";
    if (dots) { from = dirname(path); for (let i = 1; i < dots; i++) from = dirname(from); if (from === ".") from = ""; }
    if (name) out.push(mod(name, from));
    // `from . import a, b` (and `from pkg import mod`): each name may be a module of its own.
    for (const n of (m[3] ?? "").replace(/[()]/g, "").split(",").map((x) => x.trim().split(/\s+/)[0]!).filter((x) => /^[A-Za-z_]\w*$/.test(x))) out.push(mod(name ? `${name}.${n}` : n, from));
    return out;
  }
  return out;
}

// The import graph of a tree from its import lines, each import resolved to the first candidate the
// tree holds. A Go file imports the other Go files of its folder (they are one package).
export function graphOf(lines: readonly { path: string; line: string }[], known: ReadonlySet<string>): Graph {
  const g: Graph = new Map();
  const add = (a: string, b: string) => { if (a === b) return; let s = g.get(a); if (!s) g.set(a, (s = new Set())); s.add(b); };
  for (const { path, line } of lines) for (const c of candidatesOf(path, line)) { const hit = c.find((x) => known.has(x)); if (hit) add(path, hit); }
  const goDirs = new Map<string, string[]>();
  for (const p of known) if (p.endsWith(".go")) goDirs.set(dirname(p), [...(goDirs.get(dirname(p)) ?? []), p]);
  for (const files of goDirs.values()) if (files.length <= 200) for (const a of files) for (const b of files) add(a, b);
  return g;
}

const NO_HUBS: ReadonlySet<string> = new Set();

// The files `from` reaches in up to `steps` imports, each with the steps it took. A hub is not reached
// and not walked through.
export function reach(g: Graph, from: string, steps = REACH, hubs: ReadonlySet<string> = NO_HUBS): Map<string, number> {
  const seen = new Map<string, number>([[from, 0]]);
  let edge = [from];
  for (let i = 0; i < steps && edge.length; i++) {
    const next: string[] = [];
    for (const f of edge) for (const t of g.get(f) ?? []) if (!seen.has(t) && !hubs.has(t)) { seen.set(t, i + 1); next.push(t); }
    edge = next;
  }
  return seen;
}

// ---- hubs
// How the base's recent work is read: its last HUB_COMMITS first-parent commits; with fewer than
// HUB_MIN_COMMITS no file is a hub by the work (a young repository says nothing yet).
export const HUB_COMMITS = 200;
export const HUB_MIN_COMMITS = 50;
// A file is a hub when HUB_SHARE of those commits touch it, or when HUB_SHARE of the tree's files that
// import anything import it (and at least HUB_MIN_IMPORTERS do). On this repository (measured
// 2026-11-24: 200 commits, 1,838 files, 1,418 with imports) 3% names 36 files by the work (the agents
// module, the turn loop, the approval card, the gate, the main stylesheet, AGENTS.md...) and 21 by
// imports (the core types, the store, the bus, the e2e helpers...), 55 in all. Over 8 windows of up to
// 12 of its recent agent branches, a pair was related 92% of the time with no hubs, 74% with hubs at
// 5% and 49% at 3%; at 2% (114 hubs) 33%, but the hubs then take in modules only a few areas share.
export const HUB_SHARE = 0.03;
export const HUB_MIN_IMPORTERS = 20;
export function hubsOf(o: { touched: ReadonlyMap<string, number>; commits: number; g: Graph }, share = HUB_SHARE): Set<string> {
  const hubs = new Set<string>();
  if (o.commits >= HUB_MIN_COMMITS) for (const [f, n] of o.touched) if (n / o.commits >= share) hubs.add(f);
  const importers = new Map<string, number>();
  for (const ts of o.g.values()) for (const t of ts) importers.set(t, (importers.get(t) ?? 0) + 1);
  const floor = Math.max(HUB_MIN_IMPORTERS, share * o.g.size);
  for (const [f, n] of importers) if (n >= floor) hubs.add(f);
  return hubs;
}

// A test file: one the repository's unit check names by its `tests` globs, else by the usual names.
export function testMatcher(globs?: readonly string[]): (path: string) => boolean {
  if (!globs?.length) return (p) => DEFAULT_TEST.test(p);
  const gs = globs.map((x) => new Bun.Glob(x));
  return (p) => gs.some((x) => x.match(p));
}

// The pairs of branches that touch related code, most likely to meet first: a shared file, then an
// import between their files, then a test that reaches both; none of it through a hub alone. `tests` of
// a pair: the tests that reach both, nearest first (a test either side changed, then by the steps to the
// farther side).
export function relatedPairs(sides: readonly Side[], g: Graph, tests: readonly string[], isTest: (p: string) => boolean, hubs: ReadonlySet<string> = NO_HUBS, steps = REACH): Related[] {
  const files = sides.map((s) => new Set(s.files));
  // Each test, the steps it takes to each side it reaches: 0 when that side changed it.
  const testSides = new Map<string, Map<number, number>>();
  const all = new Set([...tests, ...sides.flatMap((s) => s.files.filter(isTest))]);
  for (const t of all) {
    const r = reach(g, t, steps, hubs);
    const of = new Map<number, number>();
    sides.forEach((_, i) => {
      if (files[i]!.has(t)) { of.set(i, 0); return; }
      let best = Infinity;
      for (const f of files[i]!) { const d = r.get(f); if (d !== undefined && d < best) best = d; }
      if (best < Infinity) of.set(i, best);
    });
    if (of.size > 1) testSides.set(t, of);
  }
  const out: Related[] = [];
  for (let i = 0; i < sides.length; i++) for (let j = i + 1; j < sides.length; j++) {
    const A = sides[i]!, B = sides[j]!, fa = files[i]!, fb = files[j]!;
    const both = [...testSides].filter(([, of]) => of.has(i) && of.has(j)).map(([t, of]) => ({ t, own: Math.min(of.get(i)!, of.get(j)!) === 0 ? 0 : 1, far: Math.max(of.get(i)!, of.get(j)!) }))
      .sort((x, y) => x.own - y.own || x.far - y.far || (x.t < y.t ? -1 : 1)).map((x) => x.t);
    let shared = A.files.find((f) => fb.has(f) && !hubs.has(f));
    if (!shared) for (const f of A.files) { if (!fb.has(f)) continue; const at = nearHunks(A.hunks?.get(f), B.hunks?.get(f)); if (at) { shared = `${f} (both near line ${at})`; break; } }
    const [a, b] = A.branch < B.branch ? [A.branch, B.branch] : [B.branch, A.branch];
    if (shared) { out.push({ a, b, why: "file", detail: shared, tests: both }); continue; }
    let imp: string | undefined;
    const edge = (x: Set<string>, y: Set<string>) => { for (const f of x) { if (hubs.has(f)) continue; for (const t of g.get(f) ?? []) if (y.has(t) && !hubs.has(t)) return `${f} imports ${t}`; } return undefined; };
    imp = edge(fa, fb) ?? edge(fb, fa);
    if (imp) { out.push({ a, b, why: "import", detail: imp, tests: both }); continue; }
    if (both.length) out.push({ a, b, why: "test", detail: `${both[0]} reaches both`, tests: both });
  }
  const rank: Record<Why, number> = { file: 0, import: 1, test: 2 };
  return out.sort((x, y) => rank[x.why] - rank[y.why]);
}

// Two sides meet in a hub file when they change lines of it within HUNK_NEAR of each other: the same
// function or table, not two ends of a long file. The first such line, or undefined.
export const HUNK_NEAR = 30;
export function nearHunks(a?: readonly (readonly [number, number])[], b?: readonly (readonly [number, number])[], near = HUNK_NEAR): number | undefined {
  if (!a || !b) return undefined;
  for (const [s1, e1] of a) for (const [s2, e2] of b) if (s1 <= e2 + near && s2 <= e1 + near) return Math.max(s1, s2);
  return undefined;
}

// The changed ranges of `git diff -U0` output, a file each, in the old side's numbering.
export function hunksOf(diff: string): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  let file: string | undefined, old: string | undefined;
  for (const l of diff.split("\n")) {
    if (l.startsWith("--- ")) { const p = l.slice(4); old = p === "/dev/null" ? undefined : p.replace(/^a\//, ""); file = undefined; continue; }
    if (l.startsWith("+++ ")) { const p = l.slice(4); file = p === "/dev/null" ? old : p.replace(/^b\//, ""); continue; }
    const m = /^@@ -(\d+)(?:,(\d+))? \+/.exec(l);
    if (m && file) { const s = Number(m[1]), n = m[2] === undefined ? 1 : Number(m[2]); (out.get(file) ?? out.set(file, []).get(file)!).push([s, s + Math.max(n, 1) - 1]); }
  }
  return out;
}

// ---- what a pair runs

// The fast checks a pair runs, from the repository's named checks: those `pairs.checks` names, else
// every check of the work tree in one folder that is answered from the ledger (cache) and takes no words
// (a typecheck, a lint) or names its test files (a unit suite, given the tests of the pair). `false`
// turns the pair checks off for the repository.
export type Pairs = { checks: Check[] } | { off: string } | { problem: string };
export function fastChecks(named: readonly Check[], setting: unknown): Pairs {
  if (setting === false) return { off: "the repository turns pair checks off (pairs: false)" };
  const ok = (c: Check) => c.tree.kind === "work" && c.dir !== "*";
  if (setting !== undefined && setting !== null) {
    const list = (setting as { checks?: unknown }).checks;
    if (typeof setting !== "object" || !Array.isArray(list) || !list.every((x) => typeof x === "string")) return { problem: 'pairs is { "checks": [names] } or false' };
    const out: Check[] = [];
    for (const n of list as string[]) {
      const c = named.find((x) => x.name === n);
      if (!c) return { problem: `pairs.checks names ${n}, which .keel/checks.json does not name` };
      if (!ok(c)) return { problem: `${n} does not check the work tree of one folder` };
      out.push(c);
    }
    return out.length ? { checks: out } : { off: "pairs.checks is empty" };
  }
  const out = named.filter((c) => ok(c) && c.cache && (!c.args || !!c.tests));
  return out.length ? { checks: out } : { off: "the repository names no fast check (one that takes no words, or names its tests)" };
}

// The tests a pair's unit check runs: the tests that reach both sides (nearest first, as relatedPairs
// orders them) that the merged tree holds, at most PAIR_TESTS. A test that reaches one side only is that
// side's own check, not the pair's.
//
// PAIR_TESTS: on this repository a test file of the unit suite costs 0.16 processor seconds and 2.2
// seconds of wall time on average (0.05 and 0.3 in the median; measured 2026-11-24 on 30 of its 369
// files, one `bun test FILE` each, the slowest 35 seconds of wall time). Twelve keep the unit part of a
// pair near 2 processor seconds and half a minute, under the typecheck it runs beside (9 processor
// seconds), and the nearest twelve are the ones most likely to see the two sides meet.
export const PAIR_TESTS = 12;
export function pairTests(related: Pick<Related, "tests">, tree: ReadonlySet<string>, cap = PAIR_TESTS): string[] {
  return related.tests.filter((t) => tree.has(t)).slice(0, cap);
}

// A check as a pair runs it: its command, with the pair's tests when it names its tests; none when
// it names them and the pair has none.
export function commandOf(c: Check, tests: readonly string[], home: string): string | undefined {
  const words = c.run.split(" ").map((r) => (r === "~" || r.startsWith("~/") ? home + r.slice(1) : r.replace(/^\$HOME(?=\/|$)/, home)));
  if (!c.tests) return words.join(" ");
  if (!tests.length) return undefined;
  const q = (p: string) => (/^[\w./@+-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);
  return [...words, ...tests.map((t) => q(c.dir === "." ? t : t.startsWith(`${c.dir}/`) ? t.slice(c.dir.length + 1) : t))].join(" ");
}

// ---- the result

// What a pair's result is kept by: the repository and its two heads, in order. No other fact moves it:
// a pair is checked again only when one of its heads moves.
export function pairKey(repo: string, tipX: string, tipY: string): { repo: string; tip1: string; tip2: string } {
  return tipX <= tipY ? { repo, tip1: tipX, tip2: tipY } : { repo, tip1: tipY, tip2: tipX };
}

// Whether a pair is due: both heads stayed where they are for `quietMs`. A commit soon followed by
// another (a fix-up, a rebase) is a burst; checking it costs a run whose answer is old before it ends.
export const due = (seenA: number, seenB: number, now: number, quietMs: number) => now - Math.max(seenA, seenB) >= quietMs;

// One check's run: its exit (null: stopped) and the tests it named as failing.
export type Res = { check: string; exit: number | null; names: string[] };
// green: every check passed together. red: a check fails together and passes on each side alone (or
// fails together on tests that fail on neither side), twice. flaky: it failed together once and passed
// the second time. own: what fails together fails on a side alone too: that branch's own red. broken:
// every check that fails together fails on both sides alone: the base or the setup is red here, not
// either branch (a setup that links what is not there makes every typecheck fail).
export type Verdict =
  | { state: "green" }
  | { state: "red"; checks: { name: string; tests: string[] }[] }
  | { state: "flaky"; checks: { name: string; tests: string[] }[] }
  | { state: "own"; checks: { name: string; branch: "a" | "b" | "both" }[] }
  | { state: "broken"; checks: { name: string; branch: "both" }[] };

export const failing = (rs: readonly Res[]) => rs.filter((r) => r.exit !== 0);

// The checks that break only together: each failing check of `together` that `a` and `b` (the sides
// alone, on the same base) pass, or that fails together on tests neither side fails alone.
export function breaks(together: readonly Res[], a: readonly Res[], b: readonly Res[]): { broke: { name: string; tests: string[] }[]; own: { name: string; branch: "a" | "b" | "both" }[] } {
  const broke: { name: string; tests: string[] }[] = [], own: { name: string; branch: "a" | "b" | "both" }[] = [];
  for (const t of failing(together)) {
    const ra = a.find((x) => x.check === t.check), rb = b.find((x) => x.check === t.check);
    const aRed = !ra || ra.exit !== 0, bRed = !rb || rb.exit !== 0;
    if (!aRed && !bRed) { broke.push({ name: t.check, tests: t.names }); continue; }
    const alone = new Set([...(aRed ? ra?.names ?? [] : []), ...(bRed ? rb?.names ?? [] : [])]);
    const fresh = t.names.filter((n) => !alone.has(n));
    // (A side red alone with names it cannot say: what fails together is not known to be new.)
    if (fresh.length && ((!aRed || ra?.names.length) && (!bRed || rb?.names.length))) broke.push({ name: t.check, tests: fresh });
    else own.push({ name: t.check, branch: aRed && bRed ? "both" : aRed ? "a" : "b" });
  }
  return { broke, own };
}

// The verdict from the runs: together, the sides alone (only when together failed), and together again
// (only the checks that broke).
export function verdictOf(together: readonly Res[], apart?: { a: readonly Res[]; b: readonly Res[] }, again?: readonly Res[]): Verdict {
  if (!failing(together).length) return { state: "green" };
  if (!apart) return { state: "own", checks: [] };
  const { broke, own } = breaks(together, apart.a, apart.b);
  if (!broke.length) return own.length && own.every((o) => o.branch === "both") ? { state: "broken", checks: own as { name: string; branch: "both" }[] } : { state: "own", checks: own };
  if (!again) return { state: "red", checks: broke };
  const still = broke.filter((c) => again.some((r) => r.check === c.name && r.exit !== 0));
  return still.length ? { state: "red", checks: still } : { state: "flaky", checks: broke };
}

const short = (s: string) => s.slice(0, 9);
const list = (xs: readonly string[], n = 6) => (xs.length > n ? `${xs.slice(0, n).join(", ")} and ${xs.length - n} more` : xs.join(", "));

// What a red pair says, the same words to each side's parent (one cause, both agents named under it):
// what fails first, then the two heads and the base, short enough to be told whole.
export function redText(p: { a: { branch: string; tip: string }; b: { branch: string; tip: string }; base: string; baseTip: string; checks: { name: string; tests: string[] }[] }): string {
  const fails = p.checks.map((c) => `${c.name}${c.tests.length ? ` (${list(c.tests, 3)})` : ""}`).join("; ");
  return `${fails} fails with ${p.a.branch}@${short(p.a.tip)} + ${p.b.branch}@${short(p.b.tip)} on ${p.base}@${short(p.baseTip)}, twice; each passes alone.`;
}

// What a broken pair says to the owner, once until the repository's pairs pass again.
export function brokenText(p: { repo: string; base: string; baseTip: string; checks: string[]; setup?: string; why?: string }): string {
  const what = p.why ?? `${list(p.checks)} fail${p.checks.length === 1 ? "s" : ""} on each branch alone`;
  return `Pair checks of ${p.repo} on ${p.base}@${short(p.baseTip)}: ${what}, so the base or the setup is red where the pairs run${p.setup ? ` (land.setup: ${p.setup.slice(0, 160)})` : ""}. No pair of this repository is checked again until its base or its checks change.`;
}
