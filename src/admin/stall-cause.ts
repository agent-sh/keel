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
  56: "clone", 57: "fork", 58: "vfork", 59: "execve", 61: "wait4", 72: "fcntl", 73: "flock", 74: "fsync", 75: "fdatasync", 76: "truncate", 77: "ftruncate", 78: "getdents",
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
  215: "munmap", 220: "clone", 221: "execve", 222: "mmap", 227: "msync", 233: "madvise", 242: "accept4", 260: "wait4", 267: "syncfs", 276: "renameat2",
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
// Whether the call's first argument is a descriptor whose link names what it works on.
const onDescriptor = (name: string) => ON_FD.has(name) || AT_DIR.has(name) || EPOLL.has(name);
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
  clone: "starting a thread or a process (clone)", fork: "starting a child (fork)", vfork: "starting a child (vfork)",
  mmap: "in a memory call (mmap)", munmap: "in a memory call (munmap)", madvise: "in a memory call (madvise)",
};

// ---- the files ----

export type ThreadStat = { state: string; user_ticks: number; sys_ticks: number; faults?: number };
// /proc/<pid>/task/<tid>/stat. The name (field 2) may hold spaces and
// brackets: the fields are counted from the last closing bracket.
export function parseStat(text: string): ThreadStat | undefined {
  const at = text.lastIndexOf(")");
  if (at < 0) return undefined;
  const f = text.slice(at + 2).trim().split(/\s+/);
  const user = Number(f[11]), sys = Number(f[12]);
  if (!f[0] || !Number.isFinite(user) || !Number.isFinite(sys)) return undefined;
  // (Page faults, small and large: memory the thread took or had brought back.)
  const faults = Number(f[7]) + Number(f[9]);
  return { state: f[0], user_ticks: user, sys_ticks: sys, ...(Number.isFinite(faults) ? { faults } : {}) };
}

// /proc/<pid>/task/<tid>/io: what the thread read and wrote through system calls so far (files,
// sockets and pipes alike), in bytes and in calls.
export type ThreadIo = { read: number; written: number; reads: number; writes: number };
export function parseIo(text: string): ThreadIo | undefined {
  const n = (k: string) => Number(new RegExp(`^${k}:\\s*(\\d+)`, "m").exec(text)?.[1]);
  const io = { read: n("rchar"), written: n("wchar"), reads: n("syscr"), writes: n("syscw") };
  return Object.values(io).every(Number.isFinite) ? io : undefined;
}

