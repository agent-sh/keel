// Whether a request to the daemon's own API comes from a command a session
// runs: a model's shell call, a run_code program or a repository's check that
// reaches the API on loopback (a session outside a sandbox can; a sandbox has
// no route to it). The admission check (admission.ts, peer-scope.ts) gives such
// a request that session's authority only; a route asks who it was with
// sessionOfCaller.
//
// The processes looked at are the ones the daemon holds as a session's (the
// jobs code: each command's scope, else its process group and session), never
// a process's own word about itself. A socket is found first by the cgroup the
// kernel records it was made in, else by its inode: the one an open file of the
// calling process links to (`socket:[N]` under /proc/PID/fd).
import { readdirSync, readlinkSync } from "node:fs";
import { sessionCallerPids, sessionCgroups, sessionCommandPids, sessionLooseProcesses } from "../tools/jobs.ts";
import { callerSession, useSessionScopes } from "./admission.ts";

// The process whose open files hold socket `inode`, among `pids`.
export function holderOf(inode: number, pids: Iterable<number>, fdsOf: (pid: number) => string[] = fds): number | undefined {
  const want = `socket:[${inode}]`;
  for (const pid of pids) if (fdsOf(pid).includes(want)) return pid;
  return undefined;
}
function fds(pid: number): string[] {
  let names: string[];
  try { names = readdirSync(`/proc/${pid}/fd`); } catch { return []; }
  const out: string[] = [];
  for (const n of names) { try { out.push(readlinkSync(`/proc/${pid}/fd/${n}`)); } catch {} } // closed meanwhile
  return out;
}

// One look at every session's processes at a time; a socket is answered only by a look that began after
// its request arrived, so the askers that come while one looks share the one that follows it.
let looking: Promise<Map<number, string>> | undefined;
let after: Promise<Map<number, string>> | undefined;
function freshPids(): Promise<Map<number, string>> {
  const start = () => (looking = sessionCallerPids().finally(() => (looking = undefined)));
  if (!looking) return start();
  const next = () => { after = undefined; return start(); };
  return (after ??= looking.then(next, next));
}

// The admission check learns where sessions' commands run from the jobs code, and from the
// session table whether a session is top-level (`parentOf`: its parent's id, null for none, undefined
// for a session the table does not hold).
export function watchSessionCallers(parentOf: (session: string) => string | null | undefined) {
  useSessionScopes({
    topLevel: (session) => parentOf(session) === null,
    cgroups: sessionCgroups,
    loose: sessionLooseProcesses,
    // Among the processes the daemon holds first, then among every process that is a session's
    // (sessionCallerPids: its mark, its parents), read again.
    holder: (inode) => {
      const find = (pids: Map<number, string>) => { const pid = holderOf(inode, pids.keys()); return pid === undefined ? null : pids.get(pid)!; };
      return find(sessionCommandPids()) ?? freshPids().then(find);
    },
  });
}

// The session whose command made this request, or null (the owner's page, the
// command line, another daemon, or a request this cannot read: not Linux).
export const sessionOfCaller = (req: Request, _srv?: Bun.Server<unknown>): string | null => callerSession(req);
