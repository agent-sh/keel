// The checks beside an agent at work (the decisions are in src/checks/beside.ts).
// After a step of an agent's turn that may have changed its files, its lane
// waits out the window, then its tree is taken (the ledger's look,
// src/checks/ledger.ts) and, when the tree is new, a copy of it is checked out
// in a folder of Keel's own (one per agent, updated in place: only the files
// that changed are written), with the agent's installed packages (a check's
// `inputs`) linked in. The repository's `beside` checks run there one after
// another, off the loop, at a low priority, behind every other command of the
// heavy pool (src/tools/heavy.ts, "beside"), in the agent's own sandbox (or
// on the owner's host, when this machine has no room and one is set). Each run
// is a row of the ledger on that tree; a red one reaches the agent as one
// harness input, sent as a message of the harness's (agents.send), which a
// working agent takes at its next step.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { settings } from "../admin/settings.ts";
import { localTime } from "../core/clock.ts";
import { git } from "../core/git.ts";
import { contains } from "../core/paths.ts";
import { readText } from "../core/proc.ts";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import { pool } from "../tools/heavy.ts";
import { toolEnv } from "../tools/jobs.ts";
import { howToRun, limitFor, LOCKS, quote } from "./before.ts";
import { runCommand, type Ran } from "./before-run.ts";
import { BESIDE_DIR, besideOf, changed, commandOf, dueAt, failureOf, finished, fresh, hostLoadOf, noticeText, placeOf, scratchName, started, testFilesOf, testsFor, toTell, turnEnded, WINDOW_MS, type Lane, type Red } from "./beside.ts";
import { countsOf } from "./counts.ts";
import { baseFor } from "./runs.ts";
import { baseOf, inputsOf, keyOf, namedFor, objectsOf, ofSession, onTree, record, repoOf, treeOf, type Repo } from "./ledger.ts";
import type { Check } from "./named.ts";

type Deps = {
  store: Store; capture: (e: unknown, ctx: object) => void;
  perm: (sessionId: string) => { mode: string; sandbox: string } | undefined;
  confine: (sessionId: string, workspace: string, tool: string) => { wrap: (argv: string[]) => string[]; sandbox: string } | undefined;
  // The agent of a session, when it is one's, and whether it still works (an ended one's copy goes after its run).
  agentOf: (sessionId: string) => { live: boolean } | undefined;
  // The harness input to the agent: stored once under `key`.
  tell: (sessionId: string, text: string, key: string) => Promise<void>;
};
let d: Deps | undefined;
const dir = () => join(d!.store.stateDir, ...BESIDE_DIR);

// Kept by the process, not the module: a module loaded again (a dev daemon's reload) keeps the lanes.
const kept = ((globalThis as any).__keelBeside ??= { lanes: new Map(), timers: new Map(), dirty: new Set(), stats: { runs: 0, cpu_ms: 0, ms: 0, told: 0, skipped: 0 } }) as {
  lanes: Map<string, Lane>; timers: Map<string, ReturnType<typeof setTimeout>>; dirty: Set<string>;
  stats: { runs: number; cpu_ms: number; ms: number; told: number; skipped: number };
};
const { lanes, timers, dirty, stats } = kept;
// What the checks beside agents cost since the daemon started (the resources view reads it).
export const besideStats = () => ({ ...stats, lanes: lanes.size, running: [...lanes.values()].filter((l) => l.running).length });

// The owner's setting (checks.beside): the window, and a host to run on when this machine has no room.
type Setting = { window_s: number; host: string | null; host_path: string[] };
export function setting(): Setting {
  const b = (settings().checks?.beside ?? {}) as Partial<Setting>;
  return { window_s: typeof b.window_s === "number" ? b.window_s : WINDOW_MS / 1000, host: typeof b.host === "string" && b.host ? b.host : null, host_path: Array.isArray(b.host_path) ? b.host_path.filter((p) => typeof p === "string") : [] };
}
export function checkSetting(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "beside is an object (window_s, host, host_path)";
  const b = v as Record<string, unknown>;
  if (b.window_s !== undefined && !(typeof b.window_s === "number" && b.window_s >= 0 && b.window_s <= 3600)) return "beside.window_s is seconds, 0 to 3600";
  if (b.host !== undefined && b.host !== null && !(typeof b.host === "string" && /^[\w.@-]{1,120}$/.test(b.host))) return "beside.host is an ssh host name, or null";
  if (b.host_path !== undefined && !(Array.isArray(b.host_path) && b.host_path.every((p) => typeof p === "string" && /^[\w./~$-]{1,200}$/.test(p)))) return "beside.host_path is a list of folders on the host's PATH";
  return undefined;
}

