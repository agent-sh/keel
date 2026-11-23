// Fails before: a test an agent added or changed proves its change only if it
// fails without it. Keel runs each such test file on the base (the merge base
// of the agent's branch) with only the test files applied, through the
// repository's own command for one test file (a named check with `tests`,
// src/checks/named.ts), and says per file: "fails before: yes", "passes
// without the change", or "could not run (why)". This is the test patch check
// of SWE-bench (FAIL_TO_PASS: a test that fails on the base commit with the
// test patch applied) and the killed, survived and errored mutants of
// mutation testing, done for the agent's own branch. Pure: the runner is
// src/checks/before-run.ts.
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { countsOf } from "./counts.ts";
import type { Check } from "./named.ts";

export type State = "fails" | "passes" | "unrun";
// Where under the state folder the scratch worktrees of the runs are (Keel's own: never an agent's leftover).
export const BEFORE_DIR = ["checks", "before"] as const;
export type TestFile = { path: string; check: Check };

// Which changed files are tests, and the check that runs each: the first
// check whose `tests` globs name it, and whose folder holds it.
export function testsOf(changed: readonly string[], checks: readonly Check[]): TestFile[] {
  const globs = checks.filter((c) => c.tests?.length && c.args).map((c) => ({ c, g: c.tests!.map((t) => new Bun.Glob(t)) }));
  const out: TestFile[] = [];
  for (const path of [...new Set(changed)].sort()) {
    const hit = globs.find(({ c, g }) => inDir(c.dir, path) && g.some((x) => x.match(path)));
    if (hit) out.push({ path, check: hit.c });
  }
  return out;
}
const inDir = (dir: string, path: string) => dir === "." || path.startsWith(`${dir}/`);