// /proc/<pid>/task/<tid>/syscall: "running" for a thread on a processor or
// runnable, "-1 sp pc" for one blocked outside a call (a page fault), else
// the call's number and its six arguments.
export type RawCall = { nr: number; args: bigint[] };
export function parseSyscall(text: string): RawCall | "running" | undefined {
  const f = text.trim().split(/\s+/);
  if (f[0] === "running") return "running";
  // An empty or unreadable file is no call (an empty string would read as call 0).
  if (!f[0]) return undefined;
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
// A pressure file's total: the time, in ms, some task waited for it since the start.
export function parsePressureTotal(text: string): number | undefined {
  const m = /^some\s.*\btotal=(\d+)/m.exec(text);
  return m ? Number(m[1]) / 1000 : undefined;
}
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
// a pipe); `text` is what the row says. A file is named by its kind or by
// the folder of Keel's own it is under, never by a name the owner chose: a
// worktree's repository, an artifact's or a skill's name, a volume's. Only
// what sits directly in the state or the config folder is shown by name
// (those names are Keel's). A file outside both is not shown at all.
export type Place = { kind: string; text: string };
const within = (path: string, dir: string) => (dir && contains(dir, path) ? relative(dir, path) : undefined);
export function placeOf(link: string, dirs: Dirs): Place {
  const gone = / \(deleted\)$/.test(link);
  const path = link.replace(/ \(deleted\)$/, "");
  const was = gone ? " (deleted since)" : "";
  if (/^pipe:/.test(path)) return { kind: "pipe", text: "a pipe" };
  if (/^socket:/.test(path)) return { kind: "socket", text: "a socket" };
  if (path === "anon_inode:[eventpoll]") return { kind: "epoll", text: "its event queue" };
  if (path === "anon_inode:[pidfd]") return { kind: "pidfd", text: "a process handle" };
  if (/^anon_inode:/.test(path)) return { kind: "anon", text: "an anonymous descriptor" };
  if (/^\/dev\/(pts\/\d+|tty\w*|console)$/.test(path)) return { kind: "terminal", text: "a terminal" };
  if (/^\/dev\/(null|zero|u?random)$/.test(path)) return { kind: `device ${path.slice(5)}`, text: `the device ${path}` };
  if (/^\/dev\//.test(path)) return { kind: "device", text: "a device" };
  if (/^\/(proc|sys)\//.test(path)) return { kind: "kernel", text: "a kernel file (under /proc or /sys)" };
  if (!path.startsWith("/")) return { kind: "other", text: "a descriptor that is no file" };
  // The folder nested in the other is looked at first.
  const order = dirs.config.length > dirs.state.length ? (["config", "state"] as const) : (["state", "config"] as const);
  for (const which of order) {
    const rel = within(path, dirs[which]);
    if (rel === undefined) continue;
    if (!rel) return { kind: which, text: `the ${which} folder` };
    if (which === "state" && rel === "keel.db-wal") return { kind: "store log", text: "the store's log (keel.db-wal)" };
    if (which === "state" && rel === "keel.db") return { kind: "store", text: "the store's database (keel.db)" };
    if (which === "state" && rel === "keel.db-shm") return { kind: "store index", text: "the store's index (keel.db-shm)" };
    const top = rel.split("/")[0]!;
    // Below a folder: the folder is Keel's, what is in it may be named by the owner.
    return rel.includes("/") ? { kind: `${which} ${top}`, text: `a file under ${which}/${top}${was}` } : { kind: `${which} file`, text: `${which}/${top}${was}` };
  }
  return { kind: "outside", text: `a file outside its state and config folders${was}` };
}

// A child's command: its program's name, and its first argument when that
// is a flag's name, a short number, or the subcommand of a program that
// takes one. Anything else (a host, a path, a key, a password glued to its
// flag) is the owner's and is not shown.
const SUBCOMMANDS = new Set(["git", "gh", "systemctl", "systemd-run", "journalctl", "docker", "podman", "bun", "npm", "pnpm", "yarn", "cargo", "go", "tacit"]);
export function commandOf(comm: string | undefined, cmdline: string | undefined): string {
  const argv = (cmdline ?? "").split("\0").filter(Boolean);
  const program = (argv[0]?.split("/").pop() || comm?.trim() || "a process").slice(0, 40);
  const arg = argv[1] ?? "";
  const shown = /^(-[A-Za-z]|--[a-z][a-z-]{0,30})$/.test(arg) || /^\d{1,6}(\.\d{1,3})?$/.test(arg) || (SUBCOMMANDS.has(program) && /^[a-z][a-z-]{0,20}$/.test(arg));
  return shown ? `${program} ${arg}` : program;
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
  stmt?: string;          // the statement the store's connection was in (src/core/statement-label.ts), by its label
  wchan?: string;         // the kernel function it sleeps in
  faults?: number;        // page faults so far
  io?: ThreadIo;          // read and written through system calls so far
  // The watcher did not run either between the sample before and this one:
  // the process was stopped, the machine asleep, or every thread of the
  // process held in memory reclaim (its unit over its memory limit).
  gap?: "stopped" | "suspended" | "memory";
};
// What a call was found to wait on, kept while the thread stays in that
// very call: the same syscall text, no processor time since (a thread that
// left the call and made another ran in between), and the descriptor still
// naming the same file. A descriptor's number is used again for another
// file, and a synchronous spawn waits with the same arguments for another
// child, so the text alone says nothing.
export type CallMemo = { text?: string; run_ns?: number; link?: string; call?: Call };

// One sample from the thread's four files (`read` gives each by name, or
// nothing when it cannot be read). The call is looked up only for a thread
// that is asleep. A sample of a running thread forgets the memo.
export type ThreadFile = "stat" | "schedstat" | "syscall" | "wchan" | "io";
export function sampleOf(t: number, ep: number, read: (file: ThreadFile) => string | undefined, arch: Arch, dirs: Dirs, look: Lookup, memo: CallMemo = {}): Sample | undefined {
  const stat = parseStat(read("stat") ?? "");
  const sched = parseSchedstat(read("schedstat") ?? "");
  if (!stat || !sched) return undefined;
  const s: Sample = { t, ep, state: stat.state, user_ticks: stat.user_ticks, sys_ticks: stat.sys_ticks, run_ns: sched.run_ns, wait_ns: sched.wait_ns };
  // What the thread's time in the kernel was for: its page faults and what it read and wrote.
  if (stat.faults !== undefined) s.faults = stat.faults;
  const io = parseIo(read("io") ?? "");
  if (io) s.io = io;
  const forget = () => { memo.text = memo.run_ns = memo.link = memo.call = undefined; };
  if (stat.state === "R") { forget(); return s; }
  const text = (read("syscall") ?? "").trim();
  const raw = parseSyscall(text);
  if (raw && raw !== "running") {
    const fd = raw.nr >= 0 && onDescriptor(syscallName(raw.nr, arch)) ? int32(raw.args[0]) : -1;
    const link = fd >= 0 ? look.link(fd) : undefined;
    if (!memo.call || memo.text !== text || memo.run_ns !== sched.run_ns || memo.link !== link) {
      memo.text = text; memo.run_ns = sched.run_ns; memo.link = link;
      memo.call = callOf(raw, arch, dirs, look);
    }
    s.call = memo.call;
  } else forget();
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
  memory_unit?: boolean;                                      // the memory stall was read from the daemon's own unit (else the machine's)
  memory_stall_ms?: number;                                   // some task waited for memory this long during a pause that was not all of that
};
export type CauseKind = "compute" | "cpu_wait" | "call" | "child" | "disk" | "memory" | "stopped" | "suspended" | "unknown";
export type Share = { kind: CauseKind; key: string; what: string; ms: number };
export type Cause = Around & {
  kind: CauseKind;
  key: string;          // what repeats of this cause share: the Errors row is one per key
  text: string;         // "2.1 s waiting for a processor (machine load 22, CPU pressure 41%)"
  also?: string;        // the same for what else took a real part of it, after the first
  sampled_ms: number;   // how much time the watcher saw the loop held
  shares: Share[];      // the largest first; they do not overlap and sum to no more than the stall
  run_ms?: number;      // on a processor
  kernel_ms?: number;   // of that, in the kernel
  wait_ms?: number;     // runnable, waiting for a processor
  call?: { name: string; on?: string; child?: { pid: number; command: string } };
  statement?: string;   // the statement of the store's connection the main part was spent in, by its label
  state?: string;
  wchan?: string;
  note?: string;
};

// The watcher cannot name the code of a stall that computed, and the row says so.
export const UNSEEN = "which code is not visible from the watcher's thread (no JavaScript frames across threads): only a section the daemon times names it";
// What a pause of the whole process is called. A SIGCONT as it ends makes it a signal's (stall-watch.ts).
export const STOPPED = "stopped (a stop signal, a debugger or a frozen unit)";
export const STOPPED_OR_MEMORY = "not running: stopped, or waiting for memory";
export const unknown = (text: string): Cause => ({ kind: "unknown", key: "unknown", text, sampled_ms: 0, shares: [] });

// The watcher's samples of one stall, in order. `stallMs`: how long the
// loop says it was held, at least; `windowMs`: the time since its last tick
// on time, which the stall lies in (idle, the loop measures a stall up to a
// second short, and the watcher may have seen more of it).
//
// The parts do not overlap. Time on a processor and time runnable and
// waiting for one are schedstat's own two counters and nothing else. A
// pause of the whole process is the watcher's own gap. What is left was
// spent asleep, and goes to the calls the samples showed the thread asleep
// in, in their proportions. Together they are what was seen, cut to the
// stall when more was seen than the stall can hold.
// What the thread's time in the kernel was spent on, as far as its counters say: a megabyte or
// more read or written (a file, a socket, a pipe), memory taken (a page fault each four
// kilobytes), or calls too many to be anything else. With none of these, only that it was calls.
const KERNEL_BYTES = 1_000_000, KERNEL_FAULTS = 5_000, KERNEL_CALLS = 2_000;
const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
const count = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;
export function kernelWork(d: { faults: number; read: number; written: number; reads: number; writes: number }): string {
  const parts = [
    d.read >= KERNEL_BYTES ? `reading ${size(d.read)} in ${count(d.reads, "call")}` : "",
    d.written >= KERNEL_BYTES ? `writing ${size(d.written)} in ${count(d.writes, "call")}` : "",
    d.faults >= KERNEL_FAULTS ? `taking memory (${count(d.faults, "page fault")}, about ${size(d.faults * 4096)})` : "",
  ].filter(Boolean);
  if (parts.length) return parts.join(", ");
  const calls = d.reads + d.writes;
  return calls >= KERNEL_CALLS ? `for ${calls.toLocaleString("en-US")} small reads and writes of its own` : "for system calls of its own";
}

export function decide(samples: Sample[], around: Around, stallMs: number, windowMs = stallMs): Cause {
  let run = 0, wait = 0, user = 0, sys = 0, seen = 0;
  // While it ran: page faults, and bytes and calls read and written.
  const did = { faults: 0, read: 0, written: 0, reads: 0, writes: 0 };
  const gaps = { stopped: 0, suspended: 0, memory: 0 };
  // Asleep or stopped, by what the thread was seen in at the start of each stretch.
  const asleep = new Map<string, { kind: CauseKind; what: string; ms: number; sample: Sample }>();
  // On a processor inside a statement of the store's connection, by the statement's label.
  const inStatement = new Map<string, number>();
  let ran = 0;
  // A wait or a read made for a statement of the store says which one.
  const of = (a: Sample) => (a.stmt ? `, in the statement: ${a.stmt}` : "");
  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i]!, b = samples[i + 1]!;
    if (a.ep !== b.ep) continue;
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    const r = Math.max(0, (b.run_ns - a.run_ns) / 1e6), w = Math.max(0, (b.wait_ns - a.wait_ns) / 1e6);
    seen += dt; run += r; wait += w;
    user += Math.max(0, b.user_ticks - a.user_ticks); sys += Math.max(0, b.sys_ticks - a.sys_ticks);
    if (b.gap) { gaps[b.gap] += Math.max(0, dt - r - w); continue; }
    // Running or runnable: both are in the two counters already.
    if (a.state === "R") {
      ran += dt;
      if (a.faults !== undefined && b.faults !== undefined) did.faults += Math.max(0, b.faults - a.faults);
      if (a.io && b.io) { did.read += Math.max(0, b.io.read - a.io.read); did.written += Math.max(0, b.io.written - a.io.written); did.reads += Math.max(0, b.io.reads - a.io.reads); did.writes += Math.max(0, b.io.writes - a.io.writes); }
      if (a.stmt) inStatement.set(a.stmt, (inStatement.get(a.stmt) ?? 0) + dt);
      continue;
    }
    const stopped = a.state === "T" || a.state === "t";
    const key = stopped ? "stopped" : a.call ? callKey(a.call) : `asleep ${a.state}`;
    const had = asleep.get(key);
    const what = stopped ? "stopped (a stop signal or a debugger held its thread)" : `${a.call ? callWords(a.call) : a.state === "D" ? "waiting for the disk" : "asleep outside a system call"}${of(a)}`;
    if (had) { had.ms += dt; had.sample = a; had.what = what; }
    else asleep.set(key, {
      kind: stopped ? "stopped" : a.call?.child ? "child" : a.call && a.call.name !== "none" ? "call" : a.state === "D" ? "disk" : "unknown",
      what, ms: dt, sample: a,
    });
  }
  if (seen <= 0) return { ...unknown("the watcher saw none of it"), ...around };
  // A wait for a processor is counted when it ends, so one that began before
  // the first sample is in the counter whole: each part is cut to what is left.
  const paused = Math.min(seen, gaps.stopped + gaps.suspended + gaps.memory);
  run = Math.min(run, seen - paused);
  wait = Math.min(wait, seen - paused - run);
  const rest = seen - paused - run - wait;
  const weight = [...asleep.values()].reduce((n, a) => n + a.ms, 0);
  const shares: (Share & { sample?: Sample })[] = [];
  // Processor time in the kernel is a system call's work (a large write, memory being mapped), not JavaScript.
  const kernel = user + sys > 0 && sys / (user + sys) >= 0.6;
  // Most of its time on a processor inside one statement of the store: the statement is the code.
  const [busiest, inIt] = [...inStatement].sort((x, y) => y[1] - x[1])[0] ?? [undefined, 0];
  const computed = busiest && inIt >= ran / 2 ? busiest : undefined;
  if (run > 0) shares.push({ kind: "compute", key: "compute", what: `${kernel ? `on a processor in the kernel, ${kernelWork(did)}` : "in its own code"}${computed ? `, in the statement: ${computed}` : ""}`, ms: run });
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
  if (gaps.memory > 0) shares.push({ kind: "memory", key: "memory", what: around.memory_unit === false ? "waiting for memory (the machine is short of it)" : "waiting for memory (its unit is over its memory limit)", ms: gaps.memory });
  // A pause in which the memory stall grew, but by less than half of it, is not called a stop alone.
  if (gaps.stopped > 0) shares.push({ kind: "stopped", key: "stopped", what: around.memory_stall_ms ? `${STOPPED_OR_MEMORY} (the memory stall grew ${secs(around.memory_stall_ms)} meanwhile)` : STOPPED, ms: gaps.stopped });
  if (weight > 0) for (const [key, a] of asleep) {
    const io = a.kind === "disk" || (a.sample.state === "D" && a.kind === "call");
    const bits = [
      io && around.pressure?.io !== undefined ? `IO pressure ${Math.round(around.pressure.io)}%` : "",
      a.kind === "disk" && (around.pressure?.memory ?? 0) >= 10 ? `memory pressure ${Math.round(around.pressure!.memory!)}%` : "",
    ].filter(Boolean);
    shares.push({ kind: a.kind, key, what: `${a.what}${bits.length ? ` (${bits.join(", ")})` : ""}`, ms: rest * (a.ms / weight), sample: a.sample });
  } else if (rest >= 100) shares.push({ kind: "unknown", key: "unknown", what: "off a processor, in no call the watcher saw", ms: rest });
  // More was seen than the stall can hold (samples from just before it): the parts keep their proportions.
  const limit = Math.max(stallMs, Math.min(seen, windowMs));
  const total = shares.reduce((n, x) => n + x.ms, 0);
  if (total > limit) for (const x of shares) x.ms *= limit / total;
  shares.sort((x, y) => y.ms - x.ms);
  const main = shares[0];
  if (!main) return { ...unknown("the watcher saw none of it"), ...around };
  // The row names what took a real part of it: at most three, each a sixth of what was seen or more.
  const named = shares.filter((x, i) => i === 0 || (i < 3 && x.ms >= Math.max(100, Math.min(seen, limit) / 6)));
  const part = (x: Share) => (x.kind === "suspended" && x.ms >= Math.min(seen, limit) * 0.8 ? "the machine was suspended" : `${secs(x.ms)} ${x.what}`);
  const partial = seen < stallMs * 0.6 ? ` (seen for the last ${secs(seen)} of it)` : "";
  const at = main.sample;
  const scale = total > limit ? limit / total : 1;
  return {
    ...around,
    kind: main.kind,
    key: main.key,
    text: `${named.map(part).join(", ")}${partial}`,
    ...(named.length > 1 ? { also: named.slice(1).map(part).join(", ") } : {}),
    sampled_ms: Math.round(seen),
    shares: shares.slice(0, 6).map(({ kind, key, what, ms }) => ({ kind, key, what, ms: Math.round(ms) })),
    run_ms: Math.round(run * scale),
    ...(user + sys > 0 ? { kernel_ms: Math.round(run * scale * (sys / (user + sys))) } : {}),
    wait_ms: Math.round(wait * scale),
    ...(at?.call && at.call.name !== "none" ? { call: { name: at.call.name, ...(at.call.on ? { on: at.call.on.text } : {}), ...(at.call.child ? { child: at.call.child } : {}) } } : {}),
    ...(at?.stmt ?? (main.kind === "compute" ? computed : undefined) ? { statement: at?.stmt ?? computed } : {}),
    ...(at ? { state: at.state } : {}),
    ...(at?.wchan ? { wchan: at.wchan } : {}),
    ...(main.kind === "compute" && !kernel && !computed ? { note: UNSEEN } : {}),
  };
}