// What a restart left: the copies of the files go (they are made again from the tree).
export function bindBeside(deps: Deps) {
  d = deps;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  // (A lane that was running belongs to a module loaded before: its run still ends it.)
  try { for (const n of readdirSync(dir())) if (![...lanes.keys()].some((id) => n.startsWith(scratchName(id)))) rmSync(join(dir(), n), { recursive: true, force: true }); } catch {} // none yet
  // Logs a week old go.
  try { for (const n of readdirSync(join(dir(), "..", "beside-logs"))) { const p = join(dir(), "..", "beside-logs", n); if (Date.now() - statSync(p).mtimeMs > 7 * 86400_000) rmSync(p, { force: true }); } } catch {} // none yet
}

// The checks beside a session's agent, when its repository names any.
function namedBeside(s: Session): { repo: Repo; checks: Check[] } | undefined {
  const repo = repoOf(s.workspace);
  const checks = repo ? besideOf(namedFor(repo)?.checks ?? []) : [];
  return repo && checks.length ? { repo, checks } : undefined;
}
const isAgent = (s: Session) => !!s.parent_id && !s.machine && !!d?.agentOf(s.id);

// A call that may have changed files: an edit, a patch, a command.
export function afterCall(s: Session, call: ToolCall) {
  if (!d || !isAgent(s)) return;
  if (call.tool.kind === "edit" || call.tool.kind === "shell" || call.tool.appliesPatch) dirty.add(s.id);
}
// A step ended: when it may have changed files, the window starts (or goes on).
export function afterStep(s: Session) {
  if (!d || !dirty.delete(s.id)) return;
  if (!namedBeside(s)) return;
  lanes.set(s.id, changed(lanes.get(s.id) ?? fresh(), Date.now()));
  schedule(s.id);
}
export function afterTurn(s: Session) {
  if (!d) return;
  const l = lanes.get(s.id);
  if (!l) return;
  lanes.set(s.id, turnEnded(l));
  schedule(s.id);
}
// A session that is gone: its lane and its copy go.
export function forget(sessionId: string) {
  clearTimeout(timers.get(sessionId));
  timers.delete(sessionId);
  dirty.delete(sessionId);
  if (lanes.get(sessionId)?.running) return; // its run removes them when it ends
  lanes.delete(sessionId);
  if (d) void rm(join(dir(), scratchName(sessionId)), { recursive: true, force: true }).catch(() => {});
}

function schedule(id: string) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const l = lanes.get(id);
  const due = l ? dueAt(l, setting().window_s * 1000) : null;
  if (due === null) return;
  const t = setTimeout(() => { timers.delete(id); go(id); }, Math.max(0, due - Date.now()));
  (t as any).unref?.();
  timers.set(id, t);
}

function go(id: string) {
  const l = lanes.get(id);
  if (!l || l.running) return;
  lanes.set(id, started(l));
  let tree: string | null = null, told: string | null | undefined;
  void run(id).then((r) => { tree = r.tree; told = r.told; }, (e) => d?.capture(e, { at: "checks beside", session: id })).finally(() => {
    const now = lanes.get(id);
    if (!now) return;
    lanes.set(id, finished(now, tree, told));
    // An ended agent's copy goes; the next change makes it again.
    if (!d?.agentOf(id)?.live && lanes.get(id)!.first === null) { lanes.delete(id); void rm(join(dir(), scratchName(id)), { recursive: true, force: true }).catch(() => {}); return; }
    schedule(id);
  });
}

