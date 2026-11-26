// Checks beside the agent: after an agent's step changes its files, Keel runs
// the repository's fast checks (those named with `beside`, src/checks/named.ts)
// on a copy of the files by itself, and a red result reaches the agent at its
// next step as one harness input. A green one says nothing. The run is kept in
// the check ledger by the tree it ran on, so the agent's own run of the same
// check on the same files is answered from it. This is the part a test can
// reach: when a run is due, which test files a change touches, what a failure
// says and when it is told. Pure: the runner is src/checks/beside-run.ts.
//
// The cost is bounded per agent: one run at a time, the steps of a window
// (WINDOW_MS from the first change that waits) taken together, at most
// `per_hour` runs an hour (a run starts no sooner than an hour over that after
// the one before: the changes of the gap are one run), a run only for a tree
// that is not the one checked last, no test file run again that passed on an
// earlier tree when nothing it reaches changed since, and a failure told once
// (the same failure on a later tree is not told again).
import { createHash } from "node:crypto";
import { dirname, posix, relative } from "node:path";
import { quote } from "./before.ts";
import type { Check } from "./named.ts";

// The steps of one window are one run: an agent's steps come seconds apart, and
// an edit is often followed by more edits before the change is whole.
export const WINDOW_MS = 30_000;

// Where an agent stands. `first`: when the oldest change no run has covered was
// made (null: none waits). `ended`: its turn ended since, so no step follows that
// would add to the change (it runs as soon as it may). `over`: its turn ended and
// no step came since (its copy of the files can go once nothing runs or waits).
// `running`: a run of it is going. `tree`: the tree its last run checked. `told`:
// the failure it was told last (a fingerprint), cleared by a green run. `carry`:
// the test files of the last red run, run again with the next selection until
// they pass (a later step's change may not touch them). `owed`: a red not told
// yet, kept while the agent waits on a wait of its own (see toWhom). `said`: the setup failures said last
// (what the copy lacked, never the agent's red: a fingerprint of them), cleared by a run with none.
// `ranAt`: when its last run started (the gap of `per_hour` counts from it). `green`: by check, the test files
// that passed on `tree` or on an earlier tree with nothing they reach changed since, and the check's inputs then.
export type Owed = { text: string; key: string; cls: string; message: string };
export type Green = { inputs: string | null; files: string[] };
export type Lane = { first: number | null; ended: boolean; over: boolean; running: boolean; tree: string | null; told: string | null; carry: string[]; owed: Owed | null; said: string | null; ranAt: number | null; green: Record<string, Green> };
export const fresh = (): Lane => ({ first: null, ended: false, over: false, running: false, tree: null, told: null, carry: [], owed: null, said: null, ranAt: null, green: {} });

// How many runs an agent gets an hour by default (the setting checks.beside.per_hour): one each ten minutes.
// The agent's own run of a check is the check; a run beside it is the net under it, and a busy agent changes its
// files many times a step's length apart, each change a whole typecheck. On a replay of six hours of this
// repository's agents (scripts/bench/beside-replay.ts) the cap with the standing of passed tests took the runs'
// processor time to 41% of what it was, a red told four minutes after its change on average instead of one; at 12
// an hour, 53% and two minutes. The turn's end still runs at once.
export const PER_HOUR = 6;
// The least time between two runs of one agent for `perHour` runs an hour (0: no cap).
export const gapOf = (perHour: number) => (perHour > 0 ? Math.round(3_600_000 / perHour) : 0);

// A step changed files (or may have: a shell call).
export const changed = (l: Lane, now: number): Lane => ({ ...l, first: l.first ?? now, over: false });
// Its turn ended: what waits runs now, with no more of the window.
export const turnEnded = (l: Lane): Lane => ({ ...l, over: true, ended: l.first !== null });
// When a run is due: never while one runs, else at the end of the window and no sooner than `gapMs` after the
// last run started (or now, after the turn's end: the files as the agent left them are what its report stands on).
export function dueAt(l: Lane, windowMs = WINDOW_MS, gapMs = 0): number | null {
  if (l.first === null || l.running) return null;
  if (l.ended) return l.first;
  return gapMs > 0 && l.ranAt !== null ? Math.max(l.first + windowMs, l.ranAt + gapMs) : l.first + windowMs;
}
export const started = (l: Lane, now = Date.now()): Lane => ({ ...l, first: null, ended: false, running: true, ranAt: now });
// A run ended (or found nothing to do): the tree it checked, the failure it told and the setup failures it said
// (undefined: as they were).
export const finished = (l: Lane, tree: string | null, told?: string | null, said?: string | null): Lane => ({ ...l, running: false, tree: tree ?? l.tree, ...(told !== undefined ? { told } : {}), ...(said !== undefined ? { said } : {}) });
// The copy of the files can go: the agent's turn ended, and no run goes or waits (the next change makes it again).
export const sweepable = (l: Lane) => l.over && !l.running && l.first === null;

