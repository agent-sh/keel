// What a pid is now. Signal 0 says a process is there for as long as its pid
// is, and a process that exited or was killed keeps its pid for a while:
//   leaving: its threads are still on their way out of the kernel. They hold
//            its files until the last one is out, so its port still takes
//            connections and its locks are still held.
//   ended:   a zombie. It holds nothing, and stays until its parent reads its
//            end: a moment, or for good under a parent that never does.
// Neither comes back. `live` is everything else, and what is said when the
// platform does not tell: nothing is taken from a process on a guess. Only
// Linux tells (its /proc): elsewhere a pid that is there is live, as signal 0
// says.
import { readFileSync } from "node:fs";

export type PidState = "live" | "leaving" | "ended" | "gone";

// A task that is exiting (PF_EXITING in the kernel's sched.h).
const EXITING = 0x4;

const there = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

// The stat line of a process, after its name (which may hold spaces and
// brackets): the state, then ppid, pgrp, session, tty, tpgid and flags; the
// number of threads is the 18th.
export function readStat(line: string): PidState {
  const f = line.slice(line.lastIndexOf(")") + 2).split(" ");
  if (f[0] === "Z" || f[0] === "X") return Number(f[17]) > 1 ? "leaving" : "ended";
  return Number(f[6]) & EXITING ? "leaving" : "live";
}

export function pidState(pid: number): PidState {
  if (!(pid > 0) || !there(pid)) return "gone";
  if (process.platform === "linux") {
    try {
      return readStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      // No line to read: it went meanwhile, or this system shows none.
      return there(pid) ? "live" : "gone";
    }
  }
  return "live";
}

// What names one process for as long as the machine is up: when it started
// (clock ticks since boot, the 22nd field of its stat line) and which boot
// that was. A pid alone does not: it is given to another process once its
// own has gone. Undefined where the platform does not tell.
let boot: string | undefined;
export function pidBorn(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const line = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = line.slice(line.lastIndexOf(")") + 2).split(" ")[19];
    if (!ticks) return undefined;
    boot ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return `${boot}:${ticks}`;
  } catch {
    return undefined;
  }
}

// A process that works: not one that is going or has ended.
export const pidLive = (pid: number) => pidState(pid) === "live";
// A process that still has what it held (its port, its locks).
export const pidHolds = (pid: number) => { const s = pidState(pid); return s === "live" || s === "leaving"; };
