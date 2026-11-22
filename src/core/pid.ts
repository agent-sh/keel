// What a pid is now. Signal 0 says a process is there for as long as its pid
// is, and a process that exited or was killed keeps its pid for a while:
//   leaving: its threads are still on their way out of the kernel. They hold
//            its files until the last one is out, so its port still takes
//            connections and its locks are still held.
//   ended:   a zombie. It holds nothing, and stays until its parent reads its
//            end: a moment, or for good under a parent that never does.
// Neither comes back. `live` is everything else, and what is said when the
// platform does not tell: nothing is taken from a process on a guess.
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
  if (process.platform === "darwin") {
    // ps: Z is a zombie, E a process that is trying to exit.
    try {
      const p = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
      const stat = p.stdout.toString().trim();
      if (!stat) return there(pid) ? "live" : "gone";
      return stat.includes("Z") ? "ended" : stat.includes("E") ? "leaving" : "live";
    } catch {
      return "live";
    }
  }
  return "live";
}

// A process that works: not one that is going or has ended.
export const pidLive = (pid: number) => pidState(pid) === "live";
// A process that still has what it held (its port, its locks).
export const pidHolds = (pid: number) => { const s = pidState(pid); return s === "live" || s === "leaving"; };