// Who is told a red result, by where the agent stands when it is known. A
// working agent reads it at its next step (a message of the harness's to its
// running turn). One that waits on a wait of its own is told when it works
// again: a message now would start a turn for it. A finished agent is never
// given new work by it: the session that started it is told in its failures
// notice, which goes with its next input and starts no turn (the agent's
// report has the run in its proof line when it ended after the run). Nobody
// is told of an agent the owner stopped, or one below an owner's stop.
export type AgentState = "working" | "parked" | "ended" | "held";
export const toWhom = (state: AgentState | undefined): "agent" | "later" | "parent" | "none" =>
  state === "working" ? "agent" : state === "parked" ? "later" : state === "ended" ? "parent" : "none";

// --- the checks a change touches

// The checks of a repository Keel runs beside its agents.
export const besideOf = (checks: readonly Check[]): Check[] => checks.filter((c) => c.beside);

// What a test file imports by a relative path: each specifier of `from "x"`,
// `import "x"`, `import("x")`, `require("x")` and `export ... from "x"` that
// starts with ".", resolved from the test's folder (paths from the top).
const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"'\n]*)["']/g;
export function importsOf(text: string, from: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(SPEC)) out.add(posix.normalize(posix.join(posix.dirname(from), m[1]!)));
  return [...out];
}
// A file is what an import names: the same path, or the path with one of the
// extensions a resolver adds, or its folder's index.
const EXT = /\.(?:[cm]?[jt]sx?)$/;
export function names(spec: string, file: string): boolean {
  if (spec === file) return true;
  const bare = (p: string) => p.replace(EXT, "");
  return bare(spec) === bare(file) || bare(file) === `${spec}/index`;
}