// One run of a lane: the tree it checked (null: none was read) and the failure told (undefined: as it was).
async function run(id: string): Promise<{ tree: string | null; told?: string | null }> {
  const s = d!.store.session(id);
  if (!s || s.archived) return { tree: null };
  const named = namedBeside(s);
  if (!named) return { tree: null };
  const { repo, checks } = named;
  const lane = lanes.get(id)!;
  const look = await treeOf(repo);
  if (!look?.tree) return { tree: null };
  const tree = look.tree;
  if (tree === lane.tree) { stats.skipped++; return { tree }; }
  const at = Date.now();
  const scratch = join(dir(), scratchName(id));
  const tool = `${scratch}.tool`;
  const files = await copyTree(repo, tree, look.head, scratch, checks);
  if (!files) return { tree };
  const touched = await changedFiles(repo, tree, look.head, scratch);
  // Nothing of the agent's own: the files are the base's, which are not its to fix.
  if (!touched.length) { stats.skipped++; return { tree }; }
  const textOf = (p: string) => { try { return readFileSync(join(scratch, p), "utf8"); } catch { return undefined; } };
  const reds: Red[] = [];
  const ran: string[] = [];
  let where: string | undefined;
  for (const check of checks) {
    const tests = check.tests?.length ? testsFor(touched, testFilesOf(check, files), textOf) : [];
    if (check.tests?.length && !tests.length) continue; // the change touches none of its tests
    const command = commandOf(check, tests);
    const key = keyOf(check.dir, command);
    const inputs = inputsOf(repo.top, check.inputs) ?? null;
    // Run on these files already (by the agent itself, or before): not again.
    if (onTree(key, tree, inputs).length) { stats.skipped++; continue; }
    const t0 = Date.now();
    const r = await runCheck(id, s, check, command, scratch, tool);
    if (!r) continue;
    ran.push(tests.length ? `${check.name} (${tests.length} test file${tests.length === 1 ? "" : "s"})` : check.name);
    if (r.where) where = r.where;
    stats.runs++;
    stats.ms += r.ran.ms;
    stats.cpu_ms += r.ran.cpu_ms ?? 0;
    const counts = countsOf(r.ran.out);
    const result = r.ran.timedOut || r.ran.signal ? "stopped" : r.ran.code === 0 ? "pass" : "fail";
    const row = record({ name: check.name, command, dir: check.dir, repo: repo.scope, tree, head: look.head, session_id: id, call_id: null, by: "beside", result, exit: r.ran.timedOut ? null : r.ran.code, pass: counts?.pass ?? null, fail: counts?.fail ?? null, started: t0, ended: Date.now(), log: r.log, from_run: null, inputs, top: repo.top });
    if (result !== "fail") continue;
    // How it fares on the base, when the ledger knows: a check red there too is not the change's.
    const base = row ? await baseFor(row, repo).catch(() => undefined) : undefined;
    reds.push({ name: check.name, command, exit: r.ran.code, pass: counts?.pass ?? null, fail: counts?.fail ?? null, failure: failureOf(r.ran.out), ...(base && !base.startsWith("not run on") ? { base } : {}) });
  }
  // Every check that ran passed: nothing is said, and a failure found again later is told again.
  if (!ran.length) return { tree };
  const t = toTell(lanes.get(id) ?? lane, reds);
  if (!reds.length) return { tree, told: null };
  if (!t.tell) return { tree, told: t.told };
  const text = noticeText(reds, { tree, at: localTime(at).slice(0, 5), ran, where });
  await d!.tell(id, text, `beside:${tree}`).then(() => { stats.told++; }, (e) => d!.capture(e, { at: "checks beside: telling the agent", session: id }));
  return { tree, told: t.told };
}

