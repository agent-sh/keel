// Job scopes that outlive their command: what a command started and left running in its cgroup scope (a
// build tool's daemon, a server, a shell left waiting), this daemon's own and those of the daemon before a
// restart (src/tools/jobs.ts takes those back by their records: adoptJobs at the start, adoptScopes on each
// pass). Once a minute each one is measured (its memory, its processor time, the build daemons in it) and
// decided (leftover-rules.ts, scopeFate): a scope whose session ended is stopped once idle, a build daemon
// whose command ended is stopped when its session ends or once idle, and a scope the owner keeps stays.
// A command no cgroup holds (its process group and session do) that an ended agent's end kept for another
// process's connection to its port is looked at on the same pass (looseOnes) and stopped once none is left.
// Each stop is one line in its session's failures scope, said once across restarts. How long each scope and
// build daemon has been idle is kept in the store, so a restart goes on counting. What is held is listed in
// Settings > Leftovers and counted in Settings > Resources.
//
// Never a scope Keel did not make: only jobs this daemon holds are looked at, a scope is held only by a job
// whose own record names that exact cgroup (`keel-job-<id>-<6 letters>.scope` in app.slice), and a job this
// daemon did not start itself is acted on only while a live process in its scope carries the job's mark and
// this state folder's id (scopeWhy in src/tools/jobs.ts). A scope with a process someone put in it, or a
// process with a terminal, or a shared server (adb's), is kept.
import { readFile, readdir, readlink } from "node:fs/promises";
import { clientsOf, portsOf } from "../fleet/portal.ts";
import { timed } from "../admin/stall.ts";
import { adoptScopes, allJobs, jobLive, ownStart, processesOf, scopeEnvs, scopeHoldsSelf, scopeWhy, stateIdOf, stopJob, type Job } from "../tools/jobs.ts";
import * as rules from "./leftover-rules.ts";

export const PASS_MS = 60_000;

// What one pass found of a job's scope, for the page.
export type ScopeView = {
  job_id: string; session_id: string; memory_bytes: number; idle_since: number; command_ended: boolean;
  builds: { pid: number; kind: string; idle_since: number; memory_bytes: number }[];
  fate: rules.ScopeFate; keep: boolean;
};
// `bounds`: how long a scope of an ended session, and a build daemon, idle before they are stopped.
export type Held = { scopes: number; memory_bytes: number; others: { scopes: number; memory_bytes: number }; at: number; bounds: { idle_ms: number; build_idle_ms: number } };
const BOUNDS = { idle_ms: rules.SCOPE_IDLE_MS, build_idle_ms: rules.BUILD_IDLE_MS };

export type Ctx = {
  spillRoot: string;
  // How a session ended (gone, archived, its agent ended), or undefined while it lives.
  endedOf: (sessionId: string) => string | undefined;
  keeps: () => Set<string>;
  // One line to the session's failures scope, once for each `key` (across restarts too).
  tell: (sessionId: string, line: string, key: string) => void;
  refused?: (file: string, why: string) => void;
  // The idle marks the last daemon kept (by scope, and by build daemon), and this pass's to keep.
  loadIdle?: () => Map<string, rules.IdleMark>;
  saveIdle?: (marks: Map<string, rules.IdleMark>) => void;
};

// By the scope's cgroup, and by `<cgroup>#<pid>:<start time>` for a build daemon in it.
let marks: Map<string, rules.IdleMark> | undefined;
let views = new Map<string, ScopeView>();
let held: Held = { scopes: 0, memory_bytes: 0, others: { scopes: 0, memory_bytes: 0 }, at: 0, bounds: BOUNDS };
// The stops this daemon tried (one try each; what is told of one is the store's to say once), and the
// scopes it found not to be its jobs' (said once).
const tried = new Set<string>();
const doubted = new Set<string>();

export const viewOf = (jobId: string) => views.get(jobId);
export const heldNow = () => held;
// The owner's mark, seen at once (the next pass decides again).
export function marked(jobId: string, keep: boolean) {
  const v = views.get(jobId);
  if (v) { v.keep = keep; if (keep) v.fate = { act: "keep", why: "you keep it" }; }
}

