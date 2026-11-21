// What took the time of a stall, from what the kernel says about the
// daemon's main thread while its loop did not run (stall-watch.ts samples it
// from a thread of its own, about ten times a second, from /proc).
//
// A thread that does not run is in one of a few places, and each needs
// another fix:
// - on a processor, in the daemon's own code (schedstat's run time grows);
// - runnable and waiting for a processor (schedstat's wait time grows: exact
//   proof of a starved machine or a unit over its quota);
// - asleep in a system call of its own: a sync of a file, a read, a wait for
//   a child (the syscall file names the call and its first arguments, and
//   the descriptor names the file, the pipe or the child);
// - stopped by a signal, or the whole machine asleep.
// Here: the parsers of those files, the names of the calls, and the decision.
// Nothing here reads a file, so recorded samples test all of it.

import { relative } from "node:path";
import { contains } from "../core/paths.ts";
import { secs } from "./stall-rows.ts";

export type Arch = "x64" | "arm64";

// The calls a daemon can sit in, by number, per architecture (the kernel's
// syscall_64.tbl and the generic table arm64 uses).
const X64: Record<number, string> = {
  0: "read", 1: "write", 2: "open", 3: "close", 4: "stat", 5: "fstat", 6: "lstat", 7: "poll", 8: "lseek", 9: "mmap", 11: "munmap",
  16: "ioctl", 17: "pread64", 18: "pwrite64", 19: "readv", 20: "writev", 21: "access", 23: "select", 26: "msync", 28: "madvise",
  35: "nanosleep", 40: "sendfile", 42: "connect", 43: "accept", 44: "sendto", 45: "recvfrom", 46: "sendmsg", 47: "recvmsg",
  59: "execve", 61: "wait4", 72: "fcntl", 73: "flock", 74: "fsync", 75: "fdatasync", 76: "truncate", 77: "ftruncate", 78: "getdents",
  82: "rename", 83: "mkdir", 84: "rmdir", 87: "unlink", 89: "readlink", 162: "sync", 202: "futex", 217: "getdents64",
  230: "clock_nanosleep", 232: "epoll_wait", 247: "waitid", 257: "openat", 258: "mkdirat", 262: "newfstatat", 263: "unlinkat",
  264: "renameat", 267: "readlinkat", 269: "faccessat", 270: "pselect6", 271: "ppoll", 277: "sync_file_range", 281: "epoll_pwait",
  285: "fallocate", 288: "accept4", 295: "preadv", 296: "pwritev", 306: "syncfs", 316: "renameat2", 326: "copy_file_range",
  327: "preadv2", 328: "pwritev2", 332: "statx", 426: "io_uring_enter", 435: "clone3", 439: "faccessat2", 441: "epoll_pwait2",
};
const ARM64: Record<number, string> = {
  22: "epoll_pwait", 25: "fcntl", 29: "ioctl", 32: "flock", 34: "mkdirat", 35: "unlinkat", 38: "renameat", 45: "truncate", 46: "ftruncate",
  47: "fallocate", 48: "faccessat", 56: "openat", 57: "close", 61: "getdents64", 62: "lseek", 63: "read", 64: "write", 65: "readv",
  66: "writev", 67: "pread64", 68: "pwrite64", 69: "preadv", 70: "pwritev", 71: "sendfile", 72: "pselect6", 73: "ppoll", 78: "readlinkat",
  79: "newfstatat", 80: "fstat", 81: "sync", 82: "fsync", 83: "fdatasync", 84: "sync_file_range", 95: "waitid", 98: "futex",
  101: "nanosleep", 115: "clock_nanosleep", 202: "accept", 203: "connect", 206: "sendto", 207: "recvfrom", 211: "sendmsg", 212: "recvmsg",
  215: "munmap", 221: "execve", 222: "mmap", 227: "msync", 233: "madvise", 242: "accept4", 260: "wait4", 267: "syncfs", 276: "renameat2",
  285: "copy_file_range", 286: "preadv2", 287: "pwritev2", 291: "statx", 426: "io_uring_enter", 435: "clone3", 439: "faccessat2",
  441: "epoll_pwait2",
};
export const syscallName = (nr: number, arch: Arch): string => (arch === "arm64" ? ARM64 : X64)[nr] ?? `system call ${nr}`;

