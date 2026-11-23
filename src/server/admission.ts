// Checks every API request passes before its handler. The first answer wins.
//
// The built-in check comes first: a web page the owner visits must never drive
// the daemon. A browser sends Origin (and Sec-Fetch-Site) with every
// cross-origin request, including the "simple" POSTs that skip CORS preflight,
// so a request whose Origin is not this daemon's own is refused. The Host must
// be a loopback name or one the owner allowed (KEEL_ALLOWED_HOSTS, comma
// separated, for a tunnel or reverse proxy): a DNS-rebinding page reaches
// 127.0.0.1 under its own name and is refused by that. Clients that are not
// browsers (the CLI, the phone app, fleet peers) send no Origin and pass.
//
// Who is calling comes from the socket, never from Host alone. A direct call on
// loopback from a process a session runs (its shell, a program, a check) has
// that session's authority only, with or without the token (peer-scope.ts):
// it reads its own session and changes nothing. Any other direct call on
// loopback from a process of this daemon's own user (or root) is the owner's
// machine. Everything else needs the access token (`<state>/api-token`, 0600):
// a call through a proxy or tunnel (a forwarding header), a peer that is not
// on loopback, and a loopback call from another account (its owner is read
// from the kernel's socket table). The token comes as `Authorization: Bearer`,
// the `keel_token` cookie (set by /api/remote/enter for a remote browser) or
// `?token=` on /ws. The phone API (/v1, /pair) signs its own requests and the
// portal carries a capability key in its path: neither needs it.
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { socketFacts, socketUid, type SocketFacts } from "./sockdiag.ts";
import { cgroupIds, peerAuthority, sessionMay, sessionRefusal, type Authority } from "./peer-scope.ts";

type Check = (req: Request, path: string) => Response | undefined;
const checks: Check[] = [];
export const addAdmission = (c: Check) => void checks.push(c);

// A name under .localhost is loopback too: browsers resolve it to 127.0.0.1
// themselves and no DNS answer can say otherwise, so it cannot be rebound.
const LOOPBACK = /^((?:[a-z0-9-]+\.)*localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

function hostName(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.replace(/:\d+$/, "");
}

// Hosts a module knows the owner gave: the address they told the phone to reach
// this machine at, say. Each source is read per request, so a change applies at once.
const hostSources: (() => string[])[] = [];
export const addAllowedHosts = (f: () => string[]) => void hostSources.push(f);

export function allowedHost(host: string | null): boolean {
  if (!host) return false;
  const name = hostName(host.toLowerCase());
  if (LOOPBACK.test(name)) return true;
  const extra = [...(process.env.KEEL_ALLOWED_HOSTS ?? "").split(","), ...hostSources.flatMap((f) => f())].map((h) => h.trim().toLowerCase()).filter(Boolean);
  return extra.includes(name) || extra.includes(host.toLowerCase());
}

const refuse = (why: string) => Response.json({ error: `refused: ${why}` }, { status: 403 });

export function originCheck(req: Request): Response | undefined {
  const host = req.headers.get("host");
  if (!allowedHost(host)) return refuse(`host ${host ?? "(none)"} is not this daemon's; set KEEL_ALLOWED_HOSTS to allow it`);
  const origin = req.headers.get("origin");
  if (origin && origin !== "null") {
    let o: URL;
    try { o = new URL(origin); } catch { return refuse("unreadable Origin"); }
    if (o.host.toLowerCase() !== host!.toLowerCase()) return refuse(`cross-origin request from ${o.origin}`);
  } else if (origin === "null") {
    return refuse("opaque Origin");
  }
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return refuse(`cross-site request (${site})`);
  return undefined;
}

// ---- who is calling

export const FORWARDING = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "true-client-ip"];
export const forwarded = (req: Request) => FORWARDING.some((h) => req.headers.has(h));