const num = async (p: string) => { try { return Number((await readFile(p, "utf8")).trim()) || 0; } catch { return 0; } };
const usage = async (cg: string) => { try { return Number(/^usage_usec (\d+)/m.exec(await readFile(`${cg}/cpu.stat`, "utf8"))?.[1] ?? 0) / 1000; } catch { return undefined; } };
// A process's processor time (ms: utime and stime, 100 ticks a second), its start time, resident memory,
// parent, and whether it has a controlling terminal. `pty`: also whether it holds a terminal's end open.
type Proc = { cpu: number; start: string; rss: number; argv: string[]; parent: number; tty: boolean; pty?: boolean };
async function procOf(pid: number, o: { pty?: boolean } = {}): Promise<Proc | undefined> {
  try {
    const [st, cmd, status] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile(`/proc/${pid}/cmdline`, "utf8"), readFile(`/proc/${pid}/status`, "utf8").catch(() => "")]);
    const f = st.slice(st.lastIndexOf(") ") + 2).split(" ");
    if (f[0] === "Z" || f[0] === "X") return undefined;
    const p: Proc = { cpu: (Number(f[11]) + Number(f[12])) * 10, start: f[19]!, rss: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024, argv: cmd.split("\0").filter(Boolean), parent: Number(f[1]), tty: f[4] !== "0" };
    if (o.pty) p.pty = await holdsPty(pid);
    return p;
  } catch { return undefined; }
}
async function holdsPty(pid: number): Promise<boolean> {
  const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
  const to = await Promise.all(fds.map((fd) => readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")));
  return to.some((t) => t === "/dev/ptmx" || t.startsWith("/dev/pts/"));
}
// Where an orphan goes: the user manager (a child subreaper) or init. A parent of these is no sign that
// someone put the process in the scope.
const reaper = async (pid: number) => pid === 1 || (await readFile(`/proc/${pid}/comm`, "utf8").catch(() => "")).trim() === "systemd";
const pidsIn = async (cg: string) => (await readFile(`${cg}/cgroup.procs`, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);

// The jobs a pass looks at: a scope that still holds processes, and either its command ended (what is left is
// what it started) or its session ended. A command at work in a live session is its session's.
const lingering = (j: Job, endedOf: Ctx["endedOf"]) => j.contain === "cgroup" && !!j.cgroup && jobLive(j) && (j.ended !== undefined || !!endedOf(j.sessionId));

export type Decision = { job: Job; view: ScopeView };

// One pass. `dry`: decide and list, act on nothing. `jobs`: the jobs to look at (a probe's); by default every
// job this daemon holds. `now`: the clock.
export async function pass(c: Ctx, o: { dry?: boolean; jobs?: Job[]; now?: number } = {}): Promise<Decision[]> {
  const now = o.now ?? Date.now();
  const others = o.jobs ? { taken: [], others: [] as string[] } : await adoptScopes(c.spillRoot, c.refused).catch(() => ({ taken: [], others: [] as string[] }));
  const stateId = stateIdOf(c.spillRoot);
  const list = (o.jobs ?? allJobs()).filter((j) => lingering(j, c.endedOf));
  const keeps = c.keeps();
  const out: Decision[] = [];
  const read = await Promise.all(list.map(async (j) => {
    const cg = j.cgroup!;
    // A job taken back from a record is this daemon's only while its scope carries the job's mark.
    const why = ownStart(j) ? undefined : scopeWhy({ id: j.id, started: j.started, state_id: j.stateId, state_taken: j.stateTaken }, await scopeEnvs(cg), stateId);
    if (why) return { j, why };
    const [cpu, mem, pids] = await Promise.all([usage(cg), num(`${cg}/memory.current`), pidsIn(cg)]);
    const procs = new Map<number, Proc>();
    await Promise.all(pids.map(async (pid) => { const p = await procOf(pid, { pty: true }); if (p) procs.set(pid, p); }));
    const reapers = new Set<number>();
    await Promise.all([...new Set([...procs.values()].map((p) => p.parent))].filter((pp) => !procs.has(pp)).map(async (pp) => { if (await reaper(pp)) reapers.add(pp); }));
    return { j, cpu, mem, procs, reapers };
  }));
  for (const r of read) if (r.why) {
    others.others.push(r.j.cgroup!);
    if (!doubted.has(r.j.cgroup!)) { doubted.add(r.j.cgroup!); c.refused?.(r.j.log.replace(/\.log$/, ".json"), r.why); }
  }
  const mine = read.filter((r): r is Extract<typeof r, { procs: Map<number, Proc> }> => !r.why);
  marks ??= c.loadIdle?.() ?? new Map();
  const next = new Map<string, rules.IdleMark>();
  // Ports and their clients: read once for all of them (sync reads of /proc, a few small files a job).
  const ports = timed(() => "leftover scopes: ports", () => portsOf(new Map(mine.map((r) => [r.j.id, [...r.procs.keys()]]))), true);
  for (const { j, cpu, mem, procs, reapers } of mine) {
    if (cpu === undefined || !procs.size) continue;
    const cg = j.cgroup!;
    const scope = rules.nextIdle(marks.get(cg), cpu, now);
    next.set(cg, scope);
    const builds: ScopeView["builds"] = [];
    let shared: string | undefined;
    for (const [pid, p] of procs) {
      shared ??= rules.sharedKind(p.argv);
      const kind = rules.buildKind(p.argv);
      if (!kind) continue;
      const key = `${cg}#${pid}:${p.start}`;
      const mark = rules.nextIdle(marks.get(key), p.cpu, now);
      next.set(key, mark);
      builds.push({ pid, kind, idle_since: mark.since, memory_bytes: p.rss });
    }
    const jp = (ports.get(j.id) ?? []).map((x) => x.port);
    const pids = [...procs.keys()];
    const clients = jp.reduce((n, port) => n + timed(() => "leftover scopes: clients", () => clientsOf(pids, port), true), 0);
    const attached = rules.attachedWhy([...procs].map(([pid, p]) => ({ pid, parent: p.parent, start: p.start, tty: p.tty, pty: !!p.pty })), { pid: j.pid, start: j.boot }, reapers);
    const facts: rules.ScopeFacts = {
      ended: c.endedOf(j.sessionId), keep: keeps.has(j.id), owner: j.by === "owner", self: scopeHoldsSelf(j), shared, attached, clients, ports: jp,
      commandEnded: j.ended !== undefined, idleMs: now - scope.since, builds: builds.map((b) => ({ pid: b.pid, kind: b.kind, idleMs: now - b.idle_since })),
    };
    const view: ScopeView = { job_id: j.id, session_id: j.sessionId, memory_bytes: mem, idle_since: scope.since, command_ended: facts.commandEnded, builds, fate: rules.scopeFate(facts), keep: !!facts.keep };
    out.push({ job: j, view });
  }
  // What a probe looked at is added to what is kept; a whole pass keeps what it saw.
  if (o.jobs) for (const [k, v] of next) marks.set(k, v);
  else marks = next;
  if (!o.dry) c.saveIdle?.(marks);
  views = new Map(out.map((d) => [d.job.id, d.view]));
  const othersMem = await Promise.all(others.others.map((cg) => num(`${cg}/memory.current`)));
  held = { scopes: out.length, memory_bytes: out.reduce((n, d) => n + d.view.memory_bytes, 0), others: { scopes: others.others.length, memory_bytes: othersMem.reduce((a, b) => a + b, 0) }, at: now, bounds: BOUNDS };
  if (!o.dry) for (const d of out) await act(c, d).catch(() => {});
  if (!o.dry && !o.jobs) await looseOnes(c).catch(() => {});
  return out;
}

// What an ended agent's commands left that no cgroup holds (their process group and session do): at the agent's
// end such a process is kept while another process is connected to its port (leftovers.settle), and nothing
// looked at it again. The pass looks again: once no client is left it is stopped, like the end would have
// stopped it. Only an agent's own commands (its end settled them), never the owner's or one the owner keeps.
// It is stopped on the second pass in a row that finds no client, not the first: a client that reconnects within
// the minute (a dev server's tab that reloads, a poller) is not lost. A command found with no process is never
// scanned for again: nothing is left to fork one.
const quiet = new Map<string, number>();
const empty = new Set<string>();
export async function looseOnes(c: Ctx, o: { jobs?: Job[] } = {}): Promise<string[]> {
  const keeps = c.keeps();
  const ended = new Map<string, string | undefined>();
  const agentEnded = (sid: string) => { if (!ended.has(sid)) { const e = c.endedOf(sid); ended.set(sid, e?.startsWith("its agent") ? e : undefined); } return ended.get(sid); };
  const list = (o.jobs ?? allJobs()).filter((j) => j.contain !== "cgroup" && j.by !== "owner" && !keeps.has(j.id) && !tried.has(`${j.id}:loose`) && !empty.has(j.id) && agentEnded(j.sessionId));
  if (!list.length) return [];
  const found = await processesOf(list);
  const all = new Map<string, number[]>();
  for (const j of list) all.set(j.sessionId, [...(all.get(j.sessionId) ?? []), ...(found.get(j.id) ?? []).map((p) => p.pid)]);
  const stopped: string[] = [];
  for (const j of list) {
    const pids = (found.get(j.id) ?? []).map((p) => p.pid);
    if (!pids.length) { empty.add(j.id); quiet.delete(j.id); continue; }
    const ports = (portsOf(new Map([[j.id, pids]])).get(j.id) ?? []).map((p) => p.port);
    const clients = ports.reduce((n, p) => n + clientsOf(pids, p, all.get(j.sessionId)), 0);
    const fate = rules.processFate({ job: j.id, command: j.description || j.command, pids, ports, clients });
    if (fate.act === "keep") { quiet.delete(j.id); continue; }
    const key = `${j.id}:loose`;
    if ((quiet.get(j.id) ?? 0) < 1) { quiet.set(j.id, 1); continue; }
    quiet.delete(j.id);
    tried.add(key);
    const left = await stopJob(j, `was stopped: ${agentEnded(j.sessionId)}, and no process is connected to its port any more`);
    c.tell(j.sessionId, `Stopped what ${what(j)} left running: ${agentEnded(j.sessionId)}, and no process is connected to its port any more.${left.length ? ` Process ${left.join(", ")} of it still runs.` : ""}`, key);
    stopped.push(j.id);
  }
  return stopped;
}

const mb = (b: number) => `${Math.round(b / 1048576)} MB`;
const what = (j: Job) => `\`${(j.description || j.command).replace(/[\x00-\x1f\x7f`]+/g, " ").trim().slice(0, 60)}\` (ID ${j.id})`;

