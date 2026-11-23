// The fails-before run (the decisions are in src/checks/before.ts): the test
// files a session added or changed over its base, each run on a scratch
// worktree at the merge base with only the test files applied, through the
// repository's own command for one test file. Off the loop (git and the runs
// are child processes), at a low priority, one run at a time per repository,
// each file within its time limit. Never in the session's own folder or the
// owner's checkout: the scratch worktree is Keel's own, under its state
// folder, and goes when the run ends.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { git } from "../core/git.ts";
import { chunksUntil } from "../core/proc.ts";
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import { sandboxStatus, scopeHead } from "../safety/sandbox.ts";
import { toolEnv } from "../tools/jobs.ts";
import { git as worktreeGit } from "../worktree/manager.ts";
import { commandFor, howToRun, keyOf, limitFor, missingOnBase, testsOf, timesCpu, TIMES_FILE, verdictOf, withTimes, type FileResult } from "./before.ts";
import { baseOf, namedFor, ofSession, repoOf, type Repo } from "./ledger.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fails_before (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  key TEXT NOT NULL,
  repo TEXT NOT NULL,
  base TEXT,
  merge_base TEXT,
  common TEXT,
  unconfined TEXT,
  state TEXT NOT NULL,
  why TEXT,
  results TEXT NOT NULL,
  created INTEGER NOT NULL,
  ended INTEGER
);
CREATE INDEX IF NOT EXISTS fails_before_session ON fails_before(session_id, id);
`;

// `common`: the repository's common git directory, where its scratch worktree is listed.
// `unconfined`: why its tests ran outside the sandbox (the session runs in full auto with its sandbox off).
export type BeforeRun = { id: number; session_id: string; key: string; repo: string; base: string | null; merge_base: string | null; common: string | null; unconfined: string | null; state: "running" | "done"; why: string | null; results: FileResult[]; created: number; ended: number | null };
type Row = Omit<BeforeRun, "results"> & { results: string };

// `confine`: the session's own sandbox profile with `workspace` in the place of its folder and `tool` as its tool
// folder (the gate's confineFor), or undefined when its commands run unconfined.
type Deps = {
  store: Store; bus: Bus; capture: (e: unknown, ctx: object) => void;
  perm: (sessionId: string) => { mode: string; sandbox: string } | undefined;
  confine: (sessionId: string, workspace: string, tool: string) => { wrap: (argv: string[]) => string[]; sandbox: string } | undefined;
};
let d: Deps | undefined;
const dir = () => join(d!.store.stateDir, "checks", "before");
// Bytes of output read from one file's run: enough for the summary and the first error.
const OUT_MAX = 256 * 1024;

// The table, and what a restart cut: a run that was going is ended, its open
// files say why, and its scratch worktrees go (the promise: when they have).
export function bindBefore(deps: Deps): Promise<void> {
  d = deps;
  d.store.migrate(SCHEMA);
  const cut = d.store.db.query<Row, []>("SELECT * FROM fails_before WHERE state = 'running'").all().filter((r) => !going.has(r.id));
  for (const r of cut) {
    const results = (JSON.parse(r.results) as FileResult[]).map((f) => (f.state === "running" || f.state === "waiting" ? { ...f, state: "unrun" as const, why: "the daemon restarted while it ran" } : f));
    d.store.db.query("UPDATE fails_before SET state = 'done', results = ?, ended = ? WHERE id = ?").run(JSON.stringify(results), Date.now(), r.id);
  }
  return sweep().catch((e) => d!.capture(e, { at: "fails before sweep" }));
}

// Scratch worktrees an earlier daemon left (one that was killed while it ran): removed, and the list of each
// repository they were checked out from pruned. The repository is read from the scratch worktree itself (its
// .git file names its entry in the common git directory) and from the runs, by its common git directory: the
// folder a run started from is often an agent's worktree, gone by now, while the repository is still there.
// (A repository moved since is not found: git's own gc prunes its entry.)
async function sweep() {
  let names: string[] = [];
  try { names = readdirSync(dir()); } catch { return; }
  names = names.filter((n) => !going.has(Number(n.replace(/\.tool$/, ""))));
  if (!names.length) return;
  const commons = new Set(d!.store.db.query<{ common: string }, []>("SELECT DISTINCT common FROM fails_before WHERE common IS NOT NULL").all().map((r) => r.common));
  for (const n of names) {
    const c = commonOf(join(dir(), n));
    if (c) commons.add(c);
    rmSync(join(dir(), n), { recursive: true, force: true });
  }
  for (const c of commons) if (existsSync(c)) await git(c, ["worktree", "prune"], { timeout: 30_000 }).catch(() => {});
}
// The common git directory of a linked worktree, from its .git file ("gitdir: <common>/worktrees/<name>").
export function commonOf(worktree: string): string | undefined {
  try {
    const at = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(worktree, ".git"), "utf8"))?.[1]?.trim();
    return at && basename(dirname(at)) === "worktrees" ? dirname(dirname(at)) : undefined;
  } catch { return undefined; } // not a worktree (a tool folder)
}

const toRun = (r: Row): BeforeRun => ({ ...r, results: JSON.parse(r.results) });
export const latest = (sessionId: string): BeforeRun | undefined => {
  const r = d?.store.db.query<Row, [string]>("SELECT * FROM fails_before WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId);
  return r ? toRun(r) : undefined;
};
const save = (r: BeforeRun) => {
  d!.store.db.query("UPDATE fails_before SET state = ?, why = ?, unconfined = ?, results = ?, ended = ? WHERE id = ?").run(r.state, r.why, r.unconfined, JSON.stringify(r.results), r.ended, r.id);
  d!.bus.emit({ t: "feature", name: "fails_before", session_id: r.session_id, data: r });
};

// One run at a time per repository (by its common git directory). Kept by the process, not the module: a
// module loaded again (a dev daemon's reload) sees the runs the one before it started, and leaves them be.
const kept = ((globalThis as any).__keelFailsBefore ??= { lanes: new Map(), going: new Map() }) as { lanes: Map<string, Promise<unknown>>; going: Map<number, { run: BeforeRun; done: Promise<BeforeRun> }> };
const { lanes, going } = kept;

// The test files the session's folder adds or changes over its base, started
// on the base. A run of the same files on the same base going now, or one that
// ran every file, is the answer, unless `again` (the owner's Run again).
// Undefined: the folder names no check that runs test files, or none of its
// changed files is one.
export async function startFor(sessionId: string, folder: string, o: { base?: string; again?: boolean } = {}): Promise<BeforeRun | undefined> {
  const base = o.base;
  if (!d) return undefined;
  const repo = repoOf(folder);
  const named = repo ? namedFor(repo) : undefined;
  if (!repo || !named?.checks.some((c) => c.tests?.length)) return undefined;
  const baseName = base ?? (await baseOf(repo))?.name;
  const mb = baseName ? (await git(repo.top, ["merge-base", "HEAD", baseName], { read: true, timeout: 30_000 })).out.trim() || null : null;
  const changed = mb ? await changedFiles(repo, mb) : [];
  const tests = testsOf(changed, named.checks).filter((t) => existsSync(join(repo.top, t.path)));
  if (!tests.length) return undefined;
  const files = tests.map((t) => ({ path: t.path, command: commandFor(t), bytes: readBytes(join(repo.top, t.path)) }));
  const key = keyOf(mb ?? "", files);
  const had = d.store.db.query<Row, [string, string]>("SELECT * FROM fails_before WHERE session_id = ? AND key = ? ORDER BY id DESC LIMIT 1").get(sessionId, key);
  if (had && going.has(had.id)) return going.get(had.id)!.run;
  if (had && !o.again && !(JSON.parse(had.results) as FileResult[]).some((f) => f.state === "unrun")) return toRun(had);
  const results: FileResult[] = tests.map((t, i) => ({ path: t.path, check: t.check.name, command: files[i]!.command, state: "waiting", why: "", exit: null, ms: null, cpu_ms: null }));
  const why = !baseName ? "no base branch to compare with" : !mb ? `no merge base with ${baseName}` : null;
  const id = Number(d.store.db.query("INSERT INTO fails_before (session_id, key, repo, base, merge_base, common, state, why, results, created) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)")
    .run(sessionId, key, repo.top, baseName ?? null, mb, repo.common, why, JSON.stringify(results), Date.now()).lastInsertRowid);
  const run: BeforeRun = { id, session_id: sessionId, key, repo: repo.top, base: baseName ?? null, merge_base: mb, common: repo.common, unconfined: null, state: "running", why, results, created: Date.now(), ended: null };
  if (why) { run.results = results.map((r) => ({ ...r, state: "unrun", why })); run.state = "done"; run.ended = Date.now(); save(run); return run; }
  save(run);
  const lane = lanes.get(repo.common) ?? Promise.resolve();
  const p = lane.then(() => execute(run, repo, tests.map((t, i) => ({ ...t, bytes: files[i]!.bytes }))))
    .catch((e) => { d!.capture(e, { at: "fails before", session: sessionId }); run.results = run.results.map((r) => (r.state === "running" || r.state === "waiting" ? { ...r, state: "unrun", why: `Keel failed: ${(e as Error).message}` } : r)); return run; })
    .finally(() => { run.state = "done"; run.ended = Date.now(); save(run); going.delete(id); });
  const tail = p.catch(() => {});
  lanes.set(repo.common, tail);
  void tail.then(() => { if (lanes.get(repo.common) === tail) lanes.delete(repo.common); });
  going.set(id, { run, done: p });
  return run;
}

// The end of a run that is going, or undefined when it ended.
export const whenDone = (run: BeforeRun): Promise<BeforeRun> | undefined => going.get(run.id)?.done;

// Waits for a run, at most `ms`: the run as it is then.
export async function settled(run: BeforeRun, ms: number): Promise<BeforeRun> {
  const p = going.get(run.id)?.done;
  if (!p) return run;
  let t: ReturnType<typeof setTimeout> | undefined;
  const r = await Promise.race([p, new Promise<BeforeRun>((res) => { t = setTimeout(() => res(run), ms); })]);
  clearTimeout(t);
  return r;
}

const readBytes = (p: string): Uint8Array | null => { try { return new Uint8Array(readFileSync(p)); } catch { return null; } };

// What the folder changes over the merge base: committed, staged, unstaged and new files (not ignored ones), none deleted.
async function changedFiles(repo: Repo, mb: string): Promise<string[]> {
  const diff = await git(repo.top, ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=d", mb, "--"], { read: true, timeout: 60_000 });
  const added = await git(repo.top, ["ls-files", "-z", "-o", "--exclude-standard"], { read: true, timeout: 60_000 });
  return [...diff.out.split("\0"), ...added.out.split("\0")].filter(Boolean);
}

// A program that lowers the run's priority, when the machine has it: a low weight (it takes spare time at full
// speed and yields when other work wants the machine), not the idle class.
const LOW = () => [...(existsSync("/usr/bin/nice") ? ["/usr/bin/nice", "-n", "10"] : []), ...(existsSync("/usr/bin/ionice") ? ["/usr/bin/ionice", "-c2", "-n7"] : [])];

async function execute(run: BeforeRun, repo: Repo, tests: (ReturnType<typeof testsOf>[number] & { bytes: Uint8Array | null })[]): Promise<BeforeRun> {
  const scratch = join(dir(), `${run.id}`);
  // Its tool folder: where the run's own files go (its processor time), writable in every sandbox profile.
  const tool = `${scratch}.tool`;
  // The session's own sandbox, with the scratch checkout as its folder.
  const confined = d!.confine(run.session_id, scratch, tool);
  const how = howToRun(d!.perm(run.session_id), confined);
  if ("refused" in how) { run.results = run.results.map((r) => ({ ...r, state: "unrun", why: how.refused })); return run; }
  if (!how.confined) run.unconfined = how.why;
  mkdirSync(dirname(scratch), { recursive: true });
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(tool, { recursive: true });
  const top = mainTop(repo);
  try {
    try { await worktreeGit(top, ["worktree", "add", "--detach", scratch, run.merge_base!]); }
    catch (e) { run.results = run.results.map((r) => ({ ...r, state: "unrun", why: `the base could not be checked out: ${(e as Error).message.slice(0, 120)}` })); return run; }
    // Only the test files are applied.
    for (const t of tests) { mkdirSync(dirname(join(scratch, t.path)), { recursive: true }); writeFileSync(join(scratch, t.path), t.bytes ?? new Uint8Array()); }
    // What a check reads that is not in the tree (an install named in its inputs) is the folder's own, linked.
    for (const c of new Set(tests.map((t) => t.check))) for (const input of c.inputs) {
      const first = input.split("/").find((p) => p && p !== ".");
      if (!first || first === "..") continue;
      const from = join(repo.top, first), to = join(scratch, first);
      if (existsSync(from) && !existsSync(to)) try { symlinkSync(from, to); } catch {} // one at a time: it is there
    }
    const own = ofSession(run.session_id, 0);
    const wrap = confined?.wrap;
    for (let i = 0; i < tests.length; i++) {
      const t = tests[i]!;
      run.results[i] = { ...run.results[i]!, state: "running" };
      save(run);
      const mine = own.filter((r) => r.command.includes(t.path.split("/").pop()!)).map((r) => r.ended - r.started);
      const cwd = t.check.dir === "." ? scratch : join(scratch, t.check.dir);
      // (CI: a runner that would watch for changes runs once.)
      const env: Record<string, string> = { ...toolEnv(run.session_id), CI: "1" };
      const missing = !existsSync(cwd) ? `the check's folder ${t.check.dir} is not on the base`
        : missingOnBase(t.check.run, { file: (f) => existsSync(join(cwd, f)), onPath: (n) => !!Bun.which(n, { PATH: env.PATH ?? "", cwd }) });
      run.results[i] = { ...run.results[i]!, ...(missing ? { state: "unrun" as const, why: missing } : await runOne({ cwd, tool, env, command: run.results[i]!.command, limitMs: limitFor(mine), wrap, unit: `keel-before-${process.pid}-${run.id}-${i}` })) };
      save(run);
    }
    return run;
  } finally {
    await worktreeGit(top, ["worktree", "remove", "--force", scratch], { ok: true }).catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
    rmSync(tool, { recursive: true, force: true });
  }
}