const LOOPBACK_IP = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
// What admit learned about a request's socket, for isLocal (safety/presence.ts).
const peers = new WeakMap<Request, { loopback: boolean; session?: string }>();
export const peerIsRemote = (req: Request) => peers.get(req)?.loopback === false;
// The session whose command made this request (peer-scope.ts), or null: the owner's page, the command line, a peer.
export const callerSession = (req: Request) => peers.get(req)?.session ?? null;

// Where sessions' commands run, as the jobs code holds them (src/server/caller.ts gives it at the start).
export type ScopeSource = { cgroups(): Map<string, string>; loose(): boolean; holder(inode: number): string | null | Promise<string | null> };
let scopes: ScopeSource | undefined;
export const useSessionScopes = (s: ScopeSource | undefined) => void (scopes = s);
// The daemon's own end of a loopback connection: the address it listens on, else the one the client reached it at.
const ownEnd = (ip: string, hostname: string | undefined) =>
  boundAddress(hostname) ?? (ip.startsWith("::ffff:") ? ip.slice(7) : ip === "::1" ? "::1" : LOOPBACK_IP.test(ip) ? ip : "127.0.0.1");
// What a socket was found to be is kept a minute, by the cgroup it was made in: a cgroup's id is never
// given to another and a socket's cgroup is set when it is made, so the next connection from the owner's
// browser or terminal costs no look at the processes. Not for the daemon's own cgroup, where sessions'
// commands run on a machine with no scopes (and a socket is kept by its inode there), nor for a socket
// no process holds.
const verdicts = new Map<string, { a: Authority; at: number }>();
const KEPT_MS = 60_000;
let ownCgroup: bigint | null | undefined;
function daemonCgroup(): bigint | null {
  if (ownCgroup !== undefined) return ownCgroup;
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"));
    ownCgroup = line ? statSync(`/sys/fs/cgroup${line.slice(3)}`, { bigint: true }).ino : null;
  } catch { ownCgroup = null; }
  return ownCgroup;
}
export function peerScope(ip: { address: string; port: number }, srv: { hostname?: string; port: number }): Authority | Promise<Authority> {
  if (!scopes) return { kind: "owner" };
  const ends = endsOf(ip, { address: ownEnd(ip.address, srv.hostname), port: srv.port });
  const src = scopes;
  let busy: { loose: boolean; cgroups: Map<string, string> } | undefined;
  const sessions = () => (busy ??= { loose: src.loose(), cgroups: src.cgroups() });
  // Where the kernel cannot be asked for the one socket, its table is read for the socket's owner and inode
  // (only while a session runs something: what is not a session's needs no answer).
  const facts = (ends ? socketFacts(ends[0], ends[1]) : null) ?? (sessions().loose || sessions().cgroups.size ? tableFacts(ip, { address: boundAddress(srv.hostname), port: srv.port }) : null);
  const key = !facts || facts.inode === 0 ? null : facts.cgroup !== null && facts.cgroup !== daemonCgroup() ? `c${facts.cgroup}` : `i${facts.inode}`;
  const hit = key ? verdicts.get(key) : undefined;
  if (hit && Date.now() - hit.at < KEPT_MS) return hit.a;
  const keep = (a: Authority) => {
    if (key && (a.kind === "owner" || a.kind === "session")) {
      if (verdicts.size > 4096) verdicts.clear();
      verdicts.set(key, { a, at: Date.now() });
    }
    return a;
  };
  const { loose, cgroups } = sessions();
  const a = peerAuthority({ facts, linux: process.platform === "linux", cgroups: cgroupIds(cgroups), loose, holder: (inode) => src.holder(inode) });
  return a instanceof Promise ? a.then(keep) : keep(a);
}
// The owner and inode of a loopback client's socket from the kernel's table (/proc/net/tcp and tcp6), read
// here and now; null when no line, or more than one, names it.
export function tableFacts(peer: End, server: { address?: string; port: number }, read: (f: string) => string | null = readTable): SocketFacts | null {
  const from = tableAddresses(peer.address), to = server.address ? tableAddresses(server.address) : [];
  if (!from.length) return null;
  const hex = (p: number) => p.toString(16).toUpperCase().padStart(4, "0");
  const line = new RegExp(`^\\s*\\d+: (?:${from.join("|")}):${hex(peer.port)} ${to.length ? `(?:${to.join("|")})` : "[0-9A-F]+"}:${hex(server.port)} (?:\\S+\\s+){4}(\\d+)\\s+\\d+\\s+(\\d+)`, "gm");
  const found: SocketFacts[] = [];
  for (const t of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = read(t);
    if (text) for (const m of text.matchAll(line)) found.push({ uid: Number(m[1]), inode: Number(m[2]), cgroup: null });
  }
  return found.length === 1 ? found[0]! : null;
}
const readTable = (f: string) => { try { return readFileSync(f, "latin1"); } catch { return null; } };
// What a session's command may reach besides its own session: the portal, whose path holds its own capability key.
const SESSION_OPEN = /^\/(fleet-)?portal\//;