// Calls whose first argument is the descriptor they work on.
const ON_FD = new Set([
  "read", "pread64", "readv", "preadv", "preadv2", "write", "pwrite64", "writev", "pwritev", "pwritev2", "fsync", "fdatasync", "syncfs",
  "sync_file_range", "flock", "fcntl", "getdents", "getdents64", "ftruncate", "fallocate", "lseek", "fstat", "ioctl", "connect", "accept",
  "accept4", "sendto", "recvfrom", "sendmsg", "recvmsg", "copy_file_range", "io_uring_enter", "close",
]);
// Calls that take a folder's descriptor and a path: the path is the caller's memory and is not read.
const AT_DIR = new Set(["openat", "mkdirat", "unlinkat", "renameat", "renameat2", "readlinkat", "newfstatat", "statx", "faccessat", "faccessat2"]);
const EPOLL = new Set(["epoll_wait", "epoll_pwait", "epoll_pwait2"]);
// What the call was doing, in words; `%` is where the file goes.
const WORDS: Record<string, string> = {
  read: "reading %", pread64: "reading %", readv: "reading %", preadv: "reading %", preadv2: "reading %",
  write: "writing %", pwrite64: "writing %", writev: "writing %", pwritev: "writing %", pwritev2: "writing %",
  fsync: "in fsync of %", fdatasync: "in fdatasync of %", syncfs: "in syncfs of %", sync_file_range: "in sync_file_range of %", sync: "in sync",
  msync: "in msync", flock: "waiting for a lock on %", fcntl: "in fcntl on % (a file lock)", getdents: "listing %", getdents64: "listing %",
  ftruncate: "cutting %", fallocate: "making room in %", copy_file_range: "copying %", lseek: "in lseek on %", fstat: "in fstat on %",
  ioctl: "in ioctl on %", connect: "connecting %", accept: "accepting on %", accept4: "accepting on %", sendto: "sending on %",
  sendmsg: "sending on %", recvfrom: "receiving from %", recvmsg: "receiving from %", io_uring_enter: "waiting in io_uring",
  close: "closing %", open: "opening a file", openat: "opening a file", stat: "reading a file's details", lstat: "reading a file's details",
  newfstatat: "reading a file's details", statx: "reading a file's details", access: "checking a file", faccessat: "checking a file",
  faccessat2: "checking a file", unlink: "deleting a file", unlinkat: "deleting a file", rmdir: "deleting a folder", rename: "renaming a file",
  renameat: "renaming a file", renameat2: "renaming a file", mkdir: "making a folder", mkdirat: "making a folder", readlink: "reading a link",
  readlinkat: "reading a link", truncate: "cutting a file", sendfile: "copying between descriptors (sendfile)",
  futex: "waiting for another of its threads (futex)", nanosleep: "sleeping (nanosleep)", clock_nanosleep: "sleeping (clock_nanosleep)",
  poll: "waiting on descriptors (poll)", ppoll: "waiting on descriptors (ppoll)", select: "waiting on descriptors (select)",
  pselect6: "waiting on descriptors (pselect6)", epoll_wait: "waiting in a loop of its own (epoll_wait)",
  epoll_pwait: "waiting in a loop of its own (epoll_pwait)", epoll_pwait2: "waiting in a loop of its own (epoll_pwait2)",
  wait4: "waiting for a child", waitid: "waiting for a child", execve: "starting a program (execve)", clone3: "starting a thread or a process (clone3)",
  mmap: "in a memory call (mmap)", munmap: "in a memory call (munmap)", madvise: "in a memory call (madvise)",
};

// ---- the files ----

export type ThreadStat = { state: string; user_ticks: number; sys_ticks: number };
// /proc/<pid>/task/<tid>/stat. The name (field 2) may hold spaces and
// brackets: the fields are counted from the last closing bracket.
export function parseStat(text: string): ThreadStat | undefined {
  const at = text.lastIndexOf(")");
  if (at < 0) return undefined;
  const f = text.slice(at + 2).trim().split(/\s+/);
  const user = Number(f[11]), sys = Number(f[12]);
  if (!f[0] || !Number.isFinite(user) || !Number.isFinite(sys)) return undefined;
  return { state: f[0], user_ticks: user, sys_ticks: sys };
}

// /proc/<pid>/task/<tid>/syscall: "running" for a thread on a processor or
// runnable, "-1 sp pc" for one blocked outside a call (a page fault), else
// the call's number and its six arguments.
export type RawCall = { nr: number; args: bigint[] };
export function parseSyscall(text: string): RawCall | "running" | undefined {
  const f = text.trim().split(/\s+/);
  if (f[0] === "running") return "running";
  const nr = Number(f[0]);
  if (!Number.isInteger(nr)) return undefined;
  if (nr < 0) return { nr: -1, args: [] };
  const args: bigint[] = [];
  for (const a of f.slice(1, 7)) { try { args.push(BigInt(a)); } catch { args.push(0n); } }
  return { nr, args };
}

