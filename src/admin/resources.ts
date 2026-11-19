// What the daemon and every process it started cost the machine, read from
// /proc: memory, CPU, threads and open files per process, the processes of a
// session booked to it (tools run with KEEL_SESSION in their environment),
// and a history of samples. Sampling is cheap (a few small /proc reads) and
// runs every 5 s while a turn works, every 30 s when idle.
import { readdirSync, readFileSync, statfsSync } from "node:fs";
import type { Bus } from "../core/bus.ts";
import { jobPids } from "../tools/jobs.ts";

const TICK_MS = 10; // USER_HZ is 100 on Linux (getconf CLK_TCK)
const ACTIVE_MS = 5_000;
const IDLE_MS = 30_000;
const HISTORY_MS = 24 * 3600_000;

export type Proc = {
  pid: number; ppid: number; name: string; label: string; command: string; kind: string; session_id?: string; started_ms: number;
  rss_bytes: number; peak_rss_bytes: number; cpu_user_ms: number; cpu_system_ms: number; cpu_percent: number; threads: number; open_files?: number;
};
type Sample = { ts_ms: number; unmeasured_ended: number; cpu_percent: number; daemon_cpu_percent: number; cpu_ms: number; daemon_cpu_ms: number; rss_bytes: number; daemon_rss_bytes: number; processes: number; busy: boolean };

const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const BOOT_MS = (() => {
  const btime = /^btime (\d+)/m.exec(read("/proc/stat"));
  return btime ? Number(btime[1]) * 1000 : 0;
})();

function stat(pid: number) {
  const s = read(`/proc/${pid}/stat`);
  const close = s.lastIndexOf(")");
  if (close < 0) return null;
  const f = s.slice(close + 2).split(" ");
  // fields after the name: state(0) ppid(1) ... utime(11) stime(12) ... starttime(19)
  return { name: s.slice(s.indexOf("(") + 1, close), ppid: Number(f[1]), utime: Number(f[11]) * TICK_MS, stime: Number(f[12]) * TICK_MS, start: BOOT_MS + Number(f[19]) * TICK_MS };
}

function status(pid: number) {
  const s = read(`/proc/${pid}/status`);
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(s)?.[1] ?? 0) * 1024;
  return { rss: kb("VmRSS"), hwm: kb("VmHWM"), threads: Number(/^Threads:\s+(\d+)/m.exec(s)?.[1] ?? 0) };
}

const fds = (pid: number) => { try { return readdirSync(`/proc/${pid}/fd`).length; } catch { return undefined; } };

function sessionOf(pid: number): string | undefined {
  const env = read(`/proc/${pid}/environ`);
  const m = /(?:^|\0)KEEL_SESSION=([^\0]+)/.exec(env);
  return m?.[1];
}

function kindOf(name: string, command: string, session?: string): string {
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

export class Resources {
  private last = new Map<number, { cpu: number; ts: number }>();
  private prev = new Map<number, { cpu: number; ts: number }>();
  private ended = new Map<string, { cpu_user_ms: number; cpu_system_ms: number; processes: number }>();
  private seen = new Map<number, Proc>();
  // CPU ms of each process at the last sample, by pid and start time (a reused pid is another process).
  private cpuAt = new Map<string, number>();
  private history: Sample[] = [];
  private procs: Proc[] = [];
  private measured = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private busy = new Set<string>();
  readonly started = Date.now();
  private startRss = process.memoryUsage().rss;
  helpers = 0;

  constructor(bus: Bus, private stateDir: string) {
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
    this.timer = setTimeout(() => { try { this.sample(); } finally { this.schedule(this.busy.size ? ACTIVE_MS : IDLE_MS); } }, ms);
    (this.timer as any).unref?.();
  }

  // Every process under the daemon, children of children included, and the
  // background jobs a previous daemon started and this one adopted (with
  // their children). Each thread's `children` file names the processes it
  // started, so only the daemon's own trees are read, not every process.
  private descendants(): number[] {
    const out: number[] = [];
    const seen = new Set<number>([process.pid]);
    const walk = (pid: number) => {
      let tids: string[] = [];
      try { tids = readdirSync(`/proc/${pid}/task`); } catch { return; }
      for (const t of tids) for (const c of read(`/proc/${pid}/task/${t}/children`).split(" ")) {
        const n = Number(c);
        if (n && !seen.has(n)) { seen.add(n); out.push(n); walk(n); }
      }
    };
    walk(process.pid);
    for (const pid of jobPids()) if (!seen.has(pid) && stat(pid)) { seen.add(pid); out.push(pid); walk(pid); }
    return out;
  }

  sample(): void {
    const now = Date.now();
    const pids = this.descendants();
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
    for (const pid of pids) {
      const st = stat(pid);
      if (!st) continue;
      const s = status(pid);
      const args = read(`/proc/${pid}/cmdline`).split("\0").filter(Boolean);
      const command = args.join(" ").slice(0, 1000) || st.name;
      const session_id = this.seen.get(pid)?.session_id ?? sessionOf(pid);
      const cpu = st.utime + st.stime;
      const p: Proc = {
        pid, ppid: st.ppid, name: st.name, label: labelOf(st.name, args), command, kind: kindOf(st.name, command, session_id), session_id, started_ms: st.start,
        rss_bytes: s.rss, peak_rss_bytes: s.hwm, cpu_user_ms: st.utime, cpu_system_ms: st.stime, cpu_percent: this.percent(pid, cpu, now), threads: s.threads, open_files: fds(pid),
      };
      procs.push(p);
      this.seen.set(pid, p);
    }
    procs.sort((a, b) => b.rss_bytes - a.rss_bytes);
    this.procs = procs;
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
    return {
      pid: process.pid, started_ms: this.started, rss_bytes: s.rss, peak_rss_bytes: s.hwm,
      cpu_user_ms: st.utime, cpu_system_ms: st.stime, cpu_percent: this.percent(process.pid, st.utime + st.stime, now),
      threads: s.threads, open_files: fds(process.pid), heap_bytes: process.memoryUsage().heapUsed,
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