// The main checkout of a repository (its worktree commands go one after another there).
const mainTop = (repo: Repo) => (repo.common.endsWith("/.git") ? dirname(repo.common) : repo.top);

// How long the output of a run is still read after its end: what a process it started outside its group still
// holds open (a `setsid` child) is not waited for after that.
export const DRAIN_MS = 2_000;

// One file's run. A run that is not in the sandbox (whose processes all end with it: its own process space) runs
// in a systemd scope of its own when the machine has them, so what it started goes with it, also a process that
// left its group. Its process group goes at its end in any case, also after a normal exit.
type One = { cwd: string; tool: string; env: Record<string, string>; command: string; limitMs: number; wrap?: (argv: string[]) => string[]; unit: string };
export async function runOne(o: One): Promise<Partial<FileResult>> {
  const times = join(o.tool, TIMES_FILE);
  rmSync(times, { force: true });
  const argv = [...LOW(), "bash", "-c", withTimes(o.command, times)];
  const scoped = !o.wrap && sandboxStatus().scope && scopeHead().length > 0;
  const full = o.wrap ? o.wrap(argv) : scoped ? [...scopeHead(), `--unit=${o.unit}`, "--", ...argv] : argv;
  const started = performance.now();
  let timedOut = false;
  let p: ReturnType<typeof Bun.spawn>;
  try { p = Bun.spawn(full, { cwd: o.cwd, env: o.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true }); }
  catch (e) { return { state: "unrun", why: `it could not start: ${(e as Error).message}`, exit: null }; }
  const stop = () => { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch {} } };
  const timer = setTimeout(() => { timedOut = true; stop(); }, o.limitMs);
  // Its end: what is left of its group and its scope goes, and its pipes are read for DRAIN_MS more at most.
  const ended = p.exited.then(async () => {
    clearTimeout(timer);
    stop();
    if (scoped) try { await Bun.spawn(["systemctl", "--user", "kill", "--signal=SIGKILL", `${o.unit}.scope`], { stdout: "ignore", stderr: "ignore" }).exited; } catch {} // gone with its last process
    await Bun.sleep(DRAIN_MS);
  });
  // (Its end is kept: the summary and the error are there.)
  let out = "";
  const keep = (t: string) => { out += t; if (out.length > 2 * OUT_MAX) out = out.slice(-OUT_MAX); };
  const read = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const c of chunksUntil(s, ended)) keep(dec.decode(c, { stream: true }));
    keep(dec.decode());
  };
  const [code] = await Promise.all([p.exited, read(p.stdout as ReadableStream<Uint8Array>), read(p.stderr as ReadableStream<Uint8Array>)]);
  const ms = Math.round(performance.now() - started);
  let cpu_ms: number | null = null;
  try { cpu_ms = timesCpu(readFileSync(times, "utf8")); } catch {} // stopped before its end: not known
  rmSync(times, { force: true });
  const v = verdictOf({ code: timedOut ? null : code, signal: timedOut || p.signalCode == null ? null : String(p.signalCode), timedOut, limitMs: o.limitMs, out: out.slice(-OUT_MAX) });
  return { ...v, exit: timedOut ? null : code, ms, cpu_ms };
}