// Connections of other processes to what `pids` listen on, read now (a build may have begun since the pass).
const clientsNow = (scopePids: number[], pids: number[]): number =>
  (portsOf(new Map([["x", pids]])).get("x") ?? []).reduce((n, p) => n + clientsOf(scopePids, p.port), 0);

export async function act(c: Ctx, { job: j, view: v }: Decision) {
  const f = v.fate;
  if (f.act === "keep") return;
  const key = `${j.id}:${f.act}:${f.act === "stop-builds" ? f.pids.join(",") : ""}`;
  if (tried.has(key)) return;
  const scopePids = await pidsIn(j.cgroup!);
  if (f.act === "stop") {
    if (clientsNow(scopePids, scopePids) > 0) return;
    tried.add(key);
    const left = await stopJob(j, `was stopped: ${f.why}`);
    c.tell(j.sessionId, `Stopped what ${what(j)} left running (${mb(v.memory_bytes)}): ${f.why}.${left.length ? ` Process ${left.join(", ")} of it still runs.` : ""}`, key);
    views.delete(j.id);
    return;
  }
  tried.add(key);
  const stopped: string[] = [], left: number[] = [];
  for (const b of v.builds.filter((x) => f.pids.includes(x.pid))) {
    // A build that connected since the pass decided is served: the daemon stays.
    if (clientsNow(scopePids, [b.pid]) > 0) { tried.delete(key); continue; }
    (await stopProcess(j, b.pid)) ? stopped.push(`${b.kind} pid ${b.pid} (${mb(b.memory_bytes)})`) : left.push(b.pid);
  }
  if (stopped.length || left.length) c.tell(j.sessionId, `Stopped the build daemon${stopped.length === 1 ? "" : "s"} ${what(j)} left running: ${stopped.join(", ") || "none"}; ${f.why}.${left.length ? ` Process ${left.join(", ")} still runs.` : ""} The next build starts one again.`, key);
}