// One check on the copy: on this machine through the heavy pool (behind every other command), or on the
// owner's host when this machine has no room and one is set. Undefined: it could not run (said nowhere:
// the agent's own run of the check says what it says).
async function runCheck(id: string, s: Session, check: Check, command: string, scratch: string, tool: string): Promise<{ ran: Ran; log: string; where?: string } | undefined> {
  const cwd = check.dir === "." ? scratch : join(scratch, check.dir);
  if (!existsSync(cwd)) return undefined;
  // What the session's own runs of this check took (three times that, at least two minutes).
  const own = ofSession(id, 0, 200).filter((r) => r.name === check.name && (r.result === "pass" || r.result === "fail")).map((r) => r.ended - r.started);
  const limitMs = limitFor(own);
  const cfg = setting();
  const heavy = pool.heavy(command);
  const localFree = !heavy || pool.room(heavy.cost).free > 0;
  const hostLoad = !localFree && cfg.host ? hostLoadOf(await sshOut(cfg.host, "cat /proc/loadavg; nproc", 15_000).catch(() => "")) : undefined;
  const place = placeOf({ localFree, host: cfg.host, hostLoad, share: 0.83 });
  let ran: Ran | { error: string };
  if (place === "host") ran = await onHost(cfg, id, scratch, check, command, limitMs, linksOf([check]));
  else {
    // In the agent's own sandbox, as its own commands run: never with more reach than they have.
    const confined = d!.confine(id, scratch, tool);
    if ("refused" in howToRun(d!.perm(id), confined)) return undefined;
    const slot = await pool.take({ session: id, who: "beside", command });
    if (slot === "aborted") return undefined;
    mkdirSync(tool, { recursive: true });
    try {
      ran = await runCommand({ cwd, tool, env: { ...toolEnv(id), CI: "1" }, command, limitMs, wrap: confined?.wrap, unit: `keel-beside-${process.pid}-${Date.now() % 1_000_000}-${stats.runs}`, session: s.id, mark: "beside" });
    } finally { slot?.release(); }
  }
  if ("error" in ran) return undefined;
  const logs = join(dir(), "..", "beside-logs");
  mkdirSync(logs, { recursive: true });
  const log = join(logs, `${scratchName(id)}-${check.name.replace(/[^\w.-]/g, "_")}-${Date.now()}.log`);
  writeFileSync(log, `$ ${command}\n${ran.out}`);
  return { ran, log, ...(place === "host" ? { where: cfg.host! } : {}) };
}

// --- the copy of the files

const ownGit = (scratch: string, args: string[], o: { input?: string; timeout?: number } = {}) =>
  git(scratch, args, { mode: "own", gitDir: join(scratch, ".git"), workTree: scratch, timeout: o.timeout ?? 120_000, input: o.input });

// The tree checked out in Keel's own folder for the agent: a repository of its own whose objects are the
// repository's and the ledger's (through alternates), with the agent's commit as its HEAD, so a check that
// asks git sees the agent's files as changes over it. Only what differs from the last copy is written;
// what a check left there goes. The links to the check's inputs (installed packages) point at the
// agent's own. The tree's files, from the top; undefined when it could not be made.
// The first folder of each input a check names (`node_modules` of `node_modules/../bun.lock`): linked into the copy.
const linksOf = (checks: readonly Check[]) => [...new Set(checks.flatMap((c) => c.inputs.map((i) => i.split("/").find((p) => p && p !== ".") ?? "")).filter((p) => p && !isAbsolute(p) && contains("/top", join("/top", p))))];
async function copyTree(repo: Repo, tree: string, head: string | null, scratch: string, checks: readonly Check[]): Promise<string[] | undefined> {
  const objects = objectsOf(repo);
  const links = linksOf(checks);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!existsSync(join(scratch, ".git", "HEAD"))) {
        await rm(scratch, { recursive: true, force: true });
        mkdirSync(scratch, { recursive: true });
        const init = await git(scratch, ["init", "-q"], { mode: "plain", timeout: 30_000 });
        if (init.code !== 0) throw new Error(`git init: ${init.err.trim()}`);
      }
      writeFileSync(join(scratch, ".git", "objects", "info", "alternates"), `${join(repo.common, "objects")}\n${objects ? `${objects}\n` : ""}`);
      const steps: string[][] = [["read-tree", "--reset", "-u", tree], ["update-index", "-q", "--refresh"]];
      for (const a of steps) { const r = await ownGit(scratch, a); if (r.code !== 0 && a[0] !== "update-index") throw new Error(`git ${a[0]}: ${r.err.trim().split("\n").at(-1)}`); }
      // Files a check changed since the last copy are written again.
      const mod = await ownGit(scratch, ["diff-files", "--name-only", "-z"]);
      if (mod.out) { const r = await ownGit(scratch, ["checkout-index", "-f", "-z", "--stdin"], { input: mod.out }); if (r.code !== 0) throw new Error(`git checkout-index: ${r.err.trim()}`); }
      // What a check left that is not in the tree goes (the links stay).
      await ownGit(scratch, ["clean", "-fdxq", ...links.flatMap((l) => ["-e", `/${l}`])]);
      if (head) await ownGit(scratch, ["update-ref", "--no-deref", "HEAD", head]);
      for (const l of links) {
        const from = join(repo.top, l), to = join(scratch, l);
        if (existsSync(from) && !existsSync(to)) try { symlinkSync(from, to); } catch {} // made meanwhile
      }
      const ls = await ownGit(scratch, ["ls-files", "-z"]);
      return ls.out.split("\0").filter(Boolean);
    } catch (e) {
      if (attempt) { d!.capture(e, { at: "checks beside: the copy of the files" }); return undefined; }
      await rm(scratch, { recursive: true, force: true }); // made again from nothing
    }
  }
  return undefined;
}