// The folders a test reads the source tree under: a test that walks folders
// (readdirSync, a Glob's scan) from its own place (`import.meta.dir`,
// `__dirname`) reads every file below what it joins to it, and below its own
// folder (a convention test that reads every source file imports none of them).
// Paths from the top; none for a test that walks nothing of the tree. A folder
// listing counts only when it lists a place of the tree: what a helper is given
// (a bare name), or a path made from the test's own place. A test that lists a
// scratch folder of its own, and merely knows where it sits, reads no tree: it
// would be picked for every change, and a run that takes it takes the time of
// what it builds.
const SCANS = /\bnew\s+(?:Bun\.)?Glob\s*\(/;
const LISTS = /\breaddir(?:Sync)?\s*\(/g;
const HERE = /\b(?:import\.meta\.dir(?:name)?|__dirname)\b/;
const JOINED = /\b(?:join|resolve)\(\s*(?:import\.meta\.dir(?:name)?|__dirname)((?:\s*,\s*["'][^"'\n]*["'])+)\s*\)/g;
const BOUND = /\b(?:const|let|var)\s+(\w+)\s*(?::[^=\n]+)?=\s*([^;\n]*)/g;
// The names a test makes from its own place (ROOT = join(import.meta.dir, ".."), then SRC = join(ROOT, "src")).
function placeNames(text: string): Set<string> {
  const names = new Set<string>();
  const bound = [...text.matchAll(BOUND)].map((m) => [m[1]!, m[2]!] as const);
  for (let more = true; more;) {
    more = false;
    for (const [n, expr] of bound) {
      if (names.has(n)) continue;
      if (HERE.test(expr) || [...names].some((p) => new RegExp(`\\b${p}\\b`).test(expr))) { names.add(n); more = true; }
    }
  }
  return names;
}
// The text between the parenthesis that opens at `at` and its mate.
function argsAt(text: string, at: number): string {
  let depth = 1;
  for (let i = at; i < text.length && i < at + 400; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(at, i);
  }
  return text.slice(at, at + 400);
}
function walksTree(text: string): boolean {
  if (SCANS.test(text)) return true;
  const names = placeNames(text);
  for (const m of text.matchAll(LISTS)) {
    const arg = argsAt(text, m.index! + m[0].length).trim();
    if (/^\w+$/.test(arg) || HERE.test(arg) || [...names].some((n) => new RegExp(`\\b${n}\\b`).test(arg))) return true;
  }
  return false;
}
export function treeReadsOf(text: string, from: string): string[] {
  if (!HERE.test(text) || !walksTree(text)) return [];
  const here = posix.dirname(from);
  const out = new Set([here]);
  for (const m of text.matchAll(JOINED)) {
    const parts = [...m[1]!.matchAll(/["']([^"'\n]*)["']/g)].map((x) => x[1]!);
    out.add(posix.normalize(posix.join(here, ...parts)));
  }
  return [...out].filter((p) => !p.startsWith(".."));
}
const under = (folder: string, file: string) => folder === "." || file.startsWith(`${folder}/`);

// What a test file reaches, read from its text once per content (the runner keeps it by the file's blob).
export type Refs = { imports: string[]; reads: string[] };
export const refsIn = (text: string, from: string): Refs => ({ imports: importsOf(text, from), reads: treeReadsOf(text, from) });

// The test files a change touches, of one check that runs test files, the most
// direct first: the changed tests themselves and the ones still red from the
// last run (`carry`), then a changed file's own test (`x.test.ts` beside
// `x.ts`), the tests that read the source tree under a changed file
// (treeReadsOf: a convention test imports none of the files it checks), the
// other tests in a changed file's folder, and last the tests that import a
// changed file. Within each, the nearest to a changed file first. `tests`: the
// check's test files in the tree, from the top; `refsOf`: what a test reaches
// (undefined: not read).
const stem = (p: string) => posix.basename(p).replace(/\.(?:test|spec)(?=\.)/, "").replace(/\.[^.]+$/, "");
const apart = (a: string, b: string) => {
  const x = posix.dirname(a).split("/"), y = posix.dirname(b).split("/");
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return x.length + y.length - 2 * i;
};
export function testsFor(changed: readonly string[], tests: readonly string[], refsOf: (path: string) => Refs | undefined, carry: readonly string[] = []): string[] {
  const folders = new Set(changed.map((f) => dirname(f)));
  const touched = new Set([...changed, ...carry]);
  const ranked: { t: string; rank: number; near: number }[] = [];
  for (const t of tests) {
    const near = changed.length ? Math.min(...changed.map((f) => apart(t, f))) : 0;
    const at = (rank: number) => ranked.push({ t, rank, near });
    if (touched.has(t)) { at(0); continue; }
    if (changed.some((f) => dirname(f) === dirname(t) && stem(f) === stem(t))) { at(1); continue; }
    const refs = refsOf(t);
    if (refs?.reads.some((r) => changed.some((f) => under(r, f)))) { at(2); continue; }
    if (folders.has(dirname(t))) { at(3); continue; }
    if (refs?.imports.some((spec) => changed.some((f) => names(spec, f)))) at(4);
  }
  return ranked.sort((a, b) => a.rank - b.rank || a.near - b.near || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)).map((r) => r.t);
}

// What a test file reads of the tree: itself, the files it imports and what they import, to the end (by
// relative path; a package is not the tree's), and the folders it walks. `refsOf`: what a file reaches
// (undefined: not read, so nothing more is known through it); `files`: the tree's files.
export function reachOf(test: string, refsOf: (path: string) => Refs | undefined, files: readonly string[]): { files: Set<string>; folders: string[] } {
  const byBare = new Map<string, string>();
  for (const f of files) { byBare.set(f, f); byBare.set(f.replace(EXT, ""), f); if (/\/index\.[cm]?[jt]sx?$/.test(f)) byBare.set(posix.dirname(f), f); }
  const resolve = (spec: string) => byBare.get(spec) ?? byBare.get(spec.replace(EXT, ""));
  const seen = new Set<string>(), folders: string[] = [];
  const todo = [test];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const r = refsOf(f);
    if (!r) continue;
    folders.push(...r.reads);
    for (const spec of r.imports) { const to = resolve(spec); if (to && !seen.has(to)) todo.push(to); }
  }
  return { files: seen, folders };
}
// The test files of `green` (they passed on the tree checked last, or on one before it) that still stand: nothing
// they read changed in `change` (the tree's difference from the one checked last). A test that reads a file the
// change deleted reads a changed file. Only a JavaScript or TypeScript test can stand: what another kind reads is
// not known from its text. A file that is no module, changed in a folder of the reach, is read (a fixture the test
// opens by its path). Pure: the reach comes from reachOf.
export function stillGreen(green: readonly string[], change: readonly string[], reach: (test: string) => { files: Set<string>; folders: string[] }): string[] {
  return green.filter((t) => {
    if (!EXT.test(t)) return false;
    if (!change.length) return true;
    const r = reach(t);
    const dirs = new Set([...r.files].map((f) => posix.dirname(f)));
    return !change.some((f) => r.files.has(f) || r.folders.some((d) => under(d, f)) || (!EXT.test(f) && dirs.has(posix.dirname(f))));
  });
}

