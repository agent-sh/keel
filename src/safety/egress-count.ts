// The pure part of the outward ledger (src/safety/egress.ts): where an
// address goes (its host and port) and how many bytes a request carries.
// Nothing here reads the clock, the disk or the network.

// The port a scheme goes to when its address names none.
const PORTS: Record<string, number> = { http: 80, https: 443, ws: 80, wss: 443, ssh: 22, git: 9418, ftp: 21, sftp: 22, ftps: 990 };

export type Endpoint = { host: string; port: number | null };

// The host and port an address leaves for. A URL of any scheme with a host;
// the short ssh form of git (`[user@]host:path`); a bare `host:port`.
// Nothing for a folder or file on this machine, or text that names no host.
export function endpointOf(address: string): Endpoint | null {
  const text = address.trim();
  if (!text || text.startsWith("/") || text.startsWith("./") || text.startsWith("../") || text.startsWith("file:")) return null;
  // (`<helper>::<address>`: a transport program of git's; the address after it is where it goes.)
  const helper = /^[A-Za-z][A-Za-z0-9+.-]*::(.+)$/.exec(text);
  if (helper) return endpointOf(helper[1]!);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) {
    let u: URL;
    try { u = new URL(text); } catch { return null; }
    const host = hostText(u.hostname);
    if (!host) return null;
    const scheme = u.protocol.slice(0, -1).toLowerCase();
    return { host, port: u.port ? Number(u.port) : PORTS[scheme] ?? null };
  }
  // host:port (an address of the proxy's CONNECT, a bare listener).
  const bare = /^(\[[0-9A-Fa-f:.]+\]|[^\s:/@]+):(\d{1,5})$/.exec(text);
  if (bare) return { host: hostText(bare[1]!), port: Number(bare[2]) };
  // The short ssh form: [user@]host:path (a colon before any slash).
  const scp = /^(?:[^@/\s]+@)?(\[[0-9A-Fa-f:.]+\]|[^:/\s]+):(?!\/\/)/.exec(text);
  if (scp) return { host: hostText(scp[1]!), port: 22 };
  return null;
}

// A host as rows keep it: lower case, no brackets, no trailing dot.
export function hostText(host: string): string {
  return host.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

// This machine's own loopback, by name or address (a listener here is reached through it).
export function loopbackHost(host: string): boolean {
  const h = hostText(host);
  return h === "localhost" || h.endsWith(".localhost") || /^127\.\d+\.\d+\.\d+$/.test(h) || h === "::1" || h === "0:0:0:0:0:0:0:1" || h === "::ffff:127.0.0.1";
}

const utf8 = new TextEncoder();
const len = (text: string) => Buffer.byteLength(text, "utf8");
// The bytes a body is sent as, when that is known before it is sent: text, bytes, a file or a form of
// fields. Null for a stream and a multipart form (their length is decided as they are sent).
export function bodyBytes(body: unknown): number | null {
  if (body === undefined || body === null) return 0;
  if (typeof body === "string") return len(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  if (body instanceof URLSearchParams) return len(body.toString());
  return null;
}

type HeaderList = Headers | Record<string, string | readonly string[] | undefined> | readonly (readonly [string, string])[] | undefined;
function headerPairs(h: HeaderList): [string, string][] {
  if (!h) return [];
  if (typeof Headers !== "undefined" && h instanceof Headers) { const out: [string, string][] = []; h.forEach((v, k) => out.push([k, v])); return out; }
  if (Array.isArray(h)) return h.map(([k, v]) => [String(k), String(v)]);
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) out.push([k, String(one)]);
  }
  return out;
}

// What one HTTP request carries out as HTTP/1.1 writes it: its request line,
// a Host line, the headers it was given and its body. (What the HTTP library
// adds of its own, a user agent or a length, is a few dozen bytes more; TLS
// framing is not counted.) Null when the body's length is not known first.
export function requestBytes(r: { method?: string; url: string; headers?: HeaderList; body?: unknown }): number | null {
  const body = bodyBytes(r.body);
  if (body === null) return null;
  let path = "/", host = "";
  try { const u = new URL(r.url); path = `${u.pathname}${u.search}` || "/"; host = u.host; } catch { path = r.url; }
  let n = len(`${(r.method ?? "GET").toUpperCase()} ${path} HTTP/1.1\r\nHost: ${host}\r\n`);
  for (const [k, v] of headerPairs(r.headers)) if (k.toLowerCase() !== "host") n += len(`${k}: ${v}\r\n`);
  return n + 2 + body;
}

