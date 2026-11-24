// What the daemon and every process it started cost the machine, read from
// /proc: memory, CPU, threads and open files per process, the processes of a
// session booked to it (tools run with KEEL_SESSION in their environment),
// and a history of samples. Sampling is cheap (a few small /proc reads) and
// runs every 5 s while a turn works, every 30 s when idle.
import { statfsSync } from "node:fs";
import type { Bus } from "../core/bus.ts";
import { liveJobs, type Job } from "../tools/jobs.ts";
import { fds, read, readProcs, status, stat, type CgroupCost, type ProcAsk, type ProcRaw, type ProcRead } from "./proc-read.ts";
import type { Reads } from "../server/reads.ts";
import { timed } from "./stall.ts";
import { vault } from "../safety/secrets.ts";

// A process's command line as shown, known values hidden: read once a command
// line (a sample reads every process, and most stay the same).
const shownOf = new Map<string, string>();
export function shown(raw: string): string {
  let out = shownOf.get(raw);
  if (out === undefined) {
    out = raw.split("\0").map((a) => (a ? vault.redact(a, null, "command") : a)).join("\0");
    if (shownOf.size > 2048) shownOf.clear();
    shownOf.set(raw, out);
  }
  return out;
}

const ACTIVE_MS = 5_000;
const IDLE_MS = 30_000;
const HISTORY_MS = 24 * 3600_000;

export type Proc = {
  pid: number; ppid: number; name: string; label: string; command: string; kind: string; session_id?: string; started_ms: number;
  rss_bytes: number; peak_rss_bytes: number; cpu_user_ms: number; cpu_system_ms: number; cpu_percent: number; threads: number; open_files?: number;
};
type Sample = { ts_ms: number; unmeasured_ended: number; cpu_percent: number; daemon_cpu_percent: number; cpu_ms: number; daemon_cpu_ms: number; rss_bytes: number; daemon_rss_bytes: number; processes: number; busy: boolean };

// Where the daemon's resident memory is. The kernel's split: its own memory
// (anon) and mapped files such as its binary (file). The runtime's: live
// JavaScript objects, what the heap holds in all, and memory held outside it
// for buffers. What the anon part holds beyond the heap is native: SQLite's
// page caches, the allocator's free memory, threads' stacks.
export function memorySplit(statusText: string, u: { heapUsed: number; heapTotal: number; external: number; arrayBuffers: number }) {
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(statusText)?.[1] ?? 0) * 1024;
  return { anon_bytes: kb("RssAnon"), file_bytes: kb("RssFile"), heap_used_bytes: u.heapUsed, heap_total_bytes: u.heapTotal, external_bytes: u.external, array_buffers_bytes: u.arrayBuffers };
}

// What of the daemon is in swap: its own process (VmSwap of its status
// file) and the unit it runs in (the cgroup's memory.swap.current, with the
// unit's limit: 0 when the unit may not swap at all, absent when it has no
// limit). A page in swap is read back from the disk when it is next used,
// and the daemon's loop waits for it.
// `unit` is the cgroup's last name, and `own` says whether it is the
// daemon's own service: a daemon started from a terminal runs in the
// terminal's scope (or the login session's), whose swap is other programs'
// too and whose settings are not the daemon's to change.
export type Swap = { process_bytes: number; unit_bytes?: number; unit_limit_bytes?: number; unit?: string; own?: boolean };
export function swapFrom(statusText: string, current: string, max: string, cgroup = "", supervised = false): Swap {
  const kb = Number(/^VmSwap:\s+(\d+)/m.exec(statusText)?.[1] ?? 0) * 1024;
  const unit = current.trim() === "" ? undefined : Number(current.trim());
  const limit = /^\d+$/.test(max.trim()) ? Number(max.trim()) : undefined;
  const name = cgroup.replace(/\/+$/, "").split("/").pop() || undefined;
  return {
    process_bytes: kb,
    ...(unit !== undefined && Number.isFinite(unit) ? { unit_bytes: unit } : {}),
    ...(limit !== undefined ? { unit_limit_bytes: limit } : {}),
    ...(name ? { unit: name, own: supervised && name.endsWith(".service") } : {}),
  };
}
function swap(): Swap {
  const own = /^0::(\/.*)$/m.exec(read("/proc/self/cgroup"))?.[1];
  const dir = own ? `/sys/fs/cgroup${own}`.replace(/\/$/, "") : "";
  return swapFrom(read(`/proc/${process.pid}/status`), dir ? read(`${dir}/memory.swap.current`) : "", dir ? read(`${dir}/memory.swap.max`) : "", own ?? "", process.env.KEEL_SUPERVISED === "systemd");
}