// What the agent's files change over its base (the merge base of its commit with the base branch), else over
// its own commit: deleted files too (a test that imports one is touched).
async function changedFiles(repo: Repo, tree: string, head: string | null, scratch: string): Promise<string[]> {
  const base = await baseOf(repo);
  let from: string | undefined;
  if (base && head) from = (await git(repo.top, ["merge-base", head, base.name], { read: true, timeout: 30_000 })).out.trim() || undefined;
  from ??= head ?? undefined;
  if (!from) return [];
  const r = await ownGit(scratch, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", `${from}^{tree}`, tree]);
  return r.code === 0 ? r.out.split("\0").filter(Boolean) : [];
}

// --- the owner's host

const SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
async function sshOut(host: string, script: string, timeout: number): Promise<string> {
  const p = Bun.spawn(["ssh", ...SSH, host, script], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout, killSignal: "SIGKILL" });
  const out = await readText(p.stdout as ReadableStream<Uint8Array>, "ssh");
  await p.exited;
  return out;
}
// The copy sent to the host (its installed packages left there), the lockfile's install run there when the
// lockfile changed, then the check, at a low priority. The host's own folder for the agent is under its
// ~/.cache/keel-beside.
async function onHost(cfg: Setting, id: string, scratch: string, check: Check, command: string, limitMs: number, links: string[]): Promise<Ran | { error: string }> {
  const host = cfg.host!;
  const rdir = `.cache/keel-beside/${scratchName(id)}`;
  const started = performance.now();
  // (The links to this machine's packages are not sent: the host installs its own, and keeps them.)
  const sync = Bun.spawn(["rsync", "-a", "--delete", "--exclude=/.git", "--exclude=/node_modules", "--exclude=/.keel-lock", ...links.map((l) => `--exclude=/${l}`), "-e", `ssh ${SSH.join(" ")}`, `${scratch}/`, `${host}:${rdir}/`], { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 300_000, killSignal: "SIGKILL" });
  const err = await readText(sync.stderr as ReadableStream<Uint8Array>, "rsync");
  if ((await sync.exited) !== 0) return { error: `rsync to ${host}: ${err.trim().split("\n").at(-1) ?? ""}` };
  const lock = LOCKS.find((l) => existsSync(join(scratch, l.file)));
  const mark = lock ? Bun.hash(readFileSync(join(scratch, lock.file))).toString(36) : "";
  const path = cfg.host_path.map((p) => p.replace(/^~(?=\/|$)/, "$HOME")).join(":");
  const install = lock ? `if [ "$(cat .keel-lock 2>/dev/null)" != ${mark} ]; then ${lock.install} >/dev/null 2>&1 && echo ${mark} > .keel-lock; fi; ` : "";
  const cd = check.dir === "." ? "" : `cd ${quote(check.dir)} && `;
  const script = `${path ? `PATH="${path}:$PATH"; ` : ""}cd ${quote(rdir)} && ${install}${cd}CI=1 nice -n 10 bash -c ${quote(command)} 2>&1`;
  const p = Bun.spawn(["ssh", ...SSH, host, script], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: limitMs, killSignal: "SIGKILL" });
  const [out, errOut, code] = await Promise.all([readText(p.stdout as ReadableStream<Uint8Array>, "ssh"), readText(p.stderr as ReadableStream<Uint8Array>, "ssh"), p.exited]);
  const ms = Math.round(performance.now() - started);
  const timedOut = p.signalCode === "SIGKILL" && ms >= limitMs;
  // (ssh's own 255: the host could not be reached, or the link broke.)
  if (code === 255 && !out) return { error: `ssh ${host}: ${errOut.trim().split("\n").at(-1) ?? ""}` };
  return { code: timedOut ? null : code, signal: timedOut || p.signalCode == null ? null : String(p.signalCode), timedOut, out: (out + errOut).slice(-256 * 1024), ms, cpu_ms: null };
}

// (For a test: the lanes as they are.)
export const laneOf = (id: string) => lanes.get(id);
