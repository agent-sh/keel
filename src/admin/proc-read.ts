// What /proc says of the daemon's processes: the reads of the resource
// sampler (resources.ts), kept apart so the read thread can run them. A pass
// opens five or six small files a process, and with a few dozen commands under
// the daemon that held the loop for several milliseconds at each sample; here
// it is one named read of the read thread (src/server/read-tasks.ts), and the
// loop only puts the answer together. It imports nothing of the daemon.
import { readdirSync, readFileSync } from "node:fs";

const TICK_MS = 10; // USER_HZ is 100 on Linux (getconf CLK_TCK)

export const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const BOOT_MS = (() => {
  const btime = /^btime (\d+)/m.exec(read("/proc/stat"));
  return btime ? Number(btime[1]) * 1000 : 0;
})();

export function stat(pid: number) {
  const s = read(`/proc/${pid}/stat`);
  const close = s.lastIndexOf(")");
  if (close < 0) return null;
  const f = s.slice(close + 2).split(" ");
  // fields after the name: state(0) ppid(1) ... utime(11) stime(12) ... starttime(19)
  return { name: s.slice(s.indexOf("(") + 1, close), ppid: Number(f[1]), utime: Number(f[11]) * TICK_MS, stime: Number(f[12]) * TICK_MS, start: BOOT_MS + Number(f[19]) * TICK_MS };
}

export function status(pid: number) {
  const s = read(`/proc/${pid}/status`);
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(s)?.[1] ?? 0) * 1024;
  return { rss: kb("VmRSS"), hwm: kb("VmHWM"), threads: Number(/^Threads:\s+(\d+)/m.exec(s)?.[1] ?? 0) };
}

export const fds = (pid: number) => { try { return readdirSync(`/proc/${pid}/fd`).length; } catch { return undefined; } };

// What a job's cgroup says it used: CPU of every process it ever had (ended
// ones included) and the memory it holds now (page cache too). Null without one.
export type CgroupCost = { pids: number[]; cpu_user_ms: number; cpu_system_ms: number; memory_bytes: number };
export function cgroupCost(dir: string): CgroupCost | null {
  const procs = read(`${dir}/cgroup.procs`);
  const cpu = read(`${dir}/cpu.stat`);
  if (!procs && !cpu) return null;
  const usec = (k: string) => Number(new RegExp(`^${k} (\\d+)`, "m").exec(cpu)?.[1] ?? 0) / 1000;
  return { pids: procs.split("\n").filter(Boolean).map(Number), cpu_user_ms: usec("user_usec"), cpu_system_ms: usec("system_usec"), memory_bytes: Number(read(`${dir}/memory.current`).trim() || 0) };
}

// What a process's environment says of it: the session that started it (tools
// run with KEEL_SESSION), and the id of a language server (src/lsp), which is
// booked to the session whose edit started it.
function environOf(pid: number): { session?: string; lsp?: string } {
  const env = read(`/proc/${pid}/environ`);
  return { session: /(?:^|\0)KEEL_SESSION=([^\0]+)/.exec(env)?.[1], lsp: /(?:^|\0)KEEL_LSP=([^\0]+)/.exec(env)?.[1] };
}

export type ProcAsk = {
  self: number;
  // The jobs alive: where each runs (its cgroup, else its leader and the leader's children).
  jobs: { id: string; pid: number; cgroup?: string }[];
  // The processes the last pass found, with the name each had. A process's environment does not
  // change, so it is read for one not in this list, or one whose name changed (it ran another program).
  seen: [number, string][];
};
export type ProcRaw = {
  pid: number; ppid: number; name: string; utime: number; stime: number; start: number;
  rss: number; hwm: number; threads: number; cmdline: string; fds?: number;
  env?: { session?: string; lsp?: string };
};
export type ProcRead = {
  at: number;
  pids: number[];
  jobOf: [number, string][];
  cgroups: (CgroupCost | null)[];
  procs: ProcRaw[];
};

// Every process under the daemon, children of children included, and every
// process of the jobs still alive: from its cgroup when it has one (that
// holds setsid and double-forked descendants, and what a finished command
// left running), else its leader and the leader's children, for jobs a
// previous daemon started and this one adopted. Each thread's `children`
// file names the processes it started, so only these trees are read.
export function readProcs(ask: ProcAsk): ProcRead {
  const at = Date.now();
  const cgroups = ask.jobs.map((j) => (j.cgroup ? cgroupCost(j.cgroup) : null));
  const pids: number[] = [];
  const jobOf: [number, string][] = [];
  const seen = new Set<number>([ask.self]);
  const add = (n: number) => { if (seen.has(n)) return false; seen.add(n); pids.push(n); return true; };
  const walk = (pid: number, jobId?: string) => {
    let tids: string[] = [];
    try { tids = readdirSync(`/proc/${pid}/task`); } catch { return; }
    for (const t of tids) for (const c of read(`/proc/${pid}/task/${t}/children`).split(" ")) {
      const n = Number(c);
      if (n && add(n)) { if (jobId) jobOf.push([n, jobId]); walk(n, jobId); }
    }
  };
  ask.jobs.forEach((job, i) => {
    const cg = cgroups[i];
    if (cg) for (const pid of cg.pids) { add(pid); jobOf.push([pid, job.id]); }
    else if (stat(job.pid)) { add(job.pid); jobOf.push([job.pid, job.id]); walk(job.pid, job.id); }
  });
  walk(ask.self);
  const was = new Map(ask.seen);
  const procs: ProcRaw[] = [];
  for (const pid of pids) {
    const st = stat(pid);
    if (!st) continue;
    const s = status(pid);
    procs.push({
      pid, ppid: st.ppid, name: st.name, utime: st.utime, stime: st.stime, start: st.start,
      rss: s.rss, hwm: s.hwm, threads: s.threads, cmdline: read(`/proc/${pid}/cmdline`), fds: fds(pid),
      ...(was.get(pid) === st.name ? {} : { env: environOf(pid) }),
    });
  }
  return { at, pids, jobOf, cgroups, procs };
}
