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
// loopback from a process of this daemon's own user (or root) is the owner's
// machine. Everything else needs the access token (`<state>/api-token`, 0600):
// a call through a proxy or tunnel (a forwarding header), a peer that is not
// on loopback, and a loopback call from another account (its owner is read
// from the kernel's socket table). The token comes as `Authorization: Bearer`,
// the `keel_token` cookie (set by /api/remote/enter for a remote browser) or
// `?token=` on /ws. The phone API (/v1, /pair) signs its own requests and the
// portal carries a capability key in its path: neither needs it.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

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
const peers = new WeakMap<Request, { loopback: boolean }>();
export const peerIsRemote = (req: Request) => peers.get(req)?.loopback === false;

// The uid holding the other end of a loopback connection, from the kernel's
// socket table; undefined where there is none (not Linux), null when the
// connection is not in it. The kernel writes the whole table for each read,
// which costs milliseconds on a machine with thousands of sockets, so the
// table is read off the loop (one read at a time, shared by the connections
// that arrive while it runs) and searched for the one line, and an answer is
// kept for a second per client port. Only a new client port waits for a read;
// what the loop does for it is the search.
export type Tables = (string | null)[];
const readTables = (): Promise<Tables> => Promise.all(["/proc/net/tcp", "/proc/net/tcp6"].map((t) => readFile(t, "utf8").catch(() => null)));

export function uidLookup(read: () => Promise<Tables> = readTables, now: () => number = Date.now) {
  const cache = new Map<string, { uid: number | null; at: number }>();
  let reading: Promise<Tables> | undefined;
  const table = () => (reading ??= read().finally(() => (reading = undefined)));
  const hex = (p: number) => p.toString(16).toUpperCase().padStart(4, "0");
  // The line whose local end is the client's port and whose remote end is ours:
  // its eighth field is the uid.
  const find = (tables: Tables, peerPort: number, serverPort: number): number | null | undefined => {
    if (tables.every((t) => t === null)) return undefined;
    const line = new RegExp(`^\\s*\\d+: [0-9A-F]+:${hex(peerPort)} [0-9A-F]+:${hex(serverPort)} (?:\\S+\\s+){4}(\\d+)`, "m");
    for (const t of tables) {
      const m = t === null ? null : line.exec(t);
      if (m) return Number(m[1]);
    }
    return null;
  };
  const keep = (k: string, uid: number | null | undefined) => {
    if (uid === undefined) return uid;
    if (cache.size > 4096) cache.clear();
    cache.set(k, { uid, at: now() });
    return uid;
  };
  return (peerPort: number, serverPort: number): number | null | undefined | Promise<number | null | undefined> => {
    const k = `${peerPort}:${serverPort}`;
    const hit = cache.get(k);
    if (hit && now() - hit.at < 1000) return hit.uid;
    return (async () => {
      // A read already under way may have started before this connection was
      // made: when it does not list it, one that starts now does.
      if (reading) {
        const uid = find(await reading, peerPort, serverPort);
        if (typeof uid === "number") return keep(k, uid);
      }
      return keep(k, find(await table(), peerPort, serverPort));
    })();
  };
}
const peerUid = uidLookup();

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
  if (OWN_AUTH.test(new URL(req.url).pathname)) return undefined;
  const answer = (why: string | null) => (!why || hasToken(req, new URL(req.url).pathname === "/ws") ? undefined : refuse(`${why} needs the access token (Settings > Safety > Remote access)`));
  if (forwarded(req)) return answer("a request through a proxy or tunnel");
  if (ip && !loopback) return answer(`a request from ${ip.address}`);
  if (!ip || !srv?.port) return answer(null);
  const owner = (uid: number | null | undefined) => {
    const me = process.getuid?.();
    if (uid === null) return answer("a connection the kernel does not list");
    if (uid !== undefined && me !== undefined && uid !== me && uid !== 0) return answer(`a process of another account (uid ${uid})`);
    return answer(null);
  };
  const uid = peerUid(ip.port, srv.port);
  return uid instanceof Promise ? uid.then(owner) : owner(uid);
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
