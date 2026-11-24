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
// would add to the change (it runs as soon as it may). `running`: a run of it is
// going. `tree`: the tree its last run checked. `told`: the failure it was told
// last (a fingerprint), cleared by a green run.
export type Lane = { first: number | null; ended: boolean; running: boolean; tree: string | null; told: string | null };
export const fresh = (): Lane => ({ first: null, ended: false, running: false, tree: null, told: null });

// A step changed files (or may have: a shell call).
export const changed = (l: Lane, now: number): Lane => ({ ...l, first: l.first ?? now });
// Its turn ended: what waits runs now, with no more of the window.
export const turnEnded = (l: Lane): Lane => (l.first === null ? l : { ...l, ended: true });
// When a run is due: never while one runs, else at the end of the window (or now, after the turn's end).
export function dueAt(l: Lane, windowMs = WINDOW_MS): number | null {
  if (l.first === null || l.running) return null;
  return l.ended ? l.first : l.first + windowMs;
}
export const started = (l: Lane): Lane => ({ ...l, first: null, ended: false, running: true });
// A run ended (or found nothing to do): the tree it checked, and the failure it told (undefined: as it was).
export const finished = (l: Lane, tree: string | null, told?: string | null): Lane => ({ ...l, running: false, tree: tree ?? l.tree, ...(told !== undefined ? { told } : {}) });

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

// The test files a change touches, of one check that runs test files: the
// changed tests themselves, the tests in the folder of any changed file, the
// tests that import a changed file, and the tests that read the source tree
// under a changed file (treeReadsOf). `tests`: the check's test files in the
// tree, from the top; `textOf`: a test file's text (undefined: not read).
export function testsFor(changed: readonly string[], tests: readonly string[], textOf: (path: string) => string | undefined): string[] {
  const folders = new Set(changed.map((f) => dirname(f)));
  const touched = new Set(changed);
  const out: string[] = [];
  for (const t of [...tests].sort()) {
    if (touched.has(t) || folders.has(dirname(t))) { out.push(t); continue; }
    const text = textOf(t);
    if (!text) continue;
    if (importsOf(text, t).some((spec) => changed.some((f) => names(spec, f)))) { out.push(t); continue; }
    const reads = treeReadsOf(text, t);
    if (reads.some((r) => changed.some((f) => under(r, f)))) out.push(t);
  }
  return out;
}
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

// A folder of Keel's own for a session's copy of the files: never a path the session names.
export const scratchName = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
export const BESIDE_DIR = ["checks", "beside"] as const;