// How many test files one run takes: the most direct of what a change touches.
// A change to a file imported nearly everywhere touches hundreds; run whole,
// those take minutes, and their result comes when the agent is long past the
// change (or never, past its time limit), while the agent's own run of the
// suite is the check it is. Measured on this repository (see FIND-M23): the
// first 20 of a wide change's ranked tests still hold the review-found failures
// the whole selection held, and run in under a minute where the whole took 3 to 8.
export const PICK_MAX = 20;
// What one test file takes, before any run of the check here says (measured: 1.3 s a file for a
// narrow change, up to 3 s a file for a wide one on a loaded machine).
export const FILE_MS = 2_000;
// The longest run worth starting: a result later than this comes when the agent is past the change.
export const RUN_MAX_MS = 120_000;
// The time limit of a run of `files` test files at `msPerFile` (from the check's earlier runs here), or
// null when it would take longer than RUN_MAX_MS: then it is not run, and the agent's own run is the check.
// Three times what it should take, at least a minute (a loaded machine is slower than the runs it learned from).
export function limitOf(files: number, msPerFile = FILE_MS): number | null {
  const expect = files * msPerFile;
  if (expect > RUN_MAX_MS) return null;
  return Math.max(60_000, 3 * expect);
}
// What a file took in a run: its time over its files (a stopped run took at least its whole limit).
export const perFile = (ms: number, files: number) => (files > 0 ? Math.round(ms / files) : undefined);

// The test files of a check in the tree: the files its globs name, in its folder.
export function testFilesOf(check: Check, files: readonly string[]): string[] {
  if (!check.tests?.length) return [];
  const globs = check.tests.map((g) => new Bun.Glob(g));
  return files.filter((f) => (check.dir === "." || f.startsWith(`${check.dir}/`)) && globs.some((g) => g.match(f)));
}
// The command for a check with the test files given (from the check's folder,
// with `./`), or as named for one that takes none.
export function commandOf(check: Check, files: readonly string[] = []): string {
  if (!files.length) return check.run;
  return `${check.run} ${files.map((f) => { const rel = check.dir === "." ? f : relative(check.dir, f); return quote(rel.startsWith(".") ? rel : `./${rel}`); }).join(" ")}`;
}