// /proc/<pid>/task/<tid>/schedstat: nanoseconds on a processor, nanoseconds
// runnable and waiting for one, and the number of runs.
export function parseSchedstat(text: string): { run_ns: number; wait_ns: number } | undefined {
  const f = text.trim().split(/\s+/).map(Number);
  return Number.isFinite(f[0]) && Number.isFinite(f[1]) ? { run_ns: f[0]!, wait_ns: f[1]! } : undefined;
}

// /proc/pressure/<what>: the share of the last ten seconds in which some task waited for it.
export function parsePressure(text: string): number | undefined {
  const m = /^some\s+avg10=([\d.]+)/m.exec(text);
  return m ? Number(m[1]) : undefined;
}
export const parseLoad = (text: string): number | undefined => { const v = Number(text.trim().split(/\s+/)[0]); return Number.isFinite(v) ? v : undefined; };
// A cgroup's cpu.stat: the time its tasks were held back by its quota.
export function parseThrottled(text: string): number | undefined {
  const m = /^throttled_usec\s+(\d+)/m.exec(text);
  return m ? Number(m[1]) / 1000 : undefined;
}
// A descriptor's fdinfo: the process a pidfd names, the descriptors an epoll watches.
export const parsePidfd = (text: string): number | undefined => { const m = /^Pid:\s+(\d+)/m.exec(text); return m ? Number(m[1]) : undefined; };
export const parseEpoll = (text: string): number[] => [...text.matchAll(/^tfd:\s+(\d+)/gm)].map((m) => Number(m[1]));

// ---- names ----