function kindOf(name: string, command: string, session?: string, lsp?: string): string {
  if (lsp) return "lsp";
  if (/keel-plugins|\/plugins\//.test(command)) return "provider";
  if (name === "systemd-inhibit" || /systemd-inhibit/.test(command)) return "keep-awake";
  if (session) return "tool";
  if (name === "git") return "git";
  if (/mcp|chrome-bridge|npx|uvx/.test(command)) return "mcp";
  return "helper";
}

// What to call a process: the command a shell wrapper runs, not the wrapper.
function labelOf(name: string, args: string[]): string {
  const script = (args[0] === "bash" || args[0]?.endsWith("/bash") || args[0] === "sh") && args[1] === "-c" ? args[2] : undefined;
  // A job's exit-code wrapper (bash -c SCRIPT EXITFILE CMD...): named by its command.
  if (script && /^("\$@"|p=\$KEEL_CONCEAL)/.test(script) && args.length > 4) return labelOf(name, args.slice(4));
  if (script) {
    const lines = script.split("\n").map((l) => l.trim()).filter((l) => l && !/^(trap|exec 2>&1|set -)/.test(l));
    if (lines.length) return lines.join("; ").slice(0, 200);
  }
  const bin = args[0]?.split("/").pop() || name;
  return [bin, ...args.slice(1).map((a) => (a.length > 60 && a.includes("/") ? a.split("/").pop()! : a))].join(" ").slice(0, 200);
}

// CPU ms used between two samples: each process's own growth, keyed by pid
// and start time; one born since the last sample counts whole. A process gone
// since then is counted in `gone` (its last interval is unknown), never
// subtracted from the others.
export function intervalCpu(prev: Map<string, number>, now: { pid: number; started_ms: number; cpu: number }[], lastTs: number | undefined) {
  const at = new Map<string, number>();
  let used = 0;
  for (const p of now) {
    const key = `${p.pid}:${p.started_ms}`;
    at.set(key, p.cpu);
    const was = prev.get(key);
    if (was !== undefined) used += Math.max(0, p.cpu - was);
    else if (lastTs !== undefined && p.started_ms >= lastTs) used += p.cpu;
  }
  let gone = 0;
  for (const key of prev.keys()) if (!at.has(key)) gone++;
  return { used, at, gone };
}

export { cgroupCost } from "./proc-read.ts";

export type JobCost = { id: string; session_id: string; label: string; contain: "cgroup" | "group"; processes: number; cpu_user_ms: number; cpu_system_ms: number; memory_bytes: number; pids: number[] };

export class Resources {
  private last = new Map<number, { cpu: number; ts: number }>();
  private prev = new Map<number, { cpu: number; ts: number }>();
  private ended = new Map<string, { cpu_user_ms: number; cpu_system_ms: number; processes: number }>();
  private seen = new Map<number, Proc>();
  // CPU ms of each process at the last sample, by pid and start time (a reused pid is another process).
  private cpuAt = new Map<string, number>();
  private history: Sample[] = [];
  private procs: Proc[] = [];
  private jobs: JobCost[] = [];
  private measured = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private busy = new Set<string>();
  readonly started = Date.now();
  private startRss = process.memoryUsage().rss;
  helpers = 0;

  constructor(bus: Bus, private stateDir: string, private reads?: Pick<Reads, "run">) {
    bus.on((f) => {
      if (f.t !== "session") return;
      const was = this.busy.size;
      if (f.session.phase === "working") this.busy.add(f.session.id);
      else this.busy.delete(f.session.id);
      if (!was && this.busy.size) this.schedule(0); // a turn adds a sample at its start
      if (was && !this.busy.size) this.schedule(0); // and one at its end
    });
    this.schedule(0);
  }

  stop() { clearTimeout(this.timer); }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    // (Read from /proc for every process under the daemon: named, should it ever hold the loop.)
    this.timer = setTimeout(() => {
      const again = () => this.schedule(this.busy.size ? ACTIVE_MS : IDLE_MS);
      if (this.reads && this.busy.size) { this.sampleOff().catch(() => {}).finally(again); return; }
      try { timed(() => `sampling what the daemon's ${this.procs.length} processes use`, () => this.sample(), true); } finally { again(); }
    }, ms);
    (this.timer as any).unref?.();
  }

  // What the pass reads of /proc, asked of the read thread while a turn works (the pass then comes
  // every 5 s and reads a few dozen processes), on the loop when the daemon is idle (it would keep
  // the thread, and its memory, alive for a pass of a few reads).
  private ask(jobs: Job[]): ProcAsk {
    return { self: process.pid, jobs: jobs.map((j) => ({ id: j.id, pid: j.pid, cgroup: j.cgroup })), seen: [...this.seen].map(([pid, p]) => [pid, p.name]) };
  }

  // One pass on the loop.
  sample(): void {
    const jobs = liveJobs();
    this.apply(readProcs(this.ask(jobs)), jobs);
  }

  // One pass with the reads of /proc on the thread; the loop puts the answer together. The pass falls
  // back to the loop when the thread cannot answer.
  async sampleOff(): Promise<void> {
    const jobs = liveJobs();
    let got: ProcRead;
    try { got = await this.reads!.run("proc.sample", this.ask(jobs)); } catch { return this.sample(); }
    timed(() => `sampling what the daemon's ${this.procs.length} processes use`, () => this.apply(got, jobs), true);
  }

  // An answer older than the pass the loop made meanwhile (a refresh) is dropped.
  private apply(got: ProcRead, jobList: Job[]): void {
    const now = got.at;
    if (now < this.measured) return;
    const jobs = jobList.map((job, i) => ({ job, cg: got.cgroups[i] ?? null }));
    const pids = got.pids;
    const jobOf = new Map<number, Job>();
    for (const [pid, id] of got.jobOf) { const j = jobList.find((x) => x.id === id); if (j) jobOf.set(pid, j); }
    const live = new Set(pids);
    // A process that ended: its last CPU stays on its session's total.
    for (const [pid, p] of this.seen) {
      if (live.has(pid)) continue;
      const k = p.session_id ?? "";
      const e = this.ended.get(k) ?? { cpu_user_ms: 0, cpu_system_ms: 0, processes: 0 };
      e.cpu_user_ms += p.cpu_user_ms; e.cpu_system_ms += p.cpu_system_ms; e.processes++;
      this.ended.set(k, e);
      this.seen.delete(pid); this.last.delete(pid); this.prev.delete(pid);
    }
    const procs: Proc[] = [];
    for (const r of got.procs) {
      const known = this.seen.get(r.pid); // its environment was read at its first sample
      // A process's arguments can hold a value it was given (a plugin server's
      // sensitive setting in its argv): known values are hidden in what is shown.
      const args = shown(r.cmdline).split("\0").filter(Boolean);
      const command = args.join(" ").slice(0, 1000) || r.name;
      // (A process whose name changed ran another program: its environment is read again.)
      const session_id = (r.env ? r.env.session : known?.session_id) ?? jobOf.get(r.pid)?.sessionId;
      const lsp = r.env ? r.env.lsp : known?.kind === "lsp" ? "lsp" : undefined;
      const cpu = r.utime + r.stime;
      const p: Proc = {
        pid: r.pid, ppid: r.ppid, name: r.name, label: labelOf(r.name, args), command, kind: kindOf(r.name, command, session_id, lsp), session_id, started_ms: r.start,
        rss_bytes: r.rss, peak_rss_bytes: r.hwm, cpu_user_ms: r.utime, cpu_system_ms: r.stime, cpu_percent: this.percent(r.pid, cpu, now), threads: r.threads, open_files: r.fds,
      };
      procs.push(p);
      this.seen.set(r.pid, p);
    }
    procs.sort((a, b) => b.rss_bytes - a.rss_bytes);
    this.procs = procs;
    // Each job whole: its cgroup's own totals, or the sum of the processes found for it.
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    this.jobs = jobs.map(({ job, cg }) => {
      const mine = pids.filter((p) => jobOf.get(p) === job).map((p) => byPid.get(p)).filter((p): p is Proc => !!p);
      const sum = (k: "cpu_user_ms" | "cpu_system_ms" | "rss_bytes") => mine.reduce((n, p) => n + p[k], 0);
      return {
        id: job.id, session_id: job.sessionId, label: job.description ?? job.command.slice(0, 200), contain: cg ? "cgroup" as const : "group" as const, processes: mine.length,
        cpu_user_ms: cg ? cg.cpu_user_ms : sum("cpu_user_ms"), cpu_system_ms: cg ? cg.cpu_system_ms : sum("cpu_system_ms"), memory_bytes: cg ? cg.memory_bytes : sum("rss_bytes"), pids: mine.map((p) => p.pid),
      };
    });
    const d = this.daemon(now);
    this.measured = now;
    const cpuMs = d.cpu_user_ms + d.cpu_system_ms + procs.reduce((n, p) => n + p.cpu_user_ms + p.cpu_system_ms, 0);
    const daemonMs = d.cpu_user_ms + d.cpu_system_ms;
    const before = this.history.at(-1);
    const dt = before ? now - before.ts_ms : 0;
    const { used, at, gone } = intervalCpu(this.cpuAt, [{ pid: process.pid, started_ms: this.started, cpu: daemonMs }, ...procs.map((p) => ({ pid: p.pid, started_ms: p.started_ms, cpu: p.cpu_user_ms + p.cpu_system_ms }))], before?.ts_ms);
    this.cpuAt = at;
    this.history.push({
      ts_ms: now,
      unmeasured_ended: gone,
      // Of one core over the time since the last sample.
      cpu_percent: dt ? (used / dt) * 100 : 0,
      daemon_cpu_percent: dt ? Math.max(0, ((daemonMs - before!.daemon_cpu_ms) / dt) * 100) : 0,
      cpu_ms: cpuMs,
      daemon_cpu_ms: daemonMs,
      rss_bytes: d.rss_bytes + procs.reduce((n, p) => n + p.rss_bytes, 0),
      daemon_rss_bytes: d.rss_bytes,
      processes: procs.length,
      busy: this.busy.size > 0,
    });
    while (this.history.length && this.history[0]!.ts_ms < now - HISTORY_MS) this.history.shift();
  }

  // Percent of one core since the last sample at least a second older.
  private percent(pid: number, cpu: number, now: number): number {
    const l = this.last.get(pid);
    let base = this.prev.get(pid);
    if (l && now - l.ts >= 1000) { this.prev.set(pid, l); base = l; }
    this.last.set(pid, { cpu, ts: now });
    return base && now > base.ts ? Math.max(0, ((cpu - base.cpu) / (now - base.ts)) * 100) : 0;
  }

  private daemon(now: number) {
    const st = stat(process.pid)!;
    const s = status(process.pid);
    const usage = process.memoryUsage();
    return {
      pid: process.pid, started_ms: this.started, rss_bytes: s.rss, peak_rss_bytes: s.hwm,
      cpu_user_ms: st.utime, cpu_system_ms: st.stime, cpu_percent: this.percent(process.pid, st.utime + st.stime, now),
      threads: s.threads, open_files: fds(process.pid), heap_bytes: usage.heapUsed, memory: memorySplit(read(`/proc/${process.pid}/status`), usage), swap: swap(),
      growth: { start_rss_bytes: this.startRss, per_hour_bytes: now - this.started > 600_000 ? ((s.rss - this.startRss) / (now - this.started)) * 3600_000 : null },
    };
  }

  report(q: { session?: string; historyMin?: number; refresh?: boolean } = {}) {
    if (q.refresh || !this.measured) this.sample();
    const now = Date.now();
    const daemon = this.daemon(now);
    const procs = q.session ? this.procs.filter((p) => p.session_id === q.session) : this.procs;
    const total = { rss: daemon.rss_bytes + this.procs.reduce((n, p) => n + p.rss_bytes, 0), cpu: daemon.cpu_percent + this.procs.reduce((n, p) => n + p.cpu_percent, 0) };
    const share = (rss: number, cpu: number) => ({ rss_share: total.rss ? rss / total.rss : 0, cpu_share: total.cpu ? cpu / total.cpu : 0 });
    const kinds = new Map<string, Proc[]>();
    for (const p of procs) (kinds.get(p.kind) ?? kinds.set(p.kind, []).get(p.kind)!).push(p);
    const sessions = new Map<string, Proc[]>();
    for (const p of this.procs) if (p.session_id) (sessions.get(p.session_id) ?? sessions.set(p.session_id, []).get(p.session_id)!).push(p);
    for (const k of this.ended.keys()) if (k && !sessions.has(k)) sessions.set(k, []);
    const sum = (list: Proc[], k: keyof Proc) => list.reduce((n, p) => n + (p[k] as number), 0);
    let disk: { path: string; free_bytes: number; total_bytes: number } | null = null;
    try {
      const f = statfsSync(this.stateDir);
      disk = { path: this.stateDir, free_bytes: f.bavail * f.bsize, total_bytes: f.blocks * f.bsize };
    } catch {}
    const since = now - Math.min(1440, Math.max(1, q.historyMin ?? 60)) * 60_000;
    return {
      measured_ms: this.measured,
      platform: process.platform,
      interval_ms: this.busy.size ? ACTIVE_MS : IDLE_MS,
      totals: {
        rss_bytes: total.rss, cpu_percent: total.cpu, processes: this.procs.length + 1,
        threads: daemon.threads + sum(this.procs, "threads"),
        cpu_user_ms: daemon.cpu_user_ms + sum(this.procs, "cpu_user_ms"), cpu_system_ms: daemon.cpu_system_ms + sum(this.procs, "cpu_system_ms"),
      },
      daemon: { ...daemon, ...share(daemon.rss_bytes, daemon.cpu_percent) },
      processes: procs.map((p) => ({ ...p, ...share(p.rss_bytes, p.cpu_percent) })),
      jobs: q.session ? this.jobs.filter((j) => j.session_id === q.session) : this.jobs,
      kinds: [...kinds.entries()].map(([kind, list]) => ({ kind, processes: list.length, rss_bytes: sum(list, "rss_bytes"), cpu_percent: sum(list, "cpu_percent"), ...share(sum(list, "rss_bytes"), sum(list, "cpu_percent")) })),
      sessions: [...sessions.entries()]
        .filter(([id]) => !q.session || id === q.session)
        .map(([session_id, list]) => {
          const e = this.ended.get(session_id) ?? { cpu_user_ms: 0, cpu_system_ms: 0, processes: 0 };
          return {
            session_id, processes: list.length, rss_bytes: sum(list, "rss_bytes"), cpu_percent: sum(list, "cpu_percent"),
            total: { cpu_user_ms: sum(list, "cpu_user_ms") + e.cpu_user_ms, cpu_system_ms: sum(list, "cpu_system_ms") + e.cpu_system_ms, processes: list.length + e.processes },
          };
        })
        .sort((a, b) => b.rss_bytes - a.rss_bytes || b.total.cpu_user_ms - a.total.cpu_user_ms),
      disk,
      history: this.history.filter((h) => h.ts_ms >= since),
    };
  }
}