// Who holds the other end of a loopback connection, from the kernel's socket
// table. A connection is its two addresses and its two ports: the kernel lets
// two connections share both ports when an address differs (a second one from
// 127.0.0.2 on the port one from 127.0.0.1 uses), so the line is matched on
// all four, and so is the answer that is kept. The answer is the uid, or:
//   "unlisted"    the connection is not in the table
//   "shared"      lines of more than one account match (the daemon listens on
//                 every address, so which one the client reached is not known)
//   "unreadable"  Linux, and neither table can be read
//   undefined     there is no such table (not Linux)
// The kernel writes the whole table for each read, which costs milliseconds on
// a machine with thousands of sockets, so the table is read off the loop, one
// read at a time, and searched for the one line. A connection is answered only
// by a read that started after its request arrived: the ones that arrive
// while a read runs share the read that follows it. An answer is kept for a
// second; what the loop does for a new connection is the search.
export type Tables = (string | Uint8Array | null)[];
// A table as it is searched: its bytes, and how many characters an address takes in it (8 in the IPv4 table, 32 in the IPv6 one).
type Table = { bytes: Buffer; width: number } | null;
function tableOf(t: string | Uint8Array | null): Table {
  if (t === null) return null;
  const bytes = typeof t === "string" ? Buffer.from(t, "latin1") : Buffer.from(t.buffer, t.byteOffset, t.byteLength);
  // The first line after the heading: its number, ": ", then the local address up to its ":".
  const at = bytes.indexOf(": ", bytes.indexOf("\n") + 1);
  return { bytes, width: at < 0 ? 0 : bytes.indexOf(":", at + 2) - at - 2 };
}
export type End = { address: string; port: number };
export type Owner = number | "unlisted" | "shared" | "unreadable" | undefined;
const readTables = (): Promise<Tables> => Promise.all(["/proc/net/tcp", "/proc/net/tcp6"].map((t) => readFile(t).catch(() => null)));

// The 16 bytes of an IPv6 address, or the 4 of an IPv4 one; null when it is neither.
function addressBytes(address: string): number[] | null {
  const v4 = (t: string) => {
    const p = t.split(".").map(Number);
    return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
  };
  if (!address.includes(":")) return v4(address);
  const [head = "", tail, more] = address.replace(/^\[|\]$/g, "").split("::");
  if (more !== undefined) return null;
  const words = (t: string): number[] | null => {
    const out: number[] = [];
    for (const [i, w] of (t ? t.split(":") : []).entries()) {
      const last = i === t.split(":").length - 1 && w.includes(".") ? v4(w) : null;
      if (last) { out.push(...last); continue; }
      if (!/^[0-9a-f]{1,4}$/i.test(w)) return null;
      const n = parseInt(w, 16);
      out.push(n >> 8, n & 255);
    }
    return out;
  };
  const a = words(head), z = tail === undefined ? [] : words(tail);
  if (!a || !z || a.length + z.length > 16 || (tail === undefined && a.length !== 16)) return null;
  return [...a, ...Array(16 - a.length - z.length).fill(0), ...z];
}