export type Dirs = { state: string; config: string };
// `kind` is what repeats of one cause share (the store's log, a worktree,
// a pipe); `text` is what the row says. A path is shown relative to the
// state or the config folder, a few folders deep; one outside both is not
// shown at all.
export type Place = { kind: string; text: string };
const within = (path: string, dir: string) => (dir && contains(dir, path) ? relative(dir, path) : undefined);
const short = (rel: string, depth = 3) => { const p = rel.split("/"); return p.length > depth ? `${p.slice(0, depth).join("/")}/...` : rel; };
export function placeOf(link: string, dirs: Dirs): Place {
  const gone = / \(deleted\)$/.test(link);
  const path = link.replace(/ \(deleted\)$/, "");
  const was = gone ? " (deleted since)" : "";
  if (/^pipe:/.test(path)) return { kind: "pipe", text: "a pipe" };
  if (/^socket:/.test(path)) return { kind: "socket", text: "a socket" };
  if (path === "anon_inode:[eventpoll]") return { kind: "epoll", text: "its event queue" };
  if (path === "anon_inode:[pidfd]") return { kind: "pidfd", text: "a process handle" };
  if (/^anon_inode:/.test(path)) return { kind: "anon", text: `an anonymous descriptor (${path.slice(11).replace(/[[\]]/g, "")})` };
  if (/^\/dev\/(pts\/\d+|tty\w*|console)$/.test(path)) return { kind: "terminal", text: "a terminal" };
  if (/^\/dev\//.test(path)) return { kind: `device ${path}`, text: `the device ${path}` };
  if (/^\/(proc|sys)\//.test(path)) return { kind: "kernel", text: "a kernel file (under /proc or /sys)" };
  if (!path.startsWith("/")) return { kind: "other", text: "a descriptor that is no file" };
  // The folder nested in the other is looked at first.
  const order = dirs.config.length > dirs.state.length ? (["config", "state"] as const) : (["state", "config"] as const);
  for (const which of order) {
    const rel = within(path, dirs[which]);
    if (rel === undefined) continue;
    if (which === "config") return { kind: `config ${rel.split("/")[0]}`, text: `${rel ? `config/${short(rel)}` : "the config folder"}${was}` };
    if (rel === "keel.db-wal") return { kind: "store log", text: "the store's log (keel.db-wal)" };
    if (rel === "keel.db") return { kind: "store", text: "the store's database (keel.db)" };
    if (rel === "keel.db-shm") return { kind: "store index", text: "the store's index (keel.db-shm)" };
    const wt = /^worktrees\/([^/]+)/.exec(rel);
    if (wt) return { kind: "worktree", text: `a file under worktrees/${wt[1]}${was}` };
    return { kind: `state ${rel.split("/")[0]}`, text: `${rel ? `state/${short(rel)}` : "the state folder"}${was}` };
  }
  return { kind: "outside", text: `a file outside its state and config folders${was}` };
}

// A child's command: its program's name and its first argument, never the rest.
export function commandOf(comm: string | undefined, cmdline: string | undefined): string {
  const argv = (cmdline ?? "").split("\0").filter(Boolean);
  const program = (argv[0]?.split("/").pop() || comm?.trim() || "a process").slice(0, 40);
  const first = argv[1] && !argv[1].startsWith("/") && !/[=:@]/.test(argv[1]) ? argv[1].slice(0, 40) : "";
  return first ? `${program} ${first}` : program;
}

// What the watcher looks up for a call's arguments (the real one reads
// /proc; a test answers from a recording).
export type Lookup = {
  link(fd: number): string | undefined;        // readlink /proc/self/fd/<fd>
  pidfd(fd: number): number | undefined;       // the process a pidfd names
  epoll(fd: number): number[];                 // the descriptors an epoll watches
  child(pid: number): string | undefined;      // commandOf a child's comm and cmdline
};

export type Call = {
  name: string;                 // fsync, epoll_pwait2
  on?: Place;                   // the file, pipe or socket it works on
  child?: { pid: number; command: string };
};
const int32 = (v: bigint | undefined) => Number(BigInt.asIntN(32, v ?? 0n));

export function callOf(raw: RawCall, arch: Arch, dirs: Dirs, look: Lookup): Call {
  if (raw.nr < 0) return { name: "none" };
  const name = syscallName(raw.nr, arch);
  const fd = int32(raw.args[0]);
  const childOf = (pid: number | undefined) => (pid && pid > 0 ? { pid, command: look.child(pid) ?? "a process that is gone" } : undefined);
  if (name === "wait4") return { name, child: childOf(fd) };
  if (name === "waitid") {
    // The kind of id: 1 a process, 3 a pidfd.
    const kind = int32(raw.args[0]), id = int32(raw.args[1]);
    return { name, child: childOf(kind === 1 ? id : kind === 3 ? look.pidfd(id) : undefined) };
  }
  if (EPOLL.has(name)) {
    // A loop inside the loop: a synchronous child is waited for through its
    // pidfd in an event queue of its own.
    for (const t of look.epoll(fd)) {
      if (look.link(t) !== "anon_inode:[pidfd]") continue;
      const child = childOf(look.pidfd(t));
      if (child) return { name, child };
    }
    return { name };
  }
  if (ON_FD.has(name) || (AT_DIR.has(name) && fd >= 0)) {
    const link = fd >= 0 ? look.link(fd) : undefined;
    return link ? { name, on: placeOf(link, dirs) } : { name };
  }
  return { name };
}

const callWords = (c: Call): string => {
  if (c.child) return `waiting for a child: ${c.child.command} (pid ${c.child.pid})`;
  if (c.name === "none") return "waiting for the disk to bring its memory back (a page fault)";
  const w = WORDS[c.name];
  if (!w) return `in ${c.name}${c.on ? ` on ${c.on.text}` : ""}`;
  if (w.includes("%")) return w.replace("%", c.on?.text ?? "a file");
  return c.on && c.on.kind !== "outside" ? `${w} under ${c.on.text}` : w;
};
// What repeats of the cause share: the call and the kind of thing it works on, never a pid.
const callKey = (c: Call): string => (c.child ? `child ${c.child.command.split(" ")[0]}` : `${c.name}${c.on ? ` ${c.on.kind}` : ""}`);

// ---- the decision ----

export type Sample = {
  t: number;              // the watcher's own clock, ms
  ep: number;             // the run of samples it belongs to: time is counted between two of one run
  state: string;          // R running or runnable, S asleep, D waiting for the disk, T or t stopped
  run_ns: number;
  wait_ns: number;
  user_ticks: number;
  sys_ticks: number;
  call?: Call;            // what it was asleep in
  wchan?: string;         // the kernel function it sleeps in
  // The watcher did not run either between the sample before and this one:
  // the process was stopped, or the machine asleep.
  gap?: "stopped" | "suspended";
};
// One sample from the thread's four files (`read` gives each by name, or
// nothing when it cannot be read). The call is looked up only for a thread
// that is asleep, and not again while the syscall file says the same.
export type ThreadFile = "stat" | "schedstat" | "syscall" | "wchan";
export function sampleOf(t: number, ep: number, read: (file: ThreadFile) => string | undefined, arch: Arch, dirs: Dirs, look: Lookup, memo: { text?: string; call?: Call } = {}): Sample | undefined {
  const stat = parseStat(read("stat") ?? "");
  const sched = parseSchedstat(read("schedstat") ?? "");
  if (!stat || !sched) return undefined;
  const s: Sample = { t, ep, state: stat.state, user_ticks: stat.user_ticks, sys_ticks: stat.sys_ticks, run_ns: sched.run_ns, wait_ns: sched.wait_ns };
  if (stat.state === "R") return s;
  const text = (read("syscall") ?? "").trim();
  const raw = parseSyscall(text);
  if (raw && raw !== "running") {
    if (memo.text !== text || !memo.call) { memo.text = text; memo.call = callOf(raw, arch, dirs, look); }
    s.call = memo.call;
  }
  const wchan = read("wchan")?.trim();
  if (wchan && wchan !== "0") s.wchan = wchan;
  return s;
}

// What the machine said meanwhile.
export type Around = {
  load?: number;                                              // the one-minute load average
  pressure?: { cpu?: number; io?: number; memory?: number };  // some avg10, percent
  throttled_ms?: number;                                      // the unit's quota held its tasks back this long, summed over processors
  suspended_ms?: number;                                      // the boot-time clock ran this much further than the monotonic one
  cont?: boolean;                                             // a SIGCONT arrived as it ended
};
export type CauseKind = "compute" | "cpu_wait" | "call" | "child" | "disk" | "stopped" | "suspended" | "unknown";
export type Share = { kind: CauseKind; key: string; what: string; ms: number };
export type Cause = Around & {
  kind: CauseKind;
  key: string;          // what repeats of this cause share: the Errors row is one per key
  text: string;         // "2.1 s waiting for a processor (machine load 22, CPU pressure 41%)"
  also?: string;        // the same for what else took a real part of it, after the first
  sampled_ms: number;   // how much of the stall the watcher saw
  shares: Share[];      // the largest first
  run_ms?: number;      // on a processor
  kernel_ms?: number;   // of that, in the kernel
  wait_ms?: number;     // runnable, waiting for a processor
  call?: { name: string; on?: string; child?: { pid: number; command: string } };
  state?: string;
  wchan?: string;
  note?: string;
};

// The watcher cannot name the code of a stall that computed, and the row says so.
export const UNSEEN = "which code is not visible from the watcher's thread (no JavaScript frames across threads): only a section the daemon times names it";
export const unknown = (text: string): Cause => ({ kind: "unknown", key: "unknown", text, sampled_ms: 0, shares: [] });

// The watcher's samples of one stall, in order. `stallMs`: how long the loop says it was held.
export function decide(samples: Sample[], around: Around, stallMs: number): Cause {
  let run = 0, wait = 0, user = 0, sys = 0, seen = 0, runnable = 0;
  const gaps = { stopped: 0, suspended: 0 };
  // Asleep or stopped, by what the thread was seen in at the start of each stretch.
  const asleep = new Map<string, { kind: CauseKind; what: string; ms: number; sample: Sample }>();
  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i]!, b = samples[i + 1]!;
    if (a.ep !== b.ep) continue;
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    const r = Math.max(0, (b.run_ns - a.run_ns) / 1e6), w = Math.max(0, (b.wait_ns - a.wait_ns) / 1e6);
    seen += dt; run += r; wait += w;
    user += Math.max(0, b.user_ticks - a.user_ticks); sys += Math.max(0, b.sys_ticks - a.sys_ticks);
    if (b.gap) { gaps[b.gap] += Math.max(0, dt - r - w); continue; }
    if (a.state === "R") { runnable += dt; continue; }
    const stopped = a.state === "T" || a.state === "t";
    const key = stopped ? "stopped" : a.call ? callKey(a.call) : `asleep ${a.state}`;
    const had = asleep.get(key);
    if (had) { had.ms += dt; had.sample = a; }
    else asleep.set(key, {
      kind: stopped ? "stopped" : a.call?.child ? "child" : a.call && a.call.name !== "none" ? "call" : a.state === "D" ? "disk" : "unknown",
      what: stopped ? "stopped (a stop signal or a debugger held its thread)" : a.call ? callWords(a.call) : a.state === "D" ? "waiting for the disk" : "asleep outside a system call",
      ms: dt, sample: a,
    });
  }
  if (seen <= 0) return { ...unknown("the watcher saw none of it"), ...around };
  // A wait for a processor is counted when it ends, so one that began before the first sample is in it whole.
  const paused = gaps.stopped + gaps.suspended;
  run = Math.min(run, seen - paused);
  wait = Math.min(wait, Math.max(0, seen - paused - run));
  // What is left was spent off a processor: asleep in what the samples
  // showed, in their proportions. A thread seen runnable and not running was
  // waiting for a processor, whether or not that wait is counted yet.
  let rest = Math.max(0, seen - paused - run - wait);
  const weight = [...asleep.values()].reduce((n, a) => n + a.ms, 0);
  if (weight + runnable > 0) { const queued = rest * (runnable / (weight + runnable)); wait += queued; rest -= queued; }
  const shares: (Share & { sample?: Sample })[] = [];
  // Processor time in the kernel is a system call's work (a large write, memory being mapped), not JavaScript.
  const kernel = user + sys > 0 && sys / (user + sys) >= 0.6;
  if (run > 0) shares.push({ kind: "compute", key: "compute", what: kernel ? "on a processor in the kernel, for system calls of its own" : "in its own code", ms: run });
  if (wait > 0) {
    const bits = [
      around.load !== undefined ? `machine load ${Math.round(around.load)}` : "",
      around.pressure?.cpu !== undefined ? `CPU pressure ${Math.round(around.pressure.cpu)}%` : "",
      // Summed over the processors the unit was held on: more than the wall time, so no number is said.
      around.throttled_ms && around.throttled_ms >= 100 ? "held back by its unit's processor quota" : "",
    ].filter(Boolean);
    shares.push({ kind: "cpu_wait", key: "cpu_wait", what: `waiting for a processor${bits.length ? ` (${bits.join(", ")})` : ""}`, ms: wait });
  }
  if (gaps.suspended > 0) shares.push({ kind: "suspended", key: "suspended", what: "with the machine suspended (going to sleep or waking)", ms: gaps.suspended });
  if (gaps.stopped > 0) shares.push({ kind: "stopped", key: "stopped", what: "stopped (a stop signal, a debugger or a frozen unit)", ms: gaps.stopped });
  if (weight > 0) for (const [key, a] of asleep) {
    const io = a.kind === "disk" || (a.sample.state === "D" && a.kind === "call");
    const bits = io && around.pressure?.io !== undefined ? ` (IO pressure ${Math.round(around.pressure.io)}%)` : "";
    shares.push({ kind: a.kind, key, what: `${a.what}${bits}`, ms: rest * (a.ms / weight), sample: a.sample });
  } else if (rest >= 100) shares.push({ kind: "unknown", key: "unknown", what: "not running, in no call the watcher saw", ms: rest });
  shares.sort((x, y) => y.ms - x.ms);
  const main = shares[0];
  if (!main) return { ...unknown("the watcher saw none of it"), ...around };
  // The row names what took a real part of it: at most three, each a sixth of what was seen or more.
  const named = shares.filter((s, i) => i === 0 || (i < 3 && s.ms >= Math.max(100, seen / 6)));
  // Idle, the loop measures a stall up to a second short, and the watcher may have seen more of it: the row's parts stay within its length.
  const part = (s: Share) => (s.kind === "suspended" && s.ms >= seen * 0.8 ? "the machine was suspended" : `${secs(Math.min(s.ms, Math.max(stallMs, 0) || s.ms))} ${s.what}`);
  const partial = seen < stallMs * 0.6 ? ` (seen for the last ${secs(seen)} of it)` : "";
  const at = main.sample;
  return {
    ...around,
    kind: main.kind,
    key: main.key,
    text: `${named.map(part).join(", ")}${partial}`,
    ...(named.length > 1 ? { also: named.slice(1).map(part).join(", ") } : {}),
    sampled_ms: Math.round(seen),
    shares: shares.slice(0, 6).map(({ kind, key, what, ms }) => ({ kind, key, what, ms: Math.round(ms) })),
    run_ms: Math.round(run),
    ...(user + sys > 0 ? { kernel_ms: Math.round(run * (sys / (user + sys))) } : {}),
    wait_ms: Math.round(wait),
    ...(at?.call && at.call.name !== "none" ? { call: { name: at.call.name, ...(at.call.on ? { on: at.call.on.text } : {}), ...(at.call.child ? { child: at.call.child } : {}) } } : {}),
    ...(at ? { state: at.state } : {}),
    ...(at?.wchan ? { wchan: at.wchan } : {}),
    ...(main.kind === "compute" && !kernel ? { note: UNSEEN } : {}),
  };
}
