// The fails-before run (the decisions are in src/checks/before.ts): the test
// files a session added or changed over its base, each run on a scratch
// worktree at the merge base with only the test files applied and the base's
// own packages (packagesFor), through the repository's own command for one
// test file. Off the loop (git and the runs
// are child processes), at a low priority, one run at a time per repository,
// each file within its time limit. Never in the session's own folder or the
// owner's checkout: the scratch worktree is Keel's own, under its state
// folder, and goes when the run ends.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { git } from "../core/git.ts";
import { chunksUntil, readText } from "../core/proc.ts";
import type { Bus } from "../core/bus.ts";
import type { Store } from "../core/store.ts";
import { sandboxStatus, scopeHead } from "../safety/sandbox.ts";
import { jobScope, sessionMark, toolEnv } from "../tools/jobs.ts";
import { git as worktreeGit } from "../worktree/manager.ts";
import * as cache from "./package-cache.ts";
import { BEFORE_DIR, clipWhy, commandFor, declaredOf, howToRun, keyOf, limitFor, lockDirOf, missingOnBase, needsOf, testsOf, timesCpu, TIMES_FILE, verdictOf, withTimes, type BasePackages, type FileResult } from "./before.ts";
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
  note TEXT,
  follow_agent TEXT,
  follow_said TEXT,
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
// `note`: how the base's packages were had, when its line says it (installed for this run only, and why).
// `follow_agent`: the agent whose report went while files of the run were open, owed their answers (its parent
// is told once, in the write that stores the parent's prompt); `follow_said`: the line that report holds for
// them ("" when the report holds none: the run started after it went).
export type BeforeRun = { id: number; session_id: string; key: string; repo: string; base: string | null; merge_base: string | null; common: string | null; unconfined: string | null; note?: string | null; follow_agent?: string | null; follow_said?: string | null; state: "running" | "done"; why: string | null; results: FileResult[]; created: number; ended: number | null };
type Row = Omit<BeforeRun, "results"> & { results: string };

// `confine`: the session's own sandbox profile with `workspace` in the place of its folder and `tool` as its tool
// folder (the gate's confineFor), or undefined when its commands run unconfined.
type Deps = {
  store: Store; bus: Bus; capture: (e: unknown, ctx: object) => void;
  perm: (sessionId: string) => { mode: string; sandbox: string } | undefined;
  // `shown`: more folders the run reads (the base's packages, src/checks/package-cache.ts), each in a layer of the
  // run's own where overlays mount (`layered`: what the run writes there stays out of them), else read-only.
  confine: (sessionId: string, workspace: string, tool: string, shown?: string[]) => { wrap: (argv: string[]) => string[]; sandbox: string; network?: boolean; layered?: boolean } | undefined;
};
let d: Deps | undefined;
const dir = () => join(d!.store.stateDir, ...BEFORE_DIR);
// Bytes of output read from one file's run: enough for the summary and the first error.
const OUT_MAX = 256 * 1024;

// The table, and what a restart cut: a run that was going is ended, its open
// files say why, and its scratch worktrees go (the promise: when they have).
export function bindBefore(deps: Deps): Promise<void> {
  d = deps;
  d.store.migrate(SCHEMA);
  for (const col of ["common", "unconfined", "note", "follow_agent", "follow_said"]) if (!d.store.columnExists("fails_before", col)) d.store.migrate(`ALTER TABLE fails_before ADD COLUMN ${col} TEXT`);
  const cut = d.store.db.query<Row, []>("SELECT * FROM fails_before WHERE state = 'running'").all().filter((r) => !going.has(r.id));
  for (const r of cut) {
    const results = (JSON.parse(r.results) as FileResult[]).map((f) => (f.state === "running" || f.state === "waiting" ? { ...f, state: "unrun" as const, why: "the daemon restarted while it ran" } : f));
    d.store.db.query("UPDATE fails_before SET state = 'done', results = ?, ended = ? WHERE id = ?").run(JSON.stringify(results), Date.now(), r.id);
  }
  return Promise.all([sweep(), stopLeftScopes(), cache.bindCache(d.store)]).then(() => {}, (e) => d!.capture(e, { at: "fails before sweep" }));
}

