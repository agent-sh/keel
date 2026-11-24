// Job scopes that run and are not this daemon's job: the scope of another daemon (another state folder, a
// scratch daemon), or a scope of this daemon's own record whose processes carry another daemon's mark (a
// daemon whose commands could not make scopes of their own ran them in this one). Keel never signals them
// by itself. Settings > Leftovers lists each with what it holds (its tasks, processor time, memory, the
// commands, the marks and folders its processes name), and the owner stops one there: the act names the
// scope and the marks it was listed with, and is refused when they changed.
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { statSync, writeFileSync } from "node:fs";
import { cgroupHoldsSelf, SCOPE_NAME, stateIdFrom } from "../tools/jobs.ts";

export type ForeignScope = {
  cgroup: string;
  unit: string;
  // Why this daemon does not take it (the words of the refusal), when its record was read.
  why?: string;
  tasks: number;
  cpu_ms?: number;
  memory_bytes: number;
  // When its oldest process started.
  since?: number;
  // The distinct commands, the first few, as their processes were started.
  commands: string[];
  // The marks of the jobs its processes carry (`<id>.<started>`), and the sessions they name.
  marks: string[];
  sessions: string[];
  // The folder its first process works in, and whether that folder is gone.
  cwd?: string;
  gone?: boolean;
  // The state folders (their ids) the processes were started over, and whether a daemon of one of them runs now:
  // its commands are live work, not what a dead daemon left.
  states: string[];
  daemon_live?: boolean;
  // This daemon, or a process above it, is in the scope (a daemon started from a command lives in its parent's
  // scope): stopping the scope would end it too, so it is never stopped from here.
  holds_self?: boolean;
};

export type ProcLook = { pid: number; argv: string[]; mark?: string; state?: string; session?: string; cwd?: string; started?: number };

const MAX_COMMANDS = 3;
const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
// The command a process runs, as its owner wrote it: a job's wrapper (`bash -c '"$@"; ...' <exit file> bash -c SCRIPT`)
// is the way it was started, and the first lines of SCRIPT only keep its folder and its trace. Pure.
export function commandOf(argv: string[]): string {
  let a = argv;
  if (a[1] === "-c" && /"\$@"/.test(a[2] ?? "") && /\.exit$/.test(a[3] ?? "") && a.length > 4) a = a.slice(4);
  if (a[1] === "-c" && a[2]) {
    const lines = a[2].split("\n");
    let i = 0;
    while (i < lines.length - 1 && /^(set -T|trap |exec 2>&1$)/.test(lines[i]!)) i++;
    if (i) a = [...a.slice(0, 2), lines.slice(i).join("\n"), ...a.slice(3)];
  }
  return clean(a.join(" "));
}
// What a scope holds, from what its processes say of themselves. Pure.
export function summarize(cgroup: string, procs: ProcLook[], extra: { why?: string; cpu_ms?: number; memory_bytes?: number } = {}): ForeignScope {
  const commands: string[] = [];
  for (const p of procs) {
    const c = commandOf(p.argv).slice(0, 240);
    if (c && !commands.includes(c)) commands.push(c);
  }
  const first = procs.find((p) => p.cwd);
  const times = procs.map((p) => p.started).filter((t): t is number => t !== undefined);
  return {
    cgroup, unit: cgroup.slice(cgroup.lastIndexOf("/") + 1), why: extra.why, tasks: procs.length, cpu_ms: extra.cpu_ms, memory_bytes: extra.memory_bytes ?? 0,
    since: times.length ? Math.min(...times) : undefined,
    commands: commands.slice(0, MAX_COMMANDS), marks: [...new Set(procs.map((p) => p.mark).filter((m): m is string => !!m))].sort(),
    sessions: [...new Set(procs.map((p) => p.session).filter((m): m is string => !!m))].sort(),
    states: [...new Set(procs.map((p) => p.state).filter((m): m is string => !!m))].sort(),
    cwd: first?.cwd?.replace(/ \(deleted\)$/, ""), gone: first?.cwd?.endsWith(" (deleted)") || undefined,
  };
}

const entry = (env: Buffer | undefined, key: string): string | undefined => {
  if (!env) return undefined;
  const head = Buffer.from(`${key}=`);
  for (let at = env.indexOf(head); at >= 0; at = env.indexOf(head, at + 1)) {
    if (at !== 0 && env[at - 1] !== 0) continue;
    const end = env.indexOf(0, at);
    return env.subarray(at + head.length, end < 0 ? env.length : end).toString("utf8");
  }
  return undefined;
};

let boot: number | undefined;
const bootTime = async () => (boot ??= Number(/^btime (\d+)/m.exec(await readFile("/proc/stat", "utf8").catch(() => ""))?.[1] ?? 0) * 1000);
const num = async (p: string) => { try { return Number((await readFile(p, "utf8")).trim()) || 0; } catch { return 0; } };
const cpuOf = async (cg: string) => { try { return Number(/^usage_usec (\d+)/m.exec(await readFile(`${cg}/cpu.stat`, "utf8"))?.[1] ?? 0) / 1000; } catch { return undefined; } };
// Of a scope's processes the first ones are read (a scope of a hundred holds the same few commands).
const PROCS_MAX = 30;