// A word for the shell, quoted when it needs to be.
export const quote = (w: string) => (/^[\w./@%+=:,-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

// The command that runs one test file: the check's own words, then the file
// from the check's folder (with `./`, so a runner that also takes names as
// filters reads it as a path).
export function commandFor(t: TestFile): string {
  const rel = t.check.dir === "." ? t.path : relative(t.check.dir, t.path);
  return `${t.check.run} ${quote(rel.startsWith(".") ? rel : `./${rel}`)}`;
}

// What one test file's run on the base says.
export type Ran = { code: number | null; signal?: string | null; timedOut?: boolean; limitMs: number; out: string };
export type Verdict = { state: State; why: string };
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
const WHY_MAX = 160;
const clipWhy = (s: string) => (s.length > WHY_MAX ? `${s.slice(0, WHY_MAX - 1)}…` : s);
// The line of an error that stopped the file from loading (a module the change adds, an export it defines):
// bun, node and vite say "Cannot find module", "Cannot find package" or "does not provide an export",
// Python an ImportError or ModuleNotFoundError, every runner a SyntaxError.
const LOAD = /^.*(?:Cannot find module|Cannot find package|does not provide an export|ModuleNotFoundError|ImportError|SyntaxError).*$/m;
const lastLine = (out: string) => out.replace(ANSI, "").trim().split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";

// `base`: what the base declares of packages (`declared`: the names in its package.json files) and, when its
// packages could not be put in the scratch checkout, why. A package the base declares that does not load is the
// checkout's lack, not the change's: the file could not run. A module only the change adds is a real failure.
export type BasePackages = { declared: ReadonlySet<string>; why?: string };
export function verdictOf(r: Ran, base?: BasePackages): Verdict {
  const out = r.out.replace(ANSI, "").replace(/\r/g, "");
  if (r.timedOut) return { state: "unrun", why: `it ran past its ${Math.round(r.limitMs / 1000)} s limit and was stopped` };
  if (r.signal) return { state: "unrun", why: `it was ended by ${r.signal}` };
  // The shell's own codes: the command, or a program it names, is not there (or cannot start) on the base.
  if (r.code === 126 || r.code === 127) return { state: "unrun", why: clipWhy(`the command could not start on the base: ${lastLine(out) || `exit ${r.code}`}`) };
  const counts = countsOf(out);
  const pass = counts?.pass ?? 0, fail = counts?.fail ?? 0;
  if (r.code === 0) {
    if (counts && pass + fail === 0) return { state: "unrun", why: "no test in it ran on the base" };
    return { state: "passes", why: counts ? `${pass} passed` : "" };
  }
  const load = pass === 0 ? LOAD.exec(out)?.[0].trim().replace(/^error:\s*/, "") : undefined;
  if (load) {
    const pkg = missingPackage(out);
    if (pkg && base?.declared.has(pkg)) return { state: "unrun", why: clipWhy(`the base's packages are not there: ${base.why ?? load}`) };
    return { state: "fails", why: clipWhy(`it does not load without the change: ${load}`) };
  }
  if (fail) return { state: "fails", why: `${fail} of ${pass + fail} failed` };
  return { state: "fails", why: clipWhy(`exit ${r.code}${lastLine(out) ? `: ${lastLine(out)}` : ""}`) };
}

// The package a load error names as missing ("Cannot find module 'x' from ...", "Cannot find package 'x'
// imported from ..."): the root of a bare specifier (`@scope/name`, `name` of `name/sub`), never a path or a
// builtin. Undefined when the error names none.
export function missingPackage(out: string): string | undefined {
  const spec = /Cannot find (?:module|package) ['"]([^'"]+)['"]/.exec(out.replace(ANSI, ""))?.[1];
  if (!spec || /^(?:\.|\/|[a-z]+:)/i.test(spec)) return undefined;
  const parts = spec.split("/");
  return spec.startsWith("@") ? (parts.length > 1 ? `${parts[0]}/${parts[1]}` : undefined) : parts[0];
}

// The packages a set of package.json texts declares (every dependency field); a text that does not parse
// declares none.
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
export function declaredOf(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    let j: Record<string, unknown>;
    try { j = JSON.parse(t); } catch { continue; }
    if (!j || typeof j !== "object") continue;
    for (const f of DEP_FIELDS) { const deps = j[f]; if (deps && typeof deps === "object") for (const n of Object.keys(deps)) out.add(n); }
  }
  return out;
}

// The lockfiles of the JavaScript package managers, each with the install that reproduces it exactly.
export const LOCKS = [
  { file: "bun.lock", install: "bun install --frozen-lockfile" },
  { file: "bun.lockb", install: "bun install --frozen-lockfile" },
  { file: "pnpm-lock.yaml", install: "pnpm install --frozen-lockfile" },
  { file: "yarn.lock", install: "yarn install --frozen-lockfile" },
  { file: "package-lock.json", install: "npm ci" },
  { file: "npm-shrinkwrap.json", install: "npm ci" },
] as const;
export type Lock = (typeof LOCKS)[number];

// The folder whose packages a check's folder uses: the nearest one from it up to the top ("."), that holds a
// lockfile, with that lockfile. Undefined when none does.
export function lockDirOf(dir: string, has: (path: string) => boolean): { dir: string; lock: Lock } | undefined {
  const parts = dir === "." ? [] : dir.split("/").filter(Boolean);
  for (let n = parts.length; n >= 0; n--) {
    const at = n ? parts.slice(0, n).join("/") : ".";
    const lock = LOCKS.find((l) => has(at === "." ? l.file : `${at}/${l.file}`));
    if (lock) return { dir: at, lock };
  }
  return undefined;
}

// The words for one file, as the report and the Review view say them.
export function stateWords(state: State | "running" | "waiting", why: string): string {
  if (state === "fails") return `fails before: yes${why ? ` (${why})` : ""}`;
  if (state === "passes") return "passes without the change";
  if (state === "unrun") return `could not run (${why || "no reason was given"})`;
  return state === "running" ? "running on the base" : "waiting to run";
}

// What a set of test files on a base is known by: the base, each file's
// content and command. The same key is the same run: it is not made again.
export function keyOf(mergeBase: string, files: readonly { path: string; command: string; bytes: Uint8Array | null }[]): string {
  const h = createHash("sha256").update(`${mergeBase}\n`);
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`${f.path}\0${f.command}\0`);
    h.update(f.bytes ? createHash("sha256").update(f.bytes).digest("hex") : "none");
    h.update("\n");
  }
  return h.digest("hex").slice(0, 24);
}

// The time one file may run on the base: what the agent's own runs of it
// took, times three (the base is a cold checkout), and never less than the
// shell tool's own default for a call (two minutes: a test file the agent ran
// in one plain call ended within it).
export const LIMIT_FLOOR_MS = 120_000;
export function limitFor(ownRunsMs: readonly number[]): number {
  const longest = ownRunsMs.length ? Math.max(...ownRunsMs) : 0;
  return Math.max(LIMIT_FLOOR_MS, 3 * longest);
}

// --- the line on the agent's report

export type FileResult = { path: string; check: string; command: string; state: State | "running" | "waiting"; why: string; exit: number | null; ms: number | null; cpu_ms: number | null };
// `unconfined`: why the run went outside the sandbox (the session runs in full auto with its sandbox off).
export type BeforeIn = { mergeBase: string | null; base: string | null; why?: string | null; unconfined?: string | null; results: readonly FileResult[] };
export const LINE_MAX = 700;
const SHOWN = 6;
const short = (sha: string | null) => (sha ? sha.slice(0, 9) : "?");

