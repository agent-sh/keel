// The machine's pressure (Linux PSI): the share of the last ten seconds in which some task waited for a
// processor, or for memory, read for the whole machine (/proc/pressure) and for the slice the unattended jobs
// run in (src/tools/job-slice.ts). The load hold (src/automation/load-rules.ts) and the heavy pool read it
// beside the load; where the kernel has no PSI (an older kernel, PSI off, not Linux) the readings are empty and
// both decide on the load alone, as before.
//
// Why beside the load: the 1-minute load counts tasks that run, wait to run and wait on the disk, smoothed over
// a minute. It can stay over the thread count for a minute after the machine went quiet, and it says nothing of
// whose tasks wait. Pressure says that tasks waited, over ten seconds, for the machine and for the slice.
import { readFileSync } from "node:fs";

// "some avg10" of one pressure file, in percent; undefined when the file is not there or not read.
export function someAvg10(text: string): number | undefined {
  const m = /^some\s+avg10=([\d.]+)/m.exec(text);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

export type Pressure = { cpu?: number; memory?: number };
// The machine's and the unattended slice's, each empty where it could not be read.
export type Pressures = { host: Pressure; unattended: Pressure };

const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const of = (dir: string): Pressure => {
  const cpu = someAvg10(read(`${dir}/cpu.pressure`));
  const memory = someAvg10(read(`${dir}/memory.pressure`));
  return { ...(cpu !== undefined ? { cpu } : {}), ...(memory !== undefined ? { memory } : {}) };
};

// `slice`: the unattended slice's cgroup folder (under /sys/fs/cgroup), when jobs have one.
export function readPressures(slice?: string): Pressures {
  if (process.platform !== "linux") return { host: {}, unattended: {} };
  const host: Pressure = {};
  const cpu = someAvg10(read("/proc/pressure/cpu"));
  const memory = someAvg10(read("/proc/pressure/memory"));
  if (cpu !== undefined) host.cpu = cpu;
  if (memory !== undefined) host.memory = memory;
  return { host, unattended: slice ? of(slice) : {} };
}