// A file's run outside the sandbox goes in a scope named for the daemon that started it (keel-before-<pid>-..., and
// keel-beside-<pid>-... for a check run beside an agent, src/checks/beside-run.ts):
// one a killed daemon left, with what it started, is stopped. Its own time limit (RuntimeMaxSec) ends it in any
// case; this ends it at the next start. (A run in the sandbox ends with the daemon: bwrap dies with its parent.)
async function stopLeftScopes() {
  if (!sandboxStatus().scope || !Bun.which("systemctl")) return;
  const ls = Bun.spawn(["systemctl", "--user", "list-units", "--plain", "--no-legend", "--all", "keel-before-*.scope", "keel-beside-*.scope"], { stdout: "pipe", stderr: "ignore" });
  const out = await readText(ls.stdout, "systemctl list-units");
  await ls.exited;
  const units = leftScopes(out, (pid) => pid === process.pid || alive(pid));
  for (const u of units) await Bun.spawn(["systemctl", "--user", "stop", u], { stdout: "ignore", stderr: "ignore" }).exited.catch(() => {});
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
// The units of `systemctl list-units` output whose daemon is not alive.
export function leftScopes(out: string, alive: (pid: number) => boolean): string[] {
  return out.split("\n").map((l) => /^\s*(keel-(?:before|beside)-(\d+)-\d+-\d+\.scope)\b/.exec(l)).filter((m): m is RegExpExecArray => !!m && !alive(Number(m[2]))).map((m) => m[1]!);
}

// Runs whose answers an agent's report owes its parent and that have them (the run ended, or a restart cut it).
export const owedFollows = (): BeforeRun[] => d ? d.store.db.query<Row, []>("SELECT * FROM fails_before WHERE follow_agent IS NOT NULL AND state = 'done' ORDER BY id").all().map(toRun) : [];
// The report of `agent` went while files of the run were open, and holds `said` for them (stored with the report).
export const owe = (id: number, agent: string, said: string) => { d?.store.db.query("UPDATE fails_before SET follow_agent = ?, follow_said = ? WHERE id = ?").run(agent, said, id); };
// Told: in the write that stores the parent's prompt.
export const followed = (id: number) => { d?.store.db.query("UPDATE fails_before SET follow_agent = NULL, follow_said = NULL WHERE id = ?").run(id); };
export const byId = (id: number): BeforeRun | undefined => { const r = d?.store.db.query<Row, [number]>("SELECT * FROM fails_before WHERE id = ?").get(id); return r ? toRun(r) : undefined; };

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
    // (A run's tool folder can hold an overlay's work folder the kernel made with no access: opened first.
    // One that cannot be removed is said and left; the others, and the prune, go on.)
    try {
      if (n.endsWith(".tool")) openLayers(join(dir(), n));
      rmSync(join(dir(), n), { recursive: true, force: true });
    } catch (e) { d!.capture(e, { at: "fails before sweep", path: n }); }
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
  d!.store.db.query("UPDATE fails_before SET state = ?, why = ?, unconfined = ?, note = ?, results = ?, ended = ? WHERE id = ?").run(r.state, r.why, r.unconfined, r.note ?? null, JSON.stringify(r.results), r.ended, r.id);
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
  // (A file that could not run is run again, unless what stopped it was the base's install, which failed for its
  // lockfile a short while ago: the same answer, at once.)
  if (had && !o.again && (JSON.parse(had.results) as FileResult[]).every((f) => f.state !== "unrun" || (f.install && cache.lookup(f.install)?.state === "failed"))) return toRun(had);
  const results: FileResult[] = tests.map((t, i) => ({ path: t.path, check: t.check.name, command: files[i]!.command, state: "waiting", why: "", exit: null, ms: null, cpu_ms: null }));
  const why = !baseName ? "no base branch to compare with" : !mb ? `no merge base with ${baseName}` : null;
  const id = Number(d.store.db.query("INSERT INTO fails_before (session_id, key, repo, base, merge_base, common, state, why, results, created) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)")
    .run(sessionId, key, repo.top, baseName ?? null, mb, repo.common, why, JSON.stringify(results), Date.now()).lastInsertRowid);
  const run: BeforeRun = { id, session_id: sessionId, key, repo: repo.top, base: baseName ?? null, merge_base: mb, common: repo.common, unconfined: null, state: "running", why, results, created: Date.now(), ended: null };
  if (why) { run.results = results.map((r) => ({ ...r, state: "unrun", why })); run.state = "done"; run.ended = Date.now(); save(run); return run; }
  save(run);
  const lane = lanes.get(repo.common) ?? Promise.resolve();
  const p = lane.then(() => execute(run, repo, tests.map((t, i) => ({ ...t, bytes: files[i]!.bytes })), !!o.again))
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

async function execute(run: BeforeRun, repo: Repo, tests: (ReturnType<typeof testsOf>[number] & { bytes: Uint8Array | null })[], again: boolean): Promise<BeforeRun> {
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
  const held: string[] = [];
  try {
    try { await worktreeGit(top, ["worktree", "add", "--detach", scratch, run.merge_base!]); }
    catch (e) { run.results = run.results.map((r) => ({ ...r, state: "unrun", why: `the base could not be checked out: ${(e as Error).message.slice(0, 120)}` })); return run; }
    // Only the test files are applied.
    for (const t of tests) { mkdirSync(dirname(join(scratch, t.path)), { recursive: true }); writeFileSync(join(scratch, t.path), t.bytes ?? new Uint8Array()); }
    const own = ofSession(run.session_id, 0);
    let wrap = confined?.wrap;
    // (CI: a runner that would watch for changes runs once.)
    const env: Record<string, string> = { ...toolEnv(run.session_id), CI: "1" };
    // The base's packages, once per check folder, before any of its files runs.
    const pkgs = new Map<string, Packages>();
    const dirs = [...new Set(tests.map((t) => t.check.dir))];
    // (In the sandbox, a source's packages are linked only when the session's own sandbox reads them.)
    const readable = wrap ? (p: string) => readsIn(wrap!, p, scratch) : undefined;
    for (let k = 0; k < dirs.length; k++) {
      const got = await packagesFor({ scratch, checkDir: dirs[k]!, sources: [repo.top, top], path: env.PATH ?? "", common: repo.common, again, readable, how: confined ? `${confined.sandbox}${confined.network ? "+network" : ""}` : "unconfined" }, (cwd, command) =>
        runOne({ cwd, tool, env, command, limitMs: INSTALL_MS, wrap, unit: `keel-before-${process.pid}-${run.id}-${tests.length + k}` }));
      if (got.held) held.push(got.held);
      pkgs.set(dirs[k]!, got);
    }
    // The packages a run reads that are not in its checkout are out of its reach where it runs in the sandbox: in a
    // layer of its own where overlays mount (it writes into them as into its own, and nothing it writes reaches
    // them), else read-only (a file that fails writing under them could not run here). (Out of the sandbox, the
    // run has the session's own reach: it could write them, as the session's own commands could.)
    const shown = [...new Set([...pkgs.values()].flatMap((p) => p.shown ?? []))];
    if (confined && shown.length) {
      const c = d!.confine(run.session_id, scratch, tool, shown);
      if (c) wrap = c.wrap;
      if (!c?.layered) for (const p of pkgs.values()) if (p.shown?.length) p.readOnly = true;
    }
    run.note = [...pkgs.values()].find((p) => p.note)?.note ?? null;
    const handled = new Set([...pkgs.values()].flatMap((p) => (p.modules ? [p.modules] : [])));
    // What a check reads that is not in the tree (an install named in its inputs) is the folder's own, linked,
    // unless it is the packages of a lockfile the base has: those are the base's own (above).
    for (const c of new Set(tests.map((t) => t.check))) for (const input of c.inputs) {
      const first = input.split("/").find((p) => p && p !== ".");
      if (!first || first === ".." || handled.has(first)) continue;
      const from = join(repo.top, first), to = join(scratch, first);
      if (existsSync(from) && !existsSync(to)) try { symlinkSync(from, to); } catch {} // one at a time: it is there
    }
    for (let i = 0; i < tests.length; i++) {
      const t = tests[i]!;
      run.results[i] = { ...run.results[i]!, state: "running" };
      save(run);
      const mine = own.filter((r) => r.command.includes(t.path.split("/").pop()!)).map((r) => r.ended - r.started);
      const cwd = t.check.dir === "." ? scratch : join(scratch, t.check.dir);
      const missing = !existsSync(cwd) ? `the check's folder ${t.check.dir} is not on the base`
        : missingOnBase(t.check.run, { file: (f) => existsSync(join(cwd, f)), onPath: (n) => !!Bun.which(n, { PATH: env.PATH ?? "", cwd }) });
      const pk = pkgs.get(t.check.dir);
      // (A check whose packages the base's install could not make does not run: it says why at once.)
      if (!missing && pk?.failed) { run.results[i] = { ...run.results[i]!, state: "unrun", why: pk.why!, install: pk.failed }; save(run); continue; }
      run.results[i] = { ...run.results[i]!, ...(missing ? { state: "unrun" as const, why: missing } : await runOne({ cwd, tool, env, command: run.results[i]!.command, limitMs: limitFor(mine), wrap, unit: `keel-before-${process.pid}-${run.id}-${i}`, session: run.session_id }, pkgs.get(t.check.dir))) };
      save(run);
    }
    return run;
  } finally {
    for (const k of held) cache.release(k);
    await worktreeGit(top, ["worktree", "remove", "--force", scratch], { ok: true }).catch(() => {});
    // (Off the loop: a checkout whose install could not be kept holds its packages.)
    await rm(scratch, { recursive: true, force: true });
    openLayers(tool);
    rmSync(tool, { recursive: true, force: true });
  }
}

// The kernel leaves a folder with no permissions in an overlay's work folder (the run's layers, in its tool
// folder): opened up, so the tool folder can go.
function openLayers(tool: string) {
  let names: string[] = [];
  try { names = readdirSync(join(tool, "layers")); } catch { return; } // the run had none
  for (const n of names) try { chmodSync(join(tool, "layers", n, "work", "work"), 0o700); } catch {} // none made: nothing written
}

// The main checkout of a repository (its worktree commands go one after another there).
export const mainTop = (repo: Repo) => (repo.common.endsWith("/.git") ? dirname(repo.common) : repo.top);

// How long the base's own install may take: a cold `npm ci` of a large project takes minutes, one from a warm
// cache seconds. Its scope ends it in any case.
export const INSTALL_MS = 600_000;

// The base's packages for a check's folder in the scratch checkout. `modules`: the packages folder this decided
// (relative to the checkout), linked or installed or neither; `declared`: what the base's package.json files
// from the check's folder up to the top name; `why`: why the packages are not there, when they are not;
// `failed`: the install key whose install failed (the check's files do not run); `shown`: folders out of the
// checkout the run reads them from; `held`: the cache entry the run holds until its end; `note`: what the
// report's line says of them (installed for this run only).
export type Packages = BasePackages & { modules?: string; failed?: string; shown?: string[]; held?: string; note?: string };
const bytesOf = async (p: string): Promise<Uint8Array | null> => { try { return await Bun.file(p).bytes(); } catch { return null; } };
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

// Packages installed in a source folder (the session's own, the repository's main checkout) from the same
// lockfile as the base's are linked: the lockfile compared is the one next to the folder the packages really are
// (a source's own packages may be a link to another checkout's). In the sandbox only a source the session's own
// sandbox reads (`readable`). Else the cache's entry of the lockfile is linked (src/checks/package-cache.ts),
// else the base's own install runs in the scratch checkout, in the run's sandbox and at its priority, within
// INSTALL_MS, and what it made becomes the entry. An install that failed is the answer for its lockfile for a
// while (cache.FAILED_MS), unless `again` (the owner's Run again). Never an install through a link: it would
// rewrite the source's packages under whoever uses them.
// `how`: how the install runs (in which sandbox profile, with the network or not), which its failure is known by.
export type PkgIn = { scratch: string; checkDir: string; sources: string[]; path: string; common: string; again: boolean; how: string; readable?: (p: string) => Promise<boolean> };
export async function packagesFor(o: PkgIn, install: (cwd: string, command: string) => Promise<Partial<FileResult>>): Promise<Packages> {
  const { scratch, checkDir } = o;
  const texts: string[] = [];
  const parts = checkDir === "." ? [] : checkDir.split("/").filter(Boolean);
  for (let n = parts.length; n >= 0; n--) { const t = await bytesOf(join(scratch, ...parts.slice(0, n), "package.json")); if (t) texts.push(new TextDecoder().decode(t)); }
  const declared = declaredOf(texts);
  if (!declared.size) return { declared };
  const at = lockDirOf(checkDir, (p) => existsSync(join(scratch, p)));
  if (!at) return { declared, why: "the base has no lockfile to install them from" };
  const modules = at.dir === "." ? "node_modules" : `${at.dir}/node_modules`;
  const to = join(scratch, modules);
  if (existsSync(to)) return { declared, modules }; // committed on the base
  const want = await bytesOf(join(scratch, at.dir, at.lock.file));
  for (const src of [...new Set(o.sources)]) {
    let real: string;
    try { real = realpathSync(join(src, modules)); } catch { continue; } // none there
    const have = await bytesOf(join(dirname(real), at.lock.file));
    if (!want || !have || !sameBytes(want, have)) continue;
    if (o.readable && !(await o.readable(real))) continue; // the sandbox does not show them: the cache's, or an install
    try { symlinkSync(real, to); return { declared, modules, shown: [real] }; } catch (e) { return { declared, modules, why: `they could not be linked: ${(e as Error).message}` }; }
  }
  const lockDir = join(scratch, at.dir);
  const key = want ? cache.cacheKey(o.common, at.dir, at.lock.file, want) : undefined;
  const hit = key ? cache.lookup(key) : undefined;
  const fkey = key ? cache.failedKey(key, o.how) : undefined;
  const fail = fkey ? cache.lookup(fkey) : undefined;
  if (key && hit?.state === "ok") {
    cache.hold(key);
    try { cache.linkInto(key, hit, lockDir); return { declared, modules, shown: [hit.dir], held: key }; }
    catch (e) { return { declared, modules, why: (e as Error).message, held: key }; }
  }
  if (fkey && fail?.state === "failed" && !o.again) return { declared, modules, failed: fkey, why: failedWhy(fail.why, fail.at) };
  const program = needsOf(at.lock.install).program;
  if (!Bun.which(program, { PATH: o.path })) return { declared, modules, why: `no installed packages match its ${at.lock.file}, and ${program} is not here to install them` };
  // What is untracked in the checkout before the install: what it adds besides packages folders keeps it from the cache.
  const pre = key ? await untracked(scratch) : undefined;
  const r = await install(lockDir, at.lock.install);
  if (r.exit !== 0) {
    const why = `${at.lock.install}: ${r.why || `exit ${r.exit}`}`;
    if (!fkey) return { declared, modules, why: `its install (${at.lock.install}) did not finish: ${r.why || `exit ${r.exit}`}` };
    cache.failed(fkey, o.common, join(at.dir, at.lock.file), why);
    return { declared, modules, failed: fkey, why: failedWhy(why) };
  }
  if (!key) return { declared, modules };
  // An install that writes out of its packages folders (a postinstall's generated file, a built folder) is not
  // kept: a later run would link the packages without what it wrote. It runs again for each run.
  const post = pre === undefined ? undefined : await untracked(scratch);
  const outside = pre !== undefined && post !== undefined ? cache.madeOutside(pre, post) : undefined;
  if (!outside) return { declared, modules };
  if (outside.length) return { declared, modules, note: `with the base's packages installed for this run only (its install writes out of node_modules: ${outside.slice(0, 2).join(", ")}${outside.length > 2 ? ` and ${outside.length - 2} more` : ""}, so they are not kept)` };
  // What it made is kept for the next run of this lockfile, and linked back here.
  const listed = await git(lockDir, ["ls-files", "-o", "--directory", "-z"], { read: true, timeout: 60_000 }).catch(() => undefined);
  cache.hold(key);
  // (Kept or not, the packages are in the checkout for this run: linked back, or where the install made them.)
  try {
    const kept = listed?.code === 0 ? await cache.adopt(key, { repo: o.common, lock: join(at.dir, at.lock.file) }, scratch, lockDir, cache.foldersOf(listed.out)) : undefined;
    return { declared, modules, held: key, ...(kept ? { shown: [kept.dir] } : {}) };
  } catch (e) { return { declared, modules, held: key, why: `the installed packages could not be kept: ${(e as Error).message}` }; }
}

// What git lists as untracked in a checkout out of its packages folders (ignored files too), or undefined when it
// could not tell.
async function untracked(scratch: string): Promise<string | undefined> {
  const l = await git(scratch, ["ls-files", "-o", "-z", "-x", "node_modules"], { read: true, timeout: 60_000 }).catch(() => undefined);
  return l?.code === 0 ? l.out : undefined;
}

// The words of an install that failed: now, or `at` (remembered for its lockfile).
const failedWhy = (why: string, at?: number) => clipWhy(`the base's install failed${at ? ` ${Math.max(1, Math.round((Date.now() - at) / 60_000))} min ago (tried again ${Math.round(cache.FAILED_MS / 60_000)} min after it, or now by Run again)` : ""}: ${why}`, FAILED_WHY_MAX);
// (Its words hold the install's own error after them.)
const FAILED_WHY_MAX = 320;

// Whether the session's own sandbox (`wrap`, for the scratch checkout) shows a folder's entries.
export async function readsIn(wrap: (argv: string[]) => string[], p: string, cwd: string): Promise<boolean> {
  try {
    const c = Bun.spawn(wrap(["/bin/sh", "-c", '[ -n "$(ls -A "$1" 2>/dev/null | head -n 1)" ]', "probe", p]), { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const t = setTimeout(() => c.kill("SIGKILL"), 30_000);
    const code = await c.exited;
    clearTimeout(t);
    return code === 0;
  } catch { return false; }
}

// How long the output of a run is still read after its end: what a process it started outside its group still
// holds open (a `setsid` child) is not waited for after that.
export const DRAIN_MS = 2_000;
// Seconds a run's scope may outlive the run's own limit: its kill and the read of its pipes (DRAIN_MS), with room.
const SCOPE_SLACK_S = 10;

// One file's run. A run that is not in the sandbox (whose processes all end with it: its own process space) runs
// in a systemd scope of its own when the machine has them, so what it started goes with it, also a process that
// left its group. Its process group goes at its end in any case, also after a normal exit.
// `session`: whose run it is; while it runs, a request it makes to the daemon's API has that session's authority only.
// `mark`: the kind its processes are marked with (src/tools/jobs.ts sessionMark).
type One = { cwd: string; tool: string; env: Record<string, string>; command: string; limitMs: number; wrap?: (argv: string[]) => string[]; unit: string; session?: string; mark?: string };
export async function runOne(o: One, base?: BasePackages): Promise<Partial<FileResult>> {
  const r = await runCommand(o);
  if ("error" in r) return { state: "unrun", why: `it could not start: ${r.error}`, exit: null };
  const v = verdictOf({ code: r.timedOut ? null : r.code, signal: r.signal, timedOut: r.timedOut, limitMs: o.limitMs, out: r.out }, base);
  return { ...v, exit: r.timedOut ? null : r.code, ms: r.ms, cpu_ms: r.cpu_ms };
}

// A command run as one file's run is (above): its status, the end of its output (OUT_MAX), how long it took and
// its processor time. `error`: it could not start.
export type Ran = { code: number | null; signal: string | null; timedOut: boolean; out: string; ms: number; cpu_ms: number | null };
export async function runCommand(o: One): Promise<Ran | { error: string }> {
  const times = join(o.tool, TIMES_FILE);
  rmSync(times, { force: true });
  const argv = [...LOW(), "bash", "-c", withTimes(o.command, times)];
  const scoped = !o.wrap && sandboxStatus().scope && scopeHead().length > 0;
  // (Its scope ends by its own time limit too, a little after the run's: what a killed daemon left goes by itself.)
  const full = o.wrap ? o.wrap(argv) : scoped ? [...scopeHead(), `--unit=${o.unit}`, "-p", `RuntimeMaxSec=${Math.ceil(o.limitMs / 1000) + SCOPE_SLACK_S}`, "--", ...argv] : argv;
  const started = performance.now();
  let timedOut = false;
  let p: ReturnType<typeof Bun.spawn>;
  const slice = scoped ? jobScope().slice : undefined;
  const mark = o.session ? sessionMark(o.session, o.mark ?? "before", slice ? `/sys/fs/cgroup${slice}/${o.unit}.scope` : undefined) : undefined;
  try { p = Bun.spawn(full, { cwd: o.cwd, env: { ...o.env, ...mark?.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true }); }
  catch (e) { return { error: (e as Error).message }; }
  if (mark) {
    const release = mark.hold(p.pid);
    void p.exited.then(release, release);
  }
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
  return { code, signal: timedOut || p.signalCode == null ? null : String(p.signalCode), timedOut, out: out.slice(-OUT_MAX), ms, cpu_ms };
}
