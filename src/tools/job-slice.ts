// Which slice of the user manager a job's scope goes in (src/tools/jobs.ts, src/checks/before-run.ts).
//
// Each job has a scope of its own with its own CPU and IO weight. Scopes side by side in one slice each
// claim their weight: twelve unattended jobs at 50 would claim 600 against the owner's one command at 50.
// So the scopes are grouped by whose work they are, under two slices of app.slice:
//
//   owner       the jobs of a turn the owner's words started or steered (and of the agents his turn waits
//               on, as the load hold reads it), and what he types in a terminal: the default weight.
//   unattended  every other job: loop runs, wakes, agents of trees no owner turn started, Keel's own
//               checks beside an agent and pictures. One weight for all of them together: the weight one
//               sandboxed job scope had alone (KEEL_SANDBOX_CPU_WEIGHT, 50), so the whole fleet of
//               unattended work claims what one command used to.
//
// A weight only divides a processor that is short: on an idle machine the unattended slice takes all of it.
//
// A job's slice is decided once, when it starts, and kept for its life: a cgroup cannot move a running scope
// to another slice, so a background job an unattended turn started stays unattended after the owner steers
// the session (and one his turn started stays his).
export type JobSlice = "owner" | "unattended";

export const SLICES: Record<JobSlice, string> = { owner: "app-keelowner.slice", unattended: "app-keelunattended.slice" };

// Whose a job is: the owner's terminal command, or one of a turn the owner attends, is his; the rest unattended.
// A caller with the owner's own command decides "owner" without asking whether the turn is attended.
// A job whose session cannot be read is counted as attended (what a start did before the slices).
export function jobSlice(o: { byOwner?: boolean; attended?: boolean }): JobSlice {
  return o.byOwner || o.attended !== false ? "owner" : "unattended";
}

// The properties the unattended slice is given (systemctl set-property): its CPU and IO weight.
export function unattendedProps(env: Record<string, string | undefined> = process.env): string[] {
  const w = (v: string | undefined, d: number) => { const n = Math.floor(Number(v)); return n >= 1 && n <= 10_000 ? n : d; };
  return [`CPUWeight=${w(env.KEEL_SANDBOX_CPU_WEIGHT, 50)}`, `IOWeight=${w(env.KEEL_SANDBOX_IO_WEIGHT, 50)}`];
}

// One memory cap for all unattended work together (the setting job_slice.unattended_memory_max): the
// unattended slice's MemoryMax. The owner's commands and the daemon are not under it. A size as systemd
// writes one ("24G", "512M", "1.5T", a plain number of bytes; K, M, G and T are powers of 1024, a trailing
// B is allowed), or "0" (or 0) for none. Returns the bytes, null for none, or why the value is refused.
export const MEMORY_DEFAULT = "24G";
const UNIT: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
export function memoryCap(v: unknown): { bytes: number | null } | { error: string } {
  if (v === 0 || v === "0") return { bytes: null };
  const m = typeof v === "number" ? [String(v), String(v), ""] : typeof v === "string" ? /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)B?\s*$/i.exec(v) : null;
  const bytes = m ? Math.floor(Number(m[1]) * UNIT[m[2]!.toUpperCase()]!) : NaN;
  if (!(bytes > 0) || !Number.isSafeInteger(bytes)) return { error: `unattended_memory_max is a size such as "24G" or "512M", or "0" for no cap` };
  return { bytes };
}

// The slice's memory properties for a cap. MemoryHigh sits a thirty-second under MemoryMax: past it the
// kernel reclaims and slows the slice's allocations, so work near the cap slows before one of its commands
// is killed. (A wider gap holds a command that keeps allocating at a crawl for many minutes instead of
// ending it.) No swap for the slice: past MemoryMax a cgroup with swap pages out instead of being killed,
// and a machine deep in swap holds every other program too. With no cap each is set back to infinity, so a
// cap an earlier daemon set does not stay.
export function memoryProps(bytes: number | null): string[] {
  if (bytes === null) return ["MemoryMax=infinity", "MemoryHigh=infinity", "MemorySwapMax=infinity"];
  return [`MemoryMax=${bytes}`, `MemoryHigh=${bytes - Math.floor(bytes / 32)}`, "MemorySwapMax=0"];
}

// A size in the units the owner wrote it in, for Health and a command's result: "24 GB", "512 MB".
export function sizeText(bytes: number): string {
  for (const [u, n] of [["TB", 1024 ** 4], ["GB", 1024 ** 3], ["MB", 1024 ** 2], ["KB", 1024]] as const) {
    if (bytes >= n) return `${Number((bytes / n).toFixed(2))} ${u}`;
  }
  return `${bytes} bytes`;
}

// What a command's result says when the kernel killed processes of it for memory (the oom_kill count of
// its scope's memory.events). `cap`: the unattended slice's cap, when the command ran under one.
export function memoryWords(killed: number, cap?: number | null): string {
  return `Killed for memory: ${memoryWhy(killed, cap)}. Use less memory at once (fewer test workers, a smaller input, one part at a time) before running it again.`;
}
export function memoryWhy(killed: number, cap?: number | null): string {
  const who = killed === 1 ? "a process" : `${killed} processes`;
  const why = cap ? `: unattended commands share a memory cap of ${sizeText(cap)} (the setting job_slice.unattended_memory_max), and when they pass it the kernel ends the largest alone while the rest go on` : "";
  return `the kernel ended ${who} of this command when memory ran out${why}`;
}

// A command that starts a scope (systemd-run's head, then its options) put in `slice`: the head given, its
// `--slice=` added after it (a later one would win over an earlier one, so any other is taken out).
export function inSlice(argv: string[], head: string[], slice: string): string[] {
  if (!head.length || !head.every((a, i) => argv[i] === a)) return argv;
  const end = argv.indexOf("--", head.length);
  if (end < 0) return argv;
  const opts = argv.slice(head.length, end).filter((a) => !a.startsWith("--slice="));
  return [...head, `--slice=${slice}`, ...opts, ...argv.slice(end)];
}