// What a WebSocket's opening request carries out: a GET with the headers the
// caller gave and the four the client adds to ask for the upgrade.
export function handshakeBytes(url: string, headers?: HeaderList): number {
  const http = url.replace(/^ws(s?):/i, "http$1:");
  const upgrade: [string, string][] = [["Connection", "Upgrade"], ["Upgrade", "websocket"], ["Sec-WebSocket-Version", "13"], ["Sec-WebSocket-Key", "x".repeat(24)]];
  return requestBytes({ method: "GET", url: http, headers: [...headerPairs(headers), ...upgrade] })!;
}

// What one client message of `n` bytes is on the wire: its payload, the frame's
// two bytes, the longer length a long payload needs, and the client's mask.
export const frameBytes = (n: number) => n + 2 + (n >= 65_536 ? 8 : n >= 126 ? 2 : 0) + 4;

// The tag a sandbox's relay puts before a connection it passes to the proxy
// (the call the connection belongs to), and what follows it. `need`: the head
// is not long enough to tell yet. A head without a tag is given back as it is.
export const TAG_LINE = "KEEL-TAG ";
export function takeTag(head: Uint8Array): { tag?: string; rest: Uint8Array } | "need" {
  const word = utf8.encode(TAG_LINE);
  const n = Math.min(head.length, word.length);
  for (let i = 0; i < n; i++) if (head[i] !== word[i]) return { rest: head };
  if (head.length < word.length) return "need";
  const end = head.indexOf(0x0a, word.length);
  // (A line that does not end soon is no tag: the head goes on as it is, and the proxy refuses it.)
  if (end < 0) return head.length > 256 ? { rest: head } : "need";
  const raw = new TextDecoder().decode(head.subarray(word.length, end)).replace(/\r$/, "");
  return { ...(/^[0-9a-z]{1,40}$/.test(raw) ? { tag: raw } : {}), rest: head.subarray(end + 1) };
}

// A row's reason as the ledger keeps it: what failed, never where it pointed.
// An error's words often hold the address it was for (a fetch's, git's
// "unable to access 'https://host/path.git?token=...'"), and the host is a
// column of its own: an address is cut to its scheme and host (no user, no
// path, no query), the short ssh form to its host, a path after a host name
// and a query left anywhere are dropped.
export function plainWhy(text: string): string {
  return text
    .replace(/\b([A-Za-z][A-Za-z0-9+.-]*):\/\/[^\s'"<>]*/g, (whole: string, scheme: string) => {
      const end = endpointOf(whole);
      return end ? `${scheme.toLowerCase()}://${end.host.includes(":") ? `[${end.host}]` : end.host}` : `${scheme.toLowerCase()}://`;
    })
    .replace(/(?<![\w.@-])[^\s@'"/:]+@([A-Za-z0-9.-]+):(?!\/\/)[^\s'"]*/g, "$1")
    .replace(/(?<![\w/.-])((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d{1,5})?)\/[^\s'"]*/g, "$1")
    .replace(/\?[^\s'"]*=[^\s'"]*/g, "")
    .trim();
}

// What became of a failed git push, as a fixed class (git's own words name the
// remote's path and can hold a token): the remote refused it, could not be
// reached, or did not take the sign-in.
export type PushFailure = "the push was refused" | "the remote was unreachable" | "the sign-in was refused" | "the push failed";
export function pushFailure(stderr: string): PushFailure {
  const t = stderr.toLowerCase();
  if (/authentication failed|permission denied|could not read username|could not read password|invalid username|returned error: (401|403)|\b(401|403)\b|publickey|access denied|not authorized|unauthorized/.test(t)) return "the sign-in was refused";
  if (/\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|hook declined|protected branch|failed to push some refs|denied to/.test(t)) return "the push was refused";
  if (/could not resolve|connection refused|connection timed out|timed out|network is unreachable|no route to host|could not connect|failed to connect|unable to access|could not read from remote|connection reset|ssl|tls|does not appear to be a git repository|repository not found/.test(t)) return "the remote was unreachable";
  return "the push failed";
}

// The start of the local day a moment is in.
export const dayStart = (at: number) => { const d = new Date(at); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
