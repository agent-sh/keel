// The stdio servers a daemon started, so that none outlives it. A server is
// told to go by its input closing; one that ignores that is ended by signal:
// when the daemon exits, after a short grace, and, when the daemon was killed
// before it could, by the next daemon of the same state folder, which finds
// it by the pid and start time written down here.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Child = { pid: number; kill(signal?: number | NodeJS.Signals): void; exited: Promise<unknown> };
type Rec = { born: string; name: string };

// When a process started, as the kernel counts it (field 22 of its stat line):
// with the pid, it names one process, never a later one that got the same pid.
// Null where there is no /proc, or for a process that is gone or a zombie.
export function born(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return after[0] === "Z" ? null : after[19] ?? null;
  } catch {
    return null;
  }
}

const file = (stateDir: string) => join(stateDir, "mcp-procs.json");
const read = (stateDir: string): Record<string, Rec> => {
  try { return JSON.parse(readFileSync(file(stateDir), "utf8")); } catch { return {}; }
};
const write = (stateDir: string, recs: Record<string, Rec>) => {
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    writeFileSync(file(stateDir), JSON.stringify(recs));
  } catch {} // the record is a safety net: a start goes on without it
};

const live = new Set<Child>();
let hooked = false;
// How long a server told to stop is given before it is killed, when the daemon exits.
export const EXIT_GRACE_MS = 300;

// The daemon exits: every server it still has is told to stop, given a
// moment, and killed. Nothing else runs after this, so the wait is a plain one.
function endAll() {
  const left = [...live];
  if (!left.length) return;
  for (const p of left) try { p.kill("SIGTERM"); } catch {}
  const until = Date.now() + EXIT_GRACE_MS;
  const gone = (p: Child) => { try { process.kill(p.pid, 0); } catch { return true; } return existsSync("/proc/self") && born(p.pid) === null; };
  const pause = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < until && !left.every(gone)) Atomics.wait(pause, 0, 0, 20);
  for (const p of left) if (!gone(p)) try { p.kill("SIGKILL"); } catch {}
}

// A server this daemon started. `stateDir`: where it is written down for the next daemon.
export function track(stateDir: string | undefined, proc: Child, name: string) {
  live.add(proc);
  if (!hooked) {
    hooked = true;
    process.on("exit", endAll);
  }
  const mark = stateDir ? born(proc.pid) : null;
  if (stateDir && mark) write(stateDir, { ...read(stateDir), [proc.pid]: { born: mark, name } });
  void proc.exited.then(() => {
    live.delete(proc);
    if (!stateDir || !mark) return;
    const recs = read(stateDir);
    if (recs[proc.pid]?.born !== mark) return;
    delete recs[proc.pid];
    write(stateDir, recs);
  });
}

// At a start: the servers the daemon before left running (it was killed, or
// they ignored its end) are ended. Each is the process written down, by pid
// and start time; one of this process's own is left alone. Returns their names.
export function reapLeft(stateDir: string, graceMs = 2000): string[] {
  const recs = read(stateDir);
  const mine = new Set([...live].map((p) => String(p.pid)));
  const ended: string[] = [];
  const keep: Record<string, Rec> = {};
  for (const [pid, r] of Object.entries(recs)) {
    if (mine.has(pid)) { keep[pid] = r; continue; }
    if (born(Number(pid)) !== r.born) continue; // gone, or another process has the pid now
    ended.push(r.name);
    try { process.kill(Number(pid), "SIGTERM"); } catch {}
    setTimeout(() => { if (born(Number(pid)) === r.born) try { process.kill(Number(pid), "SIGKILL"); } catch {} }, graceMs).unref?.();
  }
  if (Object.keys(recs).length !== Object.keys(keep).length) write(stateDir, keep);
  return ended;
}