// "" when no test file was added or changed. A run that has not ended by the
// time the report goes says which files are still running.
export function beforeLine(b: BeforeIn): string {
  if (!b.results.length) return "";
  const head = `Its new and changed tests on the base${b.base ? ` (${b.base} at ${short(b.mergeBase)})` : ""}, without the change${b.unconfined ? `, run outside the sandbox (${b.unconfined})` : ""}`;
  if (b.why) return `(${head}: ${b.results.length === 1 ? b.results[0]!.path : `${b.results.length} test files`} could not run (${b.why}).)`.slice(0, LINE_MAX);
  const open = b.results.filter((r) => r.state === "running" || r.state === "waiting");
  const done = b.results.filter((r) => r.state !== "running" && r.state !== "waiting");
  const said = (n: number) => {
    const shown = done.slice(0, n).map((r) => `${r.path} ${stateWords(r.state, r.why)}`);
    const rest = done.length - shown.length;
    const running = open.length ? `${open.length} still running (${open.length === 1 ? "its answer follows" : "their answers follow"} when done, and the Review view shows ${open.length === 1 ? "it" : "them"})` : "";
    return [...shown, rest ? `${rest} more` : "", running].filter(Boolean).join("; ");
  };
  for (const n of [SHOWN, 3, 1]) {
    const text = `(${head}: ${said(n)}.)`;
    if (text.length <= LINE_MAX) return text;
  }
  const counts = (["fails", "passes", "unrun"] as const).map((s) => `${done.filter((r) => r.state === s).length} ${s === "fails" ? "fail before" : s === "passes" ? "pass without the change" : "could not run"}`);
  return `(${head}: ${counts.join(", ")}${open.length ? `, ${open.length} still running` : ""}.)`.slice(0, LINE_MAX);
}

// How the run on the base is started for a session: in the sandbox its own
// commands get (its profile, with the scratch checkout in the place of its
// folder: `confined`, from the gate) when its sandbox is on; without one only
// where the session's own commands run unconfined without asking (full auto),
// and the run then says so. The test files are the agent's code: Keel never
// runs them with more reach than the agent's own commands had.
export type How = { confined: true; sandbox: string } | { confined: false; why: string } | { refused: string };
export function howToRun(p: { mode: string; sandbox: string } | undefined, confined: { sandbox: string } | undefined): How {
  if (!p) return { refused: "the session's permissions could not be read" };
  if (confined) return { confined: true, sandbox: confined.sandbox };
  const off = p.sandbox === "off";
  if (p.mode === "full-auto") return { confined: false, why: off ? "the session runs in full auto with its sandbox off" : "the session runs in full auto and the sandbox is not available on this machine" };
  return { refused: off ? "the session's commands run outside the sandbox and its mode asks before a command runs" : "the sandbox is not available on this machine and the session's mode asks before a command runs" };
}

// What must be on the base for a check's command to start: its program (a
// path from its folder, or a name on PATH) and, for a shell, the script it
// is given. A command of its own that is missing there is "could not run",
// not a failure of the test.
const SHELLS = new Set(["sh", "bash", "dash", "zsh"]);
export function needsOf(run: string): { program: string; script?: string } {
  const words = run.split(" ").filter((w) => !/^[A-Za-z_]\w*=/.test(w));
  const program = words[0] ?? "";
  const script = SHELLS.has(program.split("/").pop()!) && words[1] && !words[1].startsWith("-") ? words[1] : undefined;
  return script ? { program, script } : { program };
}
export function missingOnBase(run: string, has: { file: (path: string) => boolean; onPath: (name: string) => boolean }): string | undefined {
  const n = needsOf(run);
  if (n.program.includes("/") ? !has.file(n.program) : !has.onPath(n.program)) return `its command's program ${n.program} is not on the base`;
  if (n.script && !has.file(n.script)) return `its command's script ${n.script} is not on the base`;
  return undefined;
}

// The processor time of a run, from what bash's `times` printed at its end: the shell's own user and system
// time, then its children's. (Read inside the run: a sandbox's first process does not pass its children's
// time up to the daemon.) `file` is in the run's tool folder, which every sandbox profile can write.
// Milliseconds, or null when it printed nothing this reads.
export const TIMES_FILE = "cpu-times";
export const withTimes = (command: string, file: string) => `${command}\ns=$?; times > ${quote(file)} 2>/dev/null; exit $s`;
export function timesCpu(text: string): number | null {
  const all = [...text.matchAll(/(\d+)m(\d+(?:\.\d+)?)s/g)].map((m) => Number(m[1]) * 60_000 + Number(m[2]) * 1000);
  return all.length === 4 ? Math.round(all.reduce((a, b) => a + b, 0)) : null;
}
