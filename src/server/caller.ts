// Whether a request to the daemon's own API comes from a command a session
// runs: a model's shell call that reaches the API on loopback (a session
// outside a sandbox can; a sandbox has no route to it). The admission check
// (admission.ts) lets every process of the owner's account through, the
// session's commands among them; a route that only the owner's own hand may
// take (landing a branch the session does not hold) asks this as well.
//
// The client's socket is named by the kernel by its two ends (sockdiag.ts):
// its inode is the one an open file of the calling process links to
// (`socket:[N]` under /proc/PID/fd). The processes looked at are the ones the
// daemon holds as a session's commands (jobs.ts sessionCommandPids), never a
// process's own word about itself.
import { readdirSync, readlinkSync } from "node:fs";
import { sessionCommandPids } from "../tools/jobs.ts";
import { endsOf } from "./admission.ts";
import { socketInode } from "./sockdiag.ts";

const LOOPBACK_IP = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

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

// The session whose command made this request, or null (the owner's page, the
// command line, another daemon, or a request this cannot read: not Linux).
export function sessionOfCaller(req: Request, srv: Bun.Server<unknown> | undefined): string | null {
  const ip = srv?.requestIP(req);
  if (!ip || !srv?.port || !LOOPBACK_IP.test(ip.address)) return null;
  const host = srv.hostname && !/^(0\.0\.0\.0|::|\[::\]|)$/.test(srv.hostname) ? srv.hostname : ip.address.startsWith("::ffff:") ? ip.address.slice(7) : ip.address === "::1" ? "::1" : "127.0.0.1";
  const ends = endsOf({ address: ip.address, port: ip.port }, { address: host, port: srv.port });
  const inode = ends ? socketInode(ends[0], ends[1]) : null;
  if (!inode) return null;
  const pids = sessionCommandPids();
  const pid = holderOf(inode, pids.keys());
  return pid === undefined ? null : pids.get(pid)!;
}
