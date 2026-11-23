// Who a loopback caller of the daemon's API is: the owner, or a session's own
// command. A command a session runs (its shell, a run_code program, a
// repository's check) is a process of the owner's account on the owner's
// machine, so the account and the address do not tell it from the owner's
// terminal. What does is where it runs: each runs in a cgroup of its own (a
// systemd scope the jobs code starts it in, src/tools/jobs.ts), and the
// kernel records with every socket the cgroup of the process that made it.
// The daemon asks the kernel for the client socket's record by its two ends
// (sockdiag.ts) and looks the cgroup up among the sessions' scopes. A peer in a
// session's scope has that session's authority only: it reads its own session,
// nothing else, with or without the access token (a command outside the
// sandbox can read the token's file).
//
// The record is the socket's, not a process's: a process that ends after it
// sent its request, a pid used again, a child that took the socket over, none
// of them changes which cgroup made it. A socket no process holds any more
// (inode 0: the process that made it closed it or ended) is refused whoever
// made it, since its maker can no longer be told: the owner's clients hold
// their connection until they have the answer.
//
// A socket made in no session's cgroup is still looked for among the
// sessions' processes while they run anything (src/tools/jobs.ts
// sessionCallerPids): a process that left its command's scope for a scope of
// its own (`systemd-run --scope`), one that took a session of its own on a
// machine with no scopes (found by the mark in its environment), and anything
// that descends from them. What is found of a cgroup is kept a minute, so the
// owner's page and command line cost one look per cgroup, not per request.
//
// This is the API's own rule, not a sandbox: a command outside the sandbox
// runs with the owner's account and can do what the account can (start a
// unit of the owner's service manager with no mark and no parent here, write
// the daemon's files). The sandbox is what keeps a command from those.
import { statSync } from "node:fs";
import type { SocketFacts } from "./sockdiag.ts";

export type Authority =
  | { kind: "owner" }
  | { kind: "session"; session: string; by: "cgroup" | "process" }
  // No process holds the socket: refused.
  | { kind: "ended" }
  // The kernel gave no record while sessions have processes alive: the access token decides.
  | { kind: "unknown" };

export type PeerFacts = {
  // The kernel's record of the client's socket; null when it cannot be asked.
  facts: SocketFacts | null;
  // Whether this is Linux: elsewhere there is no record to ask, and the caller is the owner as before.
  linux: boolean;
  // The cgroups that hold sessions' commands, by their id.
  cgroups: Map<bigint, string>;
  // Whether a session may have processes alive that its cgroups do not hold.
  loose: boolean;
  // The session whose process holds the socket with this inode, among the processes the daemon holds as
  // sessions' (a promise where they are read off the loop).
  holder: (inode: number) => string | null | Promise<string | null>;
};

export function peerAuthority(p: PeerFacts): Authority | Promise<Authority> {
  const any = p.loose || p.cgroups.size > 0;
  if (!p.facts) return any && p.linux ? { kind: "unknown" } : { kind: "owner" };
  if (p.facts.cgroup !== null) {
    const s = p.cgroups.get(p.facts.cgroup);
    if (s) return { kind: "session", session: s, by: "cgroup" };
  }
  if (p.facts.inode === 0) return { kind: "ended" };
  // By the open file, while sessions run anything: a process of a session that left its scope (for a
  // scope of its own), or one that no cgroup holds, still holds the socket.
  if (any) {
    const of = (s: string | null): Authority => (s ? { kind: "session", session: s, by: "process" } : { kind: "owner" });
    const s = p.holder(p.facts.inode);
    return s instanceof Promise ? s.then(of) : of(s);
  }
  return { kind: "owner" };
}

// What a session's command may ask of the API: its own session, read (its events, its plan, its files), and
// whether the daemon is up. Not its secrets' list, and nothing that changes anything: an approval, a mode, a
// message, a stop are the owner's, for its own session too.
export function sessionMay(method: string, path: string, session: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (path === "/api/health") return true;
  if (path.includes("%") || path.includes("//")) return false;
  const m = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(path);
  if (!m || m[1] !== session) return false;
  return !/^\/secrets(\/|$)/.test(m[2] ?? "");
}

export const sessionRefusal = (session: string, method: string, path: string) =>
  `a command of session ${session} acts with that session's authority only: it may read its own session (GET /api/sessions/${session}), not ${method} ${path}, which is the owner's`;

// The ids of cgroup folders: the inode of each, as the kernel numbers the cgroup. A folder that is gone is left out.
const ids = new Map<string, bigint>();
export function cgroupIds(dirs: Map<string, string>): Map<bigint, string> {
  const out = new Map<bigint, string>();
  for (const [dir, session] of dirs) {
    let id = ids.get(dir);
    if (id === undefined) {
      try { id = statSync(dir, { bigint: true }).ino; } catch { continue; }
      ids.set(dir, id);
    }
    out.set(id, session);
  }
  for (const dir of ids.keys()) if (!dirs.has(dir)) ids.delete(dir);
  return out;
}