// Whether an agent's run of a check (its command as it was run) covers the files a run beside it would give
// the check: the check whole (what it takes no files for, or the command with none), or a run that names each
// of those files.
export function covers(check: Check, files: readonly string[], ran: string): boolean {
  if (!files.length) return true;
  const words = ran.trim().split(/\s+/);
  if (words.join(" ") === check.run.trim().split(/\s+/).join(" ")) return true;
  const named = new Set(words.map((w) => w.replace(/^(["'])(.*)\1$/, "$2").replace(/^\.\//, "")));
  return files.every((f) => named.has((check.dir === "." ? f : relative(check.dir, f)).replace(/^\.\//, "")));
}

// --- what a failure says

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
// The names of what failed: a test runner's failed tests (bun, jest and
// vitest, go, pytest, cargo), else the files a compiler names in its errors.
const FAILED = [
  /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/,
  /^\s*(?:✕|×)\s+(.+?)(?: \(\d+ ?m?s\))?$/,
  /^\s*FAIL\s+(\S.*)$/,
  /^--- FAIL: (\S+)/,
  /^FAILED (\S+)/,
  /^test (\S+) \.\.\. FAILED$/,
];
const COMPILE = /^(\S+?)(?:\(\d+,\d+\)|:\d+:\d+):?(?: -)? error\b/;
// A line that starts a failure; not a pass line, nor a summary that counts failures.
const STARTS = /\b(?:error|fail(?:ed|ure)?|assert(?:ion)?|panic(?:ked)?|exception|traceback)\b|✕|×/i;
const NOT_START = /^\s*(?:\(pass\)|✓|√|ok\b|PASS\b|\d+\s+(?:fail|pass|error)s?\b|Ran \d+ tests?\b|Tests?:|Test Files\b|Found \d+ errors?\b|error: script ".*" exited)/i;
export const NAMES_SHOWN = 6;
export const LINES_SHOWN = 8;
const LINE_MAX = 200;

export type Failure = { names: string[]; first: string[] };
export function failureOf(out: string): Failure {
  const lines = out.replace(ANSI, "").replace(/\r/g, "").split("\n");
  const names: string[] = [];
  for (const l of lines) {
    for (const re of FAILED) { const m = re.exec(l); if (m && !names.includes(m[1]!.trim())) { names.push(m[1]!.trim()); break; } }
  }
  if (!names.length) for (const l of lines) { const m = COMPILE.exec(l.trim()); if (m && !names.includes(m[1]!)) names.push(m[1]!); }
  const at = lines.findIndex((l) => l.trim() && STARTS.test(l) && !NOT_START.test(l));
  const clip = (l: string) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX - 1)}…` : l).trimEnd();
  if (at < 0) return { names, first: lines.filter((l) => l.trim()).slice(-LINES_SHOWN).map(clip) };
  // The first failure alone: to the line that names the failed test (a runner prints it after the error), and not
  // into a pass, a summary or a compiler's next error.
  const first: string[] = [];
  for (let i = at; i < lines.length && first.length < LINES_SHOWN; i++) {
    const l = lines[i]!;
    if (i > at && (NOT_START.test(l) || COMPILE.test(l.trim()))) break;
    if (!l.trim()) continue;
    first.push(clip(l));
    if (FAILED.some((re) => re.test(l))) break;
  }
  return { names, first };
}

// What one red check is told by.
// `base`: how the check fares on the base, when the ledger knows ("red on main too ..."): a failure that is not the change's.
export type Red = { name: string; command: string; exit: number | null; pass: number | null; fail: number | null; failure: Failure; why?: string; base?: string };
// What a set of failures is known by, so the same failure is told once: the
// checks, the names, and the first line, without the times and counts a rerun changes.
export function fingerprint(reds: readonly Red[]): string {
  const norm = (s: string) => s.replace(/\[[\d.]+m?s\]|\d+(?:\.\d+)?\s*m?s\b/g, "").replace(/\s+/g, " ").trim();
  const h = createHash("sha256");
  for (const r of [...reds].sort((a, b) => a.name.localeCompare(b.name))) h.update(`${r.name}\0${r.failure.names.map(norm).join("\0")}\0${norm(r.failure.first[0] ?? "")}\n`);
  return h.digest("hex").slice(0, 20);
}
// Whether a run's failures are told: some failed, and not the failure told last.
export function toTell(l: Lane, reds: readonly Red[]): { tell: boolean; told: string | null } {
  if (!reds.length) return { tell: false, told: null };
  const fp = fingerprint(reds);
  return { tell: fp !== l.told, told: fp };
}

// The harness input: which checks failed, their failing names, and the first
// lines of the first failure. `at`: when the files were taken, as the owner
// reads a time (HH:MM). Within about NOTICE_MAX characters.
export const NOTICE_MAX = 2_000;
export function noticeText(reds: readonly Red[], o: { tree: string; at: string; ran: readonly string[]; where?: string }): string {
  const short = (c: string) => (c.length > 120 ? `${c.slice(0, 119)}…` : c);
  const counts = (r: Red) => r.fail !== null ? `${r.fail} of ${(r.pass ?? 0) + r.fail} failed` : r.exit === null ? (r.why ?? "it did not finish") : `exit ${r.exit}`;
  const lines = reds.map((r) => {
    const shown = r.failure.names.slice(0, NAMES_SHOWN);
    const more = r.failure.names.length - shown.length;
    return `- ${r.name} (\`${short(r.command)}\`): ${counts(r)}${shown.length ? `: ${shown.join("; ")}${more > 0 ? `; ${more} more` : ""}` : ""}${r.base ? ` (${r.base})` : ""}`;
  });
  const first = reds.find((r) => r.failure.first.length);
  const head = `[harness] Checks beside your work: Keel ran ${o.ran.join(" and ")} by itself on your files as they were at ${o.at} (tree ${o.tree.slice(0, 9)})${o.where ? ` on ${o.where}` : ""}, and ${reds.length === 1 ? `${reds[0]!.name} failed` : "these failed"}:`;
  const tail = "Fix what your change broke, or run the check yourself to see all of it. A failure is told once; a check that passes says nothing.";
  const body = (n: number) => [head, ...lines, ...(first && n ? [`First failure (${first.name}):`, ...first.failure.first.slice(0, n).map((l) => `  ${l}`)] : []), tail].join("\n");
  for (const n of [LINES_SHOWN, 4, 1, 0]) {
    const t = body(n);
    if (t.length <= NOTICE_MAX) return t;
  }
  return body(0).slice(0, NOTICE_MAX);
}

// What the session that started a finished agent is told of a red run beside it (its failures notice,
// src/automation/failures.ts, which shows about 200 characters of it): the cause is the checks that failed;
// the words, what failed and how the first failure began, then the tree (the ledger has the rest).
export function parentWords(reds: readonly Red[], tree: string): { cls: string; message: string } {
  const first = reds.find((r) => r.failure.first.length);
  const what = reds.map((r) => `${r.name}${r.failure.names.length ? ` (${r.failure.names.slice(0, 2).join("; ")}${r.failure.names.length > 2 ? `; ${r.failure.names.length - 2} more` : ""})` : ""}${r.base ? `, ${r.base}` : ""}`).join("; ");
  const line = first?.failure.first[0]?.trim() ?? "";
  return {
    cls: reds.map((r) => r.name).join(", "),
    message: `${what} failed after it ended${line ? `: ${line.length > 120 ? `${line.slice(0, 119)}…` : line}` : ""} (tree ${tree.slice(0, 9)})`,
  };
}

// --- where a run goes

// This machine when its heavy pool has room for the run, else the owner's host
// when one is set and its load leaves room, else this machine's pool line
// (behind every other command: the run waits for room there).
// With `localLoad` over half of this machine's threads (BUSY_SHARE), the host goes first when it has room: a run
// that has a slot here still adds to a machine the owner's own work shares.
export type HostLoad = { load1: number; cores: number } | undefined;
export const BUSY_SHARE = 0.5;
export function placeOf(o: { localFree: boolean; host: string | null; hostLoad: HostLoad; share: number; localLoad?: HostLoad }): "local" | "host" | "line" {
  const hostRoom = !!o.host && !!o.hostLoad && o.hostLoad.load1 < o.hostLoad.cores * o.share;
  if (hostRoom && o.localLoad && o.localLoad.load1 > o.localLoad.cores * BUSY_SHARE) return "host";
  if (o.localFree) return "local";
  if (hostRoom) return "host";
  return "line";
}
// Whether the host is worth asking about its load: this machine has no room, or it is over BUSY_SHARE.
export const askHost = (o: { localFree: boolean; host: string | null; localLoad?: HostLoad }) =>
  !!o.host && (!o.localFree || (!!o.localLoad && o.localLoad.load1 > o.localLoad.cores * BUSY_SHARE));
// `cat /proc/loadavg; nproc` from the host, as one reading.
export function hostLoadOf(text: string): HostLoad {
  const [load, cores] = text.trim().split("\n");
  const load1 = Number(load?.split(/\s+/)[0]);
  const n = Number(cores?.trim());
  return Number.isFinite(load1) && Number.isInteger(n) && n > 0 ? { load1, cores: n } : undefined;
}

// A setup failure of a check (the copy lacks what the check reads), said once on the agent's timeline.
export type Setup = { name: string; line: string };
export const setupWords = (line: string) => `could not check: ${line}`;
// What a set of setup failures is known by, so the same one is said once.
export const setupKey = (all: readonly Setup[]): string | null =>
  all.length ? all.map((x) => `${x.name}\0${x.line}`).sort().join("\n") : null;

// A folder of Keel's own for a session's copy of the files: never a path the session names.
export const scratchName = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
export const BESIDE_DIR = ["checks", "beside"] as const;