// TERM to one process of a job's scope, KILL after ten seconds: only while it is still in that scope and
// still the process it was (its start time). True when it is gone.
async function stopProcess(j: Job, pid: number): Promise<boolean> {
  const first = await procOf(pid);
  if (!first) return true;
  const same = async () => { const p = await procOf(pid); return !!p && p.start === first.start && (await pidsIn(j.cgroup!)).includes(pid); };
  if (!(await same())) return true;
  try { process.kill(pid, "SIGTERM"); } catch { return true; }
  for (let i = 0; i < 40; i++) { await Bun.sleep(250); if (!(await same())) return true; }
  try { process.kill(pid, "SIGKILL"); } catch {}
  for (let i = 0; i < 20; i++) { await Bun.sleep(250); if (!(await same())) return true; }
  return false;
}

// The pass on a timer (one at a time), started again by a hot reload. The first pass comes soon after the
// start, so what the daemon before left is listed at once.
const g = globalThis as { __keelScopes?: () => void };
let ctxNow: Ctx | undefined;
let busy: Promise<unknown> | undefined;
const once = (c: Ctx) => (busy ??= pass(c).catch(() => {}).finally(() => { busy = undefined; }));
// A pass now unless the last one is younger than `maxAge` and saw every scope there is to list (the page asks
// for the list): what is running waits for the pass under way.
export async function fresh(maxAge: number): Promise<void> {
  const c = ctxNow;
  if (!c) return;
  if (busy) { await busy; return; }
  if (Date.now() - held.at >= maxAge || allJobs().some((j) => !views.has(j.id) && lingering(j, c.endedOf))) await once(c);
}
export function start(c: Ctx, firstMs = 5_000): () => void {
  g.__keelScopes?.();
  ctxNow = c;
  let stopped = false;
  const go = () => { if (!stopped) void once(c); };
  const first = setTimeout(go, firstMs);
  const iv = setInterval(go, PASS_MS);
  (first as any).unref?.(); (iv as any).unref?.();
  const stop = () => { stopped = true; clearTimeout(first); clearInterval(iv); if (ctxNow === c) ctxNow = undefined; if (g.__keelScopes === stop) g.__keelScopes = undefined; };
  g.__keelScopes = stop;
  return stop;
}
