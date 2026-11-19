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
type Check = (req: Request, path: string) => Response | undefined;
const checks: Check[] = [];
export const addAdmission = (c: Check) => void checks.push(c);

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i;

function hostName(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.replace(/:\d+$/, "");
}

export function allowedHost(host: string | null): boolean {
  if (!host) return false;
  const name = hostName(host.toLowerCase());
  if (LOOPBACK.test(name)) return true;
  const extra = (process.env.KEEL_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
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

// The portal proxies a session's own dev server under a capability key in its
// path, served sandboxed (opaque origin, no access to the API): its pages send
// Origin "null" and must still load. Only the Host check applies there.
const PORTAL = /^\/(fleet-)?portal\//;

export function admit(req: Request): Response | undefined {
  const path0 = new URL(req.url).pathname;
  const guard = PORTAL.test(path0) ? (allowedHost(req.headers.get("host")) ? undefined : refuse("host not allowed")) : originCheck(req);
  if (guard) return guard;
  if (!checks.length) return undefined;
  const path = new URL(req.url).pathname;
  for (const c of checks) {
    const r = c(req, path);
    if (r) return r;
  }
  return undefined;
}