// One scope as it is now, or nothing when it is gone.
export async function look(cgroup: string, why?: string): Promise<ForeignScope | undefined> {
  const text = await readFile(`${cgroup}/cgroup.procs`, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  const pids = text.split("\n").filter(Boolean).map(Number);
  const b = await bootTime();
  const procs = (await Promise.all(pids.slice(0, PROCS_MAX).map(async (pid): Promise<ProcLook | undefined> => {
    try {
      const [cmd, env, cwd, st] = await Promise.all([
        readFile(`/proc/${pid}/cmdline`, "utf8"), readFile(`/proc/${pid}/environ`).catch(() => undefined),
        readlink(`/proc/${pid}/cwd`).catch(() => undefined), readFile(`/proc/${pid}/stat`, "utf8"),
      ]);
      const f = st.slice(st.lastIndexOf(") ") + 2).split(" ");
      if (f[0] === "Z" || f[0] === "X") return undefined;
      return { pid, argv: cmd.split("\0").filter(Boolean), mark: entry(env, "KEEL_JOB"), state: entry(env, "KEEL_JOB_STATE"), session: entry(env, "KEEL_SESSION"), cwd, started: b ? b + Number(f[19]) * 10 : undefined };
    } catch { return undefined; }
  }))).filter((p): p is ProcLook => !!p);
  const s = summarize(cgroup, procs, { why, cpu_ms: await cpuOf(cgroup), memory_bytes: await num(`${cgroup}/memory.current`) });
  s.tasks = pids.length;
  s.holds_self = cgroupHoldsSelf(cgroup) || undefined;
  return s;
}

// The state folders that a daemon holds now, by their ids (the id a job's processes carry): a running daemon keeps
// its folder's claim file open. Only this account's processes can be read.
export const CLAIM_NAME = "daemon.claim";
export async function liveStates(): Promise<Set<string>> {
  const out = new Set<string>();
  let pids: string[] = [];
  try { pids = (await readdir("/proc")).filter((n) => /^\d+$/.test(n)); } catch { return out; }
  const dirs = new Set<string>();
  await Promise.all(pids.map(async (pid) => {
    let fds: string[];
    try { fds = await readdir(`/proc/${pid}/fd`); } catch { return; }
    await Promise.all(fds.map(async (fd) => {
      const t = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
      if (t.endsWith(`/${CLAIM_NAME}`)) dirs.add(t.slice(0, -CLAIM_NAME.length - 1));
    }));
  }));
  for (const d of dirs) { try { out.add(stateIdFrom(statSync(join(d, "spill"), { bigint: true }))); } catch {} }
  return out;
}

// Every scope in `cgroups`, up to `max` (the rest are counted by the caller), the largest holders first.
export async function list(cgroups: Iterable<string>, whys: Map<string, string>, max = 40): Promise<ForeignScope[]> {
  const all = (await Promise.all([...cgroups].slice(0, max).map((cg) => look(cg, whys.get(cg))))).filter((s): s is ForeignScope => !!s);
  // The scan of every process's descriptors is made only when a scope names a state folder.
  const live = all.some((s) => s.states.length) ? await liveStates() : new Set<string>();
  for (const s of all) s.daemon_live = s.states.some((id) => live.has(id)) || undefined;
  // What a dead daemon left first (the owner's to stop), the live daemons' work under it.
  return all.sort((a, b) => Number(!!a.daemon_live) - Number(!!b.daemon_live) || b.tasks - a.tasks || a.cgroup.localeCompare(b.cgroup));
}

// The owner's stop of one: only a job scope by its name, and only while it holds what the owner was shown
// (the same marks). TERM to every process, KILL for the scope after two seconds. What is left is told.
export async function stop(cgroup: string, seen: { marks: string[] }, listed: Set<string>): Promise<{ stopped: boolean; left: number[] }> {
  if (!listed.has(cgroup) || !SCOPE_NAME.test(cgroup.slice(cgroup.lastIndexOf("/") + 1))) throw new Error("that is not a job scope of another daemon this one knows of");
  const now = await look(cgroup);
  if (!now) return { stopped: true, left: [] };
  if (now.holds_self) throw new Error("this daemon runs in that scope (it was started from a command that lives there): stopping it would end this daemon too");
  const was = [...seen.marks].sort().join(" ");
  if (was !== now.marks.join(" ")) throw new Error("the scope holds other commands than the ones that were shown: look at it again");
  const pids = async () => (await readFile(`${cgroup}/cgroup.procs`, "utf8").catch(() => "")).split("\n").filter(Boolean).map(Number);
  for (const pid of await pids()) try { process.kill(pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 8 && (await pids()).length; i++) await Bun.sleep(250);
  if ((await pids()).length) { try { writeFileSync(`${cgroup}/cgroup.kill`, "1"); } catch {} for (let i = 0; i < 8 && (await pids()).length; i++) await Bun.sleep(250); }
  const left = await pids();
  return { stopped: !left.length, left };
}