// An address as the table writes it, in each table that can list it: an IPv4
// address is in the IPv4 table and, as its mapped form, in the IPv6 one. The
// kernel prints each 32-bit word of an address in the machine's byte order.
// (An address is written the same way every time, and the same few addresses
// come with every connection: each is worked out once.)
const written = new Map<string, string[]>();
export function tableAddresses(address: string): string[] {
  let forms = written.get(address);
  if (!forms) {
    if (written.size >= 256) written.clear();
    written.set(address, (forms = tableForms(address)));
  }
  return forms;
}
function tableForms(address: string): string[] {
  const b = addressBytes(address);
  if (!b) return [];
  const word = (x: number[]) => [...x].reverse().map((n) => n.toString(16).toUpperCase().padStart(2, "0")).join("");
  const v6 = (x: number[]) => [0, 4, 8, 12].map((i) => word(x.slice(i, i + 4))).join("");
  if (b.length === 4) return [word(b), v6([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, ...b])];
  const mapped = b.slice(0, 10).every((n) => n === 0) && b[10] === 255 && b[11] === 255;
  return mapped ? [word(b.slice(12)), v6(b)] : [v6(b)];
}

// The two ends as the kernel is asked for them: both as IPv4 where both are (plain or mapped), else both as IPv6.
export function endsOf(peer: End, server: { address?: string; port: number }): [{ bytes: number[]; port: number }, { bytes: number[]; port: number }] | null {
  const four = (b: number[] | null) => (!b ? null : b.length === 4 ? b : b.slice(0, 10).every((n) => n === 0) && b[10] === 255 && b[11] === 255 ? b.slice(12) : null);
  const a = addressBytes(peer.address), z = server.address ? addressBytes(server.address) : null;
  if (!a || !z) return null;
  const a4 = four(a), z4 = four(z);
  if (a4 && z4) return [{ bytes: a4, port: peer.port }, { bytes: z4, port: server.port }];
  return a.length === 16 && z.length === 16 && !a4 && !z4 ? [{ bytes: a, port: peer.port }, { bytes: z, port: server.port }] : null;
}
// The owner of the client's socket, asked of the kernel by its two ends (sockdiag.ts): a uid, or
// null when it names no such socket or cannot be asked (then the table is read, as it always was).
const kernelUid = (peer: End, server: { address?: string; port: number }): number | null => {
  const ends = endsOf(peer, server);
  return ends ? socketUid(ends[0], ends[1]) : null;
};

