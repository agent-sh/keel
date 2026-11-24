// Who a loopback caller of the daemon's API is: the owner, or a session's own
// command. A command a session runs (its shell, a run_code program, a
// repository's check) is a process of the owner's account on the owner's
// machine, so the account and the address do not tell it from the owner's
// terminal. What does is where it runs: each runs in a cgroup of its own (a
// systemd scope the jobs code starts it in, src/tools/jobs.ts), and the
// kernel records with every socket the cgroup of the process that made it.
// The daemon asks the kernel for the client socket's record by its two ends
// (sockdiag.ts) and looks the cgroup up among the sessions' scopes. A peer in a
// session's scope has that session's authority only: it reads its own session
// (and, for a top-level session or an agent its parent granted them to, the
// daemon's read-only lists), changes
// nothing, with or without the access token (a command outside the sandbox
// can read the token's file).
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
  // The kernel gave no record while sessions have processes alive: refused (peerVerdict).
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
// message, a stop are the owner's, for its own session too. A top-level session's command (one whose session
// has no parent in the daemon's table: never anything the command says of itself) may also read what the
// daemon's lists show of every session: the list, a session's events, timeline and hours, the agents, the
// errors, telemetry, usage, resources and the daemon's state. Never a secret, the vault, the access token, the
// settings or the socket. An agent's command keeps its own session only, unless its parent granted it the
// same lists at its start (src/automation/api-grant.ts: a chain of grants that starts at a top-level session).
const TOP_READS = [
  /^\/api\/sessions$/,
  /^\/api\/sessions\/[^/]+(\/(events|timeline|hours|agents|agents\/[^/]+\/report))?$/,
  /^\/api\/(errors|resources|daemon|automation|automation\/now|telemetry)$/,
  /^\/api\/usage(\/(drivers|rollup))?$/,
  /^\/api\/telemetry\/(compactions|compare|examples|memory|prompt|slowest|tokens|turns|vocabulary)$/,
];
export function sessionMay(method: string, path: string, session: string, lists = false): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (path === "/api/health") return true;
  if (path.includes("%") || path.includes("//")) return false;
  const m = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(path);
  if (m && m[1] === session) return !/^\/secrets(\/|$)/.test(m[2] ?? "");
  return lists && TOP_READS.some((r) => r.test(path));
}

// Whether a session's command reads the daemon's lists: as a top-level session's, as an agent's its parent
// granted them to, or not, with why (src/automation/api-grant.ts).
export type ListReach = { reads: "top" | "granted" } | { reads: false; why: string };

export const sessionRefusal = (session: string, method: string, path: string, reach: ListReach = { reads: false, why: "" }) =>
  `a command of session ${session} acts with that session's authority only: it may read its own session (GET /api/sessions/${session})${reach.reads ? ` and the daemon's read-only lists${reach.reads === "granted" ? " (its parent granted them)" : ""}` : ""}, not ${method} ${path}, which is the owner's` +
  // A read of the lists an agent was not granted says why, so its parent knows what to pass.
  (!reach.reads && reach.why && (method === "GET" || method === "HEAD") && TOP_READS.some((r) => r.test(path)) ? `; ${reach.why}` : "");

// What the door does with a loopback request once its maker is known. `ownAuth`: a path with an
// authentication of its own (the phone's signed API, health); `open`: one a session's command may reach
// (the portal, under its capability key); `lists`: whether a session's command reads the daemon's lists. "account": the account
// and token checks decide, as for any of the owner's requests.
// `absent`: the request names sessions another harness runs to a caller blind to them (`ids`), and is otherwise
// what `then` says: the door has the route answer it as for sessions that do not exist (admission.ts standIn).
export type PeerVerdict = { pass: true } | { account: true } | { refuse: string } | { absent: string; ids: string[]; then: { pass: true } | { account: true } };

// A session another harness runs (src/core/outside.ts) exists for the owner only: the owner's page and the
// owner's command line on a terminal. For a session's own command, a request another machine forwarded
// (`linked`) and the phone's signed API, it does not exist: a request that names one is answered as for
// no such session, and a list leaves it out (seesOutside in admission.ts tells a route which caller it has).
export const PHONE_API = /^\/v1\//;
export const blindTo = (a: Authority, req: { path: string; linked?: boolean }): boolean => a.kind === "session" || !!req.linked || PHONE_API.test(req.path);
// The sessions a request names: by its path (a segment after `sessions/`, wherever it stands) and by the
// parameters routes read a session from.
const NAMING = ["session", "session_id", "of", "children_of", "agents_of"];
export function namedSessions(path: string, search = ""): string[] {
  const out: string[] = [];
  let p = path;
  try { p = decodeURIComponent(path); } catch {} // a path that does not decode names what it spells
  for (const m of p.matchAll(/\/sessions\/([^/]+)/g)) out.push(m[1]!);
  const q = new URLSearchParams(search);
  for (const k of NAMING) for (const v of q.getAll(k)) if (v) out.push(v);
  return out;
}
export const ABSENT = "no such session";

// The answer it gets is the one a session that does not exist gets: a refusal the request would get anyway
// comes first, and the rest the route answers as for an id no session has.
export function peerVerdict(a: Authority, req: { method: string; path: string; ownAuth: boolean; open: boolean; search?: string; linked?: boolean }, lists: (session: string) => ListReach, outside: (session: string) => boolean = () => false): PeerVerdict {
  const v = callerVerdict(a, req, lists);
  if ("refuse" in v || !blindTo(a, req)) return v;
  const ids = [...new Set(namedSessions(req.path, req.search).filter(outside))];
  return ids.length ? { absent: ABSENT, ids, then: v } : v;
}

function callerVerdict(a: Authority, req: { method: string; path: string; ownAuth: boolean; open: boolean }, lists: (session: string) => ListReach): { pass: true } | { account: true } | { refuse: string } {
  if (a.kind === "session") {
    const reach = lists(a.session);
    return sessionMay(req.method, req.path, a.session, !!reach.reads) || req.open ? { pass: true } : { refuse: sessionRefusal(a.session, req.method, req.path, reach) };
  }
  if (a.kind === "ended") return { refuse: "the process that made this connection closed it or ended before it was answered, so who made it cannot be told" };
  // No record of the socket while sessions run commands: it may be one of theirs, and the token does not
  // tell (a command can read it). The owner's clients hold their connection until they have the answer.
  if (a.kind === "unknown" && !req.ownAuth) return { refuse: "the kernel names no maker of this connection while sessions' commands run, so who made it cannot be told" };
  return { account: true };
}

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
