// The daemon's own control group (cgroup v2), as far as it bounds memory:
// the limits a unit sets on it and the kernel's count of the times it
// passed them. Read from files of the process's own group; where there is
// none (another system, cgroup v1) every read says so with `undefined`.
import { readFileSync } from "node:fs";

const read = (path: string): string | undefined => { try { return readFileSync(path, "utf8"); } catch { return undefined; } };

// The folder of this process's group under /sys/fs/cgroup.
export function ownCgroup(): string | undefined {
  const own = /^0::(\/.*)$/m.exec(read("/proc/self/cgroup") ?? "")?.[1];
  return own ? `/sys/fs/cgroup${own}`.replace(/\/$/, "") : undefined;
}

// A limit file's value in bytes: nothing for "max" (no limit) and for a file that is not there.
export function parseLimit(text: string | undefined): number | undefined {
  const n = Number((text ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// memory.events: how often the group was over its throttle limit (`high`), at its hard limit (`max`), and killed in.
export function parseMemoryEvents(text: string | undefined): { high: number; max: number; oom_kill: number } | undefined {
  if (!text) return undefined;
  const of = (k: string) => Number(new RegExp(`^${k} (\\d+)`, "m").exec(text)?.[1] ?? 0);
  return { high: of("high"), max: of("max"), oom_kill: of("oom_kill") };
}

// The limits on the daemon's group: where the kernel throttles it (MemoryHigh) and where it kills in it (MemoryMax).
// A group with neither set on itself takes the nearest ancestor's (a limit on a slice holds for what is in it).
export function memoryLimits(dir = ownCgroup()): { high?: number; max?: number } {
  let high: number | undefined, max: number | undefined;
  for (let d = dir; d && d.length > "/sys/fs/cgroup".length; d = d.slice(0, d.lastIndexOf("/"))) {
    high ??= parseLimit(read(`${d}/memory.high`));
    max ??= parseLimit(read(`${d}/memory.max`));
    if (high && max) break;
  }
  return { ...(high ? { high } : {}), ...(max ? { max } : {}) };
}

export const memoryEvents = (dir = ownCgroup()) => (dir ? parseMemoryEvents(read(`${dir}/memory.events`)) : undefined);