// `exact`: asked first for a daemon that listens on one address; only a uid it gives is an answer.
export function uidLookup(read: () => Promise<Tables> = readTables, now: () => number = Date.now, linux = process.platform === "linux", exact?: (peer: End, server: { address?: string; port: number }) => number | null) {
  const cache = new Map<string, { owner: Exclude<Owner, undefined>; at: number }>();
  // The read under way, and the one that starts when it ends.
  let reading: Promise<Table[]> | undefined;
  let next: Promise<Table[]> | undefined;
  const start = () => (reading = read().then((tables) => tables.map(tableOf)).finally(() => (reading = undefined)));
  const fresh = (): Promise<Table[]> => {
    if (!reading) return start();
    const after = () => { next = undefined; return start(); };
    return (next ??= reading.then(after, after));
  };
  const hex = (p: number) => p.toString(16).toUpperCase().padStart(4, "0");
  // The lines whose local end is the client's address and port and whose
  // remote end is ours: the eighth field is the uid. `server.address` is the
  // address the daemon listens on; with none (it listens on every address)
  // any remote address matches.
  const find = (tables: Table[], peer: End, server: { address?: string; port: number }): Owner => {
    if (tables.every((t) => t === null)) return linux ? "unreadable" : undefined;
    const from = tableAddresses(peer.address), to = server.address ? tableAddresses(server.address) : [];
    if (!from.length || (server.address && !to.length)) return "unlisted";
    // The same pattern as ever decides, a line at a time. The lines it is
    // tried on are found by their local end as the table writes it (a plain
    // search of the table's bytes, for the form of the address that table
    // can hold): a table of thousands of sockets is not matched against the
    // pattern line by line for each new connection.
    const line = new RegExp(`^\\s*\\d+: (?:${from.join("|")}):${hex(peer.port)} ${to.length ? `(?:${to.join("|")})` : "[0-9A-F]+"}:${hex(server.port)} (?:\\S+\\s+){4}(\\d+)`);
    const uids = new Set<number>();
    for (const t of tables) {
      if (t === null) continue;
      for (const f of from) {
        if (f.length !== t.width) continue;
        const local = `: ${f}:${hex(peer.port)} `;
        for (let at = t.bytes.indexOf(local); at >= 0; at = t.bytes.indexOf(local, at + 1)) {
          const end = t.bytes.indexOf("\n", at);
          const m = line.exec(t.bytes.toString("latin1", t.bytes.lastIndexOf("\n", at) + 1, end < 0 ? t.bytes.length : end));
          if (m) uids.add(Number(m[1]));
        }
      }
    }
    return uids.size === 0 ? "unlisted" : uids.size === 1 ? [...uids][0]! : "shared";
  };
  return (peer: End, server: { address?: string; port: number }): Owner | Promise<Owner> => {
    const k = `${peer.address} ${peer.port} ${server.address ?? "*"} ${server.port}`;
    const hit = cache.get(k);
    if (hit && now() - hit.at < 1000) return hit.owner;
    const uid = exact && server.address ? exact(peer, server) : null;
    if (uid !== null) {
      if (cache.size > 4096) cache.clear();
      cache.set(k, { owner: uid, at: now() });
      return uid;
    }
    return fresh().then((tables) => {
      const owner = find(tables, peer, server);
      if (owner === undefined) return owner;
      if (cache.size > 4096) cache.clear();
      cache.set(k, { owner, at: now() });
      return owner;
    });
  };
}
const peerUid = uidLookup(readTables, Date.now, process.platform === "linux", kernelUid);
// The address the daemon listens on, when it is one address (not every address, not a name).
const WILDCARD = /^(0\.0\.0\.0|::|\[::\]|)$/;
const boundAddress = (hostname: string | undefined) => (hostname && !WILDCARD.test(hostname) && tableAddresses(hostname).length ? hostname : undefined);

let token = "";
// The access token, made once per state folder with mode 0600.
export function initAccess(stateDir: string) {
  const p = join(stateDir, "api-token");
  if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString("base64url") + "\n", { mode: 0o600 });
  chmodSync(p, 0o600);
  token = readFileSync(p, "utf8").trim();
}
export const accessToken = () => token;

const same = (a: string, b: string) => a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function hasToken(req: Request, allowQuery = false): boolean {
  if (!token) return false;
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ") && same(auth.slice(7).trim(), token)) return true;
  const cookie = /(?:^|;\s*)keel_token=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  if (cookie && same(decodeURIComponent(cookie), token)) return true;
  if (allowQuery) {
    const q = new URL(req.url).searchParams.get("token");
    if (q && same(q, token)) return true;
  }
  return false;
}

// Paths with their own authentication: the phone's signed API and its pair
// page, the portal's capability key, the token exchange itself, and health.
const OWN_AUTH = /^\/(v1\/|pair$|portal\/|fleet-portal\/|api\/remote\/enter$|api\/health$)/;

