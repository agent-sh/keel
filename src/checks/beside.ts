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
// (WINDOW_MS from the first change that waits) taken together, a run only for
// a tree that is not the one checked last, and a failure told once (the same
// failure on a later tree is not told again).
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
export type Owed = { text: string; key: string; cls: string; message: string };
export type Lane = { first: number | null; ended: boolean; over: boolean; running: boolean; tree: string | null; told: string | null; carry: string[]; owed: Owed | null; said: string | null };
export const fresh = (): Lane => ({ first: null, ended: false, over: false, running: false, tree: null, told: null, carry: [], owed: null, said: null });

// A step changed files (or may have: a shell call).
export const changed = (l: Lane, now: number): Lane => ({ ...l, first: l.first ?? now, over: false });
// Its turn ended: what waits runs now, with no more of the window.
export const turnEnded = (l: Lane): Lane => ({ ...l, over: true, ended: l.first !== null });
// When a run is due: never while one runs, else at the end of the window (or now, after the turn's end).
export function dueAt(l: Lane, windowMs = WINDOW_MS): number | null {
  if (l.first === null || l.running) return null;
  return l.ended ? l.first : l.first + windowMs;
}
export const started = (l: Lane): Lane => ({ ...l, first: null, ended: false, running: true });
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
// (readdirSync, a glob's scan) from its own place (`import.meta.dir`,
// `__dirname`) reads every file below what it joins to it, and below its own
// folder (a convention test that reads every source file imports none of them).
// Paths from the top; none for a test that walks nothing of the tree.
const WALKS = /\breaddir(?:Sync)?\s*\(|\.scan(?:Sync)?\s*\(|\bnew\s+(?:Bun\.)?Glob\s*\(/;
const HERE = /\b(?:import\.meta\.dir(?:name)?|__dirname)\b/;
const JOINED = /\b(?:join|resolve)\(\s*(?:import\.meta\.dir(?:name)?|__dirname)((?:\s*,\s*["'][^"'\n]*["'])+)\s*\)/g;
export function treeReadsOf(text: string, from: string): string[] {
  if (!WALKS.test(text) || !HERE.test(text)) return [];
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
export type HostLoad = { load1: number; cores: number } | undefined;
export function placeOf(o: { localFree: boolean; host: string | null; hostLoad: HostLoad; share: number }): "local" | "host" | "line" {
  if (o.localFree) return "local";
  if (o.host && o.hostLoad && o.hostLoad.load1 < o.hostLoad.cores * o.share) return "host";
  return "line";
}
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