export function callerCheck(req: Request, srv: Bun.Server<unknown> | undefined): Response | undefined | Promise<Response | undefined> {
  const ip = srv?.requestIP(req);
  const loopback = !!ip && LOOPBACK_IP.test(ip.address);
  peers.set(req, { loopback: !!ip ? loopback : true });
  const path = new URL(req.url).pathname;
  const answer = (why: string | null) => (!why || hasToken(req, path === "/ws") ? undefined : refuse(`${why} needs the access token (Settings > Safety > Remote access)`));
  const account = (): Response | undefined | Promise<Response | undefined> => {
    if (OWN_AUTH.test(path)) return undefined;
    if (forwarded(req)) return answer("a request through a proxy or tunnel");
    if (ip && !loopback) return answer(`a request from ${ip.address}`);
    if (!ip || !srv?.port) return answer(null);
    const owner = (who: Owner) => {
      const me = process.getuid?.();
      if (who === "unlisted") return answer("a connection the kernel does not list");
      if (who === "shared") return answer("a connection whose address and port more than one account holds");
      if (who === "unreadable") return answer("a connection whose owner cannot be read (the kernel's socket table is not readable)");
      if (who !== undefined && me !== undefined && who !== me && who !== 0) return answer(`a process of another account (uid ${who})`);
      return answer(null);
    };
    const who = peerUid({ address: ip.address, port: ip.port }, { address: boundAddress(srv.hostname), port: srv.port });
    return who instanceof Promise ? who.then(owner) : owner(who);
  };
  if (!ip || !loopback || !srv?.port) return account();
  // A session's command first, whatever it carries: the token does not make it the owner (it can read the token's file).
  const scope = peerScope({ address: ip.address, port: ip.port }, { hostname: srv.hostname, port: srv.port });
  const decide = (a: Authority) => {
    if (a.kind === "session") {
      peers.set(req, { loopback, session: a.session });
      return sessionMay(req.method, path, a.session) || SESSION_OPEN.test(path) ? undefined : refuse(sessionRefusal(a.session, req.method, path));
    }
    if (a.kind === "ended") return refuse("the process that made this connection closed it or ended before it was answered, so who made it cannot be told");
    if (a.kind === "unknown" && !OWN_AUTH.test(path)) return answer("a connection the kernel names no maker of, while sessions' commands run,");
    return account();
  };
  return scope instanceof Promise ? scope.then(decide) : decide(scope);
}

// The portal proxies a session's own dev server under a capability key in its
// path, served sandboxed (opaque origin, no access to the API): its pages send
// Origin "null" and must still load. Only the Host check applies there.
const PORTAL = /^\/(fleet-)?portal\//;

// An OAuth redirect comes back as a top-level GET from the authorization
// server's site. Its callback checks the `state` it handed out, which a page
// elsewhere cannot know, so for that one navigation only the Host is checked.
const OAUTH_CALLBACKS = new Set(["/api/mcp/oauth/callback"]);
const oauthReturn = (req: Request, path: string) =>
  req.method === "GET" && OAUTH_CALLBACKS.has(path) && req.headers.get("sec-fetch-mode") === "navigate";

// The answer is a promise only for a client port not seen in the last second
// (its owner is being read from the kernel's table); the callers await it.
export function admit(req: Request, srv?: Bun.Server<unknown>): Response | undefined | Promise<Response | undefined> {
  const path = new URL(req.url).pathname;
  const hostOnly = PORTAL.test(path) || oauthReturn(req, path);
  const guard = hostOnly ? (allowedHost(req.headers.get("host")) ? undefined : refuse("host not allowed")) : originCheck(req);
  if (guard) return guard;
  const rest = (who: Response | undefined) => {
    if (who) return who;
    for (const c of checks) {
      const r = c(req, path);
      if (r) return r;
    }
    return undefined;
  };
  const who = callerCheck(req, srv);
  return who instanceof Promise ? who.then(rest) : rest(who);
}
