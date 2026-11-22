// The network of a sandboxed command.
//
// A confined command never shares the host's network namespace: it gets a
// private one (bubblewrap --unshare-net), with a loopback of its own and no
// route anywhere. So the host's loopback (Keel's own API, every local
// listener, the display's abstract sockets), the local network and the
// cloud metadata addresses are not there for it.
//
// With the session's network on, what leaves goes through a proxy this
// process runs: HTTP and HTTP CONNECT, asked by name. The proxy resolves the
// name once, refuses an address on this machine or a private network, and
// connects to the address it checked. It listens on a unix socket in a
// folder of the sandbox's own (one per repository, src/safety/sandbox-scope.ts), bound into the sandbox;
// inside, a small relay (RELAY) listens on the sandbox's loopback and passes
// connections to that socket, and the proxy variables point at the relay.
// ssh reaches the proxy through the same program as its ProxyCommand.
//
// What does not speak HTTP proxy cannot leave: raw TCP, UDP, ICMP, and a
// program that resolves names itself (there is no resolver inside, and no
// route an answer could be used on).
//
// Research: ~/.cache/keel-work/bun/research/sandbox-network-and-secrets.md
// (Claude Code's sandbox runtime and Codex's managed proxy take the same
// shape: a private namespace and a bridge over a unix socket).
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { addressBytes, addressText, carried, internalBytes } from "../core/hosts.ts";
import { chunks } from "../core/proc.ts";
import type { ReadOpts, View } from "./sandbox-view.ts";

// ---- the relay: the program that runs inside the sandbox ----

// Self-contained: its text is written to a file and run by this process's
// own runtime (bun, or the keel binary as bun) inside the sandbox.
//   relay.js listen SOCKET          prints the port it listens on, then relays
//   relay.js connect SOCKET HOST PORT   ssh's ProxyCommand: stdin and stdout through a CONNECT
//   relay.js into SOCKET PORT PID   the other direction (run by the daemon inside the sandbox's network
//                                   namespace): listens on SOCKET and passes connections to the sandbox's
//                                   own 127.0.0.1:PORT, for as long as process PID lives
function relay() {
  // (No import here: the function's own text is the program.)
  const net = process.getBuiltinModule("node:net") as typeof import("node:net");
  const [mode, sock, host, port] = process.argv.slice(2) as [string, string, string?, string?];
  // The proxy's socket is made a moment after the daemon is asked for it: tried again for a short while.
  const dial = (then: (s: import("node:net").Socket) => void, fail: (e: Error) => void, tries = 40) => {
    const s = net.createConnection(sock);
    s.once("connect", () => { s.removeAllListeners("error"); then(s); });
    s.once("error", (e: NodeJS.ErrnoException) => {
      if (tries > 0 && (e.code === "ENOENT" || e.code === "ECONNREFUSED")) setTimeout(() => dial(then, fail, tries - 1), 50);
      else fail(e);
    });
  };
  if (mode === "listen") {
    const server = net.createServer((c) => {
      c.pause();
      c.on("error", () => {});
      dial((s) => {
        s.on("error", () => c.destroy());
        c.on("error", () => s.destroy());
        c.on("close", () => s.destroy());
        s.on("close", () => c.destroy());
        c.pipe(s);
        s.pipe(c);
      }, () => c.destroy());
    });
    server.listen(0, "127.0.0.1", () => {
      process.stdout.write(`${(server.address() as import("node:net").AddressInfo).port}\n`);
    });
    return;
  }
  if (mode === "connect" && host && port) {
    dial((s) => {
      s.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      let head = Buffer.alloc(0);
      const onData = (d: Buffer) => {
        head = Buffer.concat([head, d]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) { if (head.length > 65536) process.exit(1); return; }
        s.off("data", onData);
        const text = head.subarray(0, end).toString("latin1");
        if (!/^HTTP\/1\.[01] 200/.test(text)) {
          s.on("data", () => {});
          s.on("end", () => process.exit(1));
          const body = head.subarray(end + 4).toString("utf8").trim();
          process.stderr.write(`${body || text.split("\r\n")[0]}\n`);
          setTimeout(() => process.exit(1), 200);
          return;
        }
        const rest = head.subarray(end + 4);
        if (rest.length) process.stdout.write(rest);
        s.pipe(process.stdout);
        process.stdin.pipe(s);
      };
      s.on("data", onData);
      s.on("close", () => process.exit(0));
      s.on("error", () => process.exit(1));
    }, (e) => { process.stderr.write(`keel: the sandbox's proxy is not reachable: ${e.message}\n`); process.exit(1); });
    return;
  }
  if (mode === "into" && host && port) {
    const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
    try { fs.rmSync(sock, { force: true }); } catch {}
    const server = net.createServer((c) => {
      c.on("error", () => {});
      const s = net.createConnection({ host: "127.0.0.1", port: Number(host) });
      s.on("error", () => c.destroy());
      c.on("close", () => s.destroy());
      s.on("close", () => c.destroy());
      c.pipe(s);
      s.pipe(c);
    });
    server.listen(sock, () => process.stdout.write("ready\n"));
    // The sandbox's process is gone: so is its server, and this ends.
    setInterval(() => { if (!fs.existsSync(`/proc/${port}`)) { try { fs.rmSync(sock, { force: true }); } catch {} process.exit(0); } }, 2000);
    return;
  }
  process.stderr.write("usage: relay listen SOCKET | relay connect SOCKET HOST PORT | relay into SOCKET PORT PID\n");
  process.exit(2);
}
export const RELAY_JS = `(${relay.toString()})();\n`;

// Where things are inside every sandbox with the network on.
// (Under /tmp, which every sandbox gets as an empty folder of its own: a place bubblewrap can make mount points in.)
export const IN_SANDBOX = { exe: "/tmp/.keel-sandbox/exe", relay: "/tmp/.keel-sandbox/relay.js", net: "/tmp/.keel-sandbox/net", sock: "/tmp/.keel-sandbox/net/proxy.sock" };
// The shell words that start the relay inside the sandbox and point the
// proxy variables at it; run before the command. `NO_PROXY` keeps the
// command's own loopback direct (its dev server, its test database).
export const RELAY_START =
  `f=/tmp/.keel-relay.$$; p=; if mkfifo "$f" 2>/dev/null; then BUN_BE_BUN=1 ${IN_SANDBOX.exe} ${IN_SANDBOX.relay} listen ${IN_SANDBOX.sock} > "$f" 2>/dev/null < /dev/null & read -r p < "$f"; rm -f "$f"; fi; ` +
  `if [ -n "$p" ]; then export HTTP_PROXY="http://127.0.0.1:$p" HTTPS_PROXY="http://127.0.0.1:$p" http_proxy="http://127.0.0.1:$p" https_proxy="http://127.0.0.1:$p" ` +
  `NO_PROXY="localhost,127.0.0.1,::1" no_proxy="localhost,127.0.0.1,::1" NODE_USE_ENV_PROXY=1 KEEL_SANDBOX_PROXY="http://127.0.0.1:$p"; fi; unset f p; `;
// ssh has no HTTP proxy of its own: every host goes through the relay's CONNECT.
export const SSH_CONFIG = `# Written by Keel for its sandbox: ssh leaves through the sandbox's proxy.\nHost *\n    ProxyCommand /usr/bin/env BUN_BE_BUN=1 ${IN_SANDBOX.exe} ${IN_SANDBOX.relay} connect ${IN_SANDBOX.sock} %h %p\n`;

// ---- the policy ----

export type Verdict = { allow: true } | { allow: false; why: string };
// What a destination is judged by: the name the command asked for, the
// address it resolved to, the port. The default: any public address, never
// one of this machine's own or a private network's.
export type Policy = (host: string, address: string, port: number) => Verdict;

let mine: { at: number; set: Set<string> } | undefined;
let interfaces: typeof networkInterfaces = networkInterfaces;
// (A test says which addresses this machine has.)
export const setInterfaces = (read?: typeof networkInterfaces) => { interfaces = read ?? networkInterfaces; mine = undefined; };
// This machine's own addresses (a public one among them is still this machine).
function ownAddresses(): Set<string> {
  // (Read again every two seconds: an address this machine got after the daemon started, a VPN's or a tailnet's, is its own too.)
  if (mine && Date.now() - mine.at < 2_000) return mine.set;
  const set = new Set<string>();
  // (Each by the one text of its bytes: what an address is compared as.)
  try { for (const list of Object.values(interfaces())) for (const a of list ?? []) { const b = addressBytes(a.address); if (b) set.add(addressText(b)); } } catch {} // unreadable: the ranges below still hold
  mine = { at: Date.now(), set };
  return set;
}
// The daemon's own listeners: never reachable from a sandbox, whatever a list says later.
const ownPorts = new Set<number>();
export const ownPort = (port: number | undefined) => {
  if (!port || ownPorts.has(port)) return;
  ownPorts.add(port);
  // (The proxies' thread keeps its own copy.)
  if (thread) thread.postMessage({ t: "own", port });
};

export const publicOnly: Policy = (_host, address, port) => {
  // By the address's bytes, never its text: an address has many spellings.
  // One of this machine's own public addresses is this machine too, also carried inside an IPv6 one.
  const bytes = addressBytes(address), v4 = bytes && carried(bytes);
  const local = !bytes || internalBytes(bytes) || ownAddresses().has(addressText(bytes)) || (!!v4 && ownAddresses().has(addressText(v4)));
  if (local && ownPorts.has(port)) return { allow: false, why: "Keel's own API is never reachable from a sandbox" };
  if (local) return { allow: false, why: "it is an address on this machine or a private network" };
  return { allow: true };
};

// ---- the proxy ----

export type Refusal = { host: string; port: number; why: string; at: number };
const HEAD_MAX = 64 * 1024;
const HEAD_MS = 30_000;
// How long a destination has to take the connection.
const CONNECT_MS = 30_000;
// Connections one sandbox scope's proxy carries at once. The package
// managers measured open at most 64 at a time; four times that leaves room
// for several commands. Past it the connection that has carried nothing for
// the longest (a minute or more) is ended for the new one, else the new one
// is refused. What a connection holds in memory is bounded by its two
// sockets' buffers: a slow side stops the other from being read.
const CONNECTIONS_MAX = 256;
const IDLE_MS = 60_000;

const refusalText = (host: string, port: number, why: string) =>
  `Keel's sandbox proxy refused ${host}:${port}: ${why}.`;
function refuse(c: Socket, status: string, text: string) {
  c.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nX-Keel-Sandbox: refused\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(text) + 1}\r\n\r\n${text}\n`);
}

// One proxy on one unix socket. `policy` is asked once per connection, with
// the address the connection is then made to (no second resolution).
export function startProxy(path: string, o: { policy?: () => Policy; refused?: (r: Refusal) => void; resolve?: (host: string) => Promise<string[]>; headMs?: number; max?: number } = {}): Server {
  const live = new Map<Socket, number>();
  const touch = (c: Socket) => { if (live.has(c)) live.set(c, Date.now()); };
  // (IPv4 first: the address connected to is the first, and a machine without an IPv6 route has many names with both.)
  const resolve = o.resolve ?? (async (host: string) => (await lookup(host, { all: true, verbatim: true })).sort((a, b) => a.family - b.family).map((a) => a.address));
  const server = createServer((c) => {
    c.on("error", () => {});
    if (live.size >= (o.max ?? CONNECTIONS_MAX)) {
      let oldest: Socket | undefined, at = Date.now() - IDLE_MS;
      for (const [s, t] of live) if (t <= at) { oldest = s; at = t; }
      if (!oldest) return refuse(c, "503 Service Unavailable", `Keel's sandbox proxy carries ${o.max ?? CONNECTIONS_MAX} connections at once for one sandbox, and all are in use.`);
      oldest.destroy();
      live.delete(oldest);
    }
    live.set(c, Date.now());
    c.on("close", () => live.delete(c));
    let head: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => c.destroy(), o.headMs ?? HEAD_MS);
    const onData = (d: Buffer) => {
      head = head.length ? Buffer.concat([head, d]) : d;
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) { if (head.length > HEAD_MAX) { clearTimeout(timer); refuse(c, "431 Request Header Fields Too Large", "The request's headers are too long for Keel's sandbox proxy."); } return; }
      clearTimeout(timer);
      c.off("data", onData);
      c.pause();
      void serve(c, head.subarray(0, end).toString("latin1"), head.subarray(end + 4));
    };
    c.on("data", onData);
    c.on("close", () => clearTimeout(timer));
  });
  const serve = async (c: Socket, text: string, rest: Buffer) => {
    const lines = text.split("\r\n");
    const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? "");
    if (!m) return refuse(c, "400 Bad Request", "Keel's sandbox proxy takes HTTP requests and CONNECT.");
    const [, method, target] = m as unknown as [string, string, string];
    let host: string, port: number, first: Buffer | undefined;
    if (method === "CONNECT") {
      const at = /^(\[[0-9a-fA-F:.]+\]|[^:\s]+):(\d{1,5})$/.exec(target);
      if (!at) return refuse(c, "400 Bad Request", "CONNECT names a host and a port.");
      host = at[1]!.replace(/^\[|\]$/g, "");
      port = Number(at[2]);
    } else {
      let u: URL;
      try { u = new URL(target); } catch { return refuse(c, "400 Bad Request", "Keel's sandbox proxy takes a whole URL (http://host/path) or CONNECT; this request names neither."); }
      if (u.protocol !== "http:") return refuse(c, "400 Bad Request", `Keel's sandbox proxy does not carry ${u.protocol} this way.`);
      host = u.hostname.replace(/^\[|\]$/g, "");
      port = Number(u.port || 80);
      // The request as its server takes it: the path alone, no word for the proxy, one request a connection, and the
      // host the request line names (a Host header that says another, or none, is not what was judged).
      const headers = lines.slice(1).filter((l) => !/^(proxy-connection|proxy-authorization|connection|keep-alive|host):/i.test(l));
      first = Buffer.from(`${method} ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\n${headers.join("\r\n")}${headers.length ? "\r\n" : ""}Connection: close\r\n\r\n`, "latin1");
    }
    if (!(port > 0 && port < 65536)) return refuse(c, "400 Bad Request", "The port is not one.");
    const no = (why: string) => {
      o.refused?.({ host, port, why, at: Date.now() });
      refuse(c, "403 Forbidden", refusalText(host, port, why));
    };
    // A host that is an address, however it is written (hex, octal, one number, IPv6 written out, an IPv4 address
    // inside an IPv6 one), is that address: parsed to bytes here, judged by them, and connected to by the one text
    // of them. What a name resolves to goes the same way.
    let addresses: string[];
    const literal = addressBytes(host);
    try { addresses = literal ? [addressText(literal)] : await resolve(host); } catch { return refuse(c, "502 Bad Gateway", `Keel's sandbox proxy could not resolve ${host}.`); }
    const parsed = addresses.map((a) => addressBytes(a));
    if (!addresses.length || parsed.some((b) => !b)) return refuse(c, "502 Bad Gateway", `Keel's sandbox proxy could not resolve ${host}.`);
    addresses = parsed.map((b) => addressText(b!));
    // Every address the name has must pass: a name with one address inside and one outside is not taken apart.
    const policy = (o.policy ?? (() => publicOnly))();
    for (const a of addresses) { const v = policy(host, a, port); if (!v.allow) return no(v.why); }
    if (c.destroyed) return;
    const up = createConnection({ host: addresses[0]!, port });
    let connected = false;
    const slow = setTimeout(() => { if (!connected) { up.destroy(); if (!c.destroyed && c.writable) refuse(c, "504 Gateway Timeout", `Keel's sandbox proxy got no answer from ${host}:${port} in ${CONNECT_MS / 1000} s.`); } }, CONNECT_MS);
    up.once("connect", () => {
      connected = true;
      clearTimeout(slow);
      up.setNoDelay(true);
      c.on("data", () => touch(c));
      up.on("data", () => touch(c));
      if (method === "CONNECT") c.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      else up.write(first!);
      if (rest.length) up.write(rest);
      c.pipe(up);
      up.pipe(c);
    });
    up.on("error", (e: NodeJS.ErrnoException) => {
      if (connected) return void c.destroy();
      if (!c.destroyed && c.writable) refuse(c, "502 Bad Gateway", `Keel's sandbox proxy could not connect to ${host}:${port}${e.code ? ` (${e.code})` : ""}.`);
    });
    up.on("close", () => { clearTimeout(slow); c.destroy(); });
    c.on("close", () => { clearTimeout(slow); up.destroy(); });
  };
  rmSync(path, { force: true });
  server.listen(path);
  server.unref();
  return server;
}

// ---- one proxy per sandbox scope, in this process ----

// The proxies run on a thread of their own (net-proxy-worker.ts): carrying
// is work for every chunk, and the daemon's loop is not held by it. Where
// the thread cannot be started, a proxy runs here.
declare const __KEEL_NETPROXY_JS__: string | undefined;
export type ViewAsk = { workspace: string; profile: "workspace-write" | "read-only"; read: ReadOpts; env: Record<string, string | undefined>; layered: boolean; offers: string[]; state: string };
export type ToProxy = { t: "listen"; path: string } | { t: "own"; port: number } | ({ t: "view"; id: number } & ViewAsk);
export type FromProxy = { t: "listening"; path: string } | { t: "refused"; path: string; r: Refusal } | { t: "failed"; path: string; error: string } | { t: "view"; id: number; view?: View; error?: string };
// A view made on the sandboxes' thread: nothing when there is no thread (the caller makes it itself).
const views = new Map<number, (v: View | undefined) => void>();
let viewId = 0;
export function viewOnThread(ask: ViewAsk): Promise<View | undefined> | undefined {
  const w = proxyThread();
  if (!w) return undefined;
  return new Promise((done) => {
    const id = ++viewId;
    views.set(id, done);
    setTimeout(() => { if (views.delete(id)) done(undefined); }, 30_000).unref?.();
    w.postMessage({ t: "view", id, ...ask } satisfies ToProxy);
  });
}
const refusals = new Map<string, Refusal[]>();
const asked = new Set<string>();
const local = new Map<string, Server>();
const noted = (path: string, r: Refusal) => {
  const list = refusals.get(path) ?? [];
  list.push(r);
  if (list.length > 200) list.splice(0, 100);
  refusals.set(path, list);
};
let thread: Worker | null | undefined;
function proxyThread(): Worker | null {
  if (thread !== undefined) return thread;
  try {
    const program = typeof __KEEL_NETPROXY_JS__ === "string"
      ? URL.createObjectURL(new Blob([__KEEL_NETPROXY_JS__], { type: "application/javascript" }))
      : new URL("./net-proxy-worker.ts", import.meta.url).href;
    const w = new Worker(program);
    (w as Worker & { unref?: () => void }).unref?.();
    w.onmessage = (ev: MessageEvent<FromProxy>) => {
      const m = ev.data;
      if (m.t === "view") { const done = views.get(m.id); views.delete(m.id); done?.(m.view); }
      else if (m.t === "refused") noted(m.path, m.r);
      // A socket the thread could not listen on is listened on here.
      else if (m.t === "failed") here(m.path);
    };
    // The thread is gone: what it listened on is listened on here from now on.
    w.onerror = () => { thread = null; for (const path of asked) here(path); for (const [id, done] of views) { views.delete(id); done(undefined); } };
    for (const port of ownPorts) w.postMessage({ t: "own", port } satisfies ToProxy);
    thread = w;
  } catch {
    thread = null; // no thread in this build: the proxies run on this one
  }
  return thread;
}
function here(path: string) {
  if (local.has(path)) return;
  try { local.set(path, startProxy(path, { refused: (r) => noted(path, r) })); } catch {} // the next command asks again
}
// The folder a sandbox scope's proxy socket is in (bound into its sandboxes),
// with the proxy asked for when it is not there yet (the socket appears a
// moment later: the relay inside the sandbox waits for it). `dir` is the
// scope's own folder in Keel's state (scopeDir).
export function proxyDir(dir: string): string {
  const net = join(dir, "net");
  const sock = join(net, "proxy.sock");
  if (asked.has(sock) && existsSync(sock)) return net;
  mkdirSync(net, { recursive: true, mode: 0o700 });
  asked.add(sock);
  const w = proxyThread();
  if (w) w.postMessage({ t: "listen", path: sock } satisfies ToProxy);
  else here(sock);
  return net;
}
// What a scope's proxy refused since a moment (a command's start): named in that command's result.
export function refusedSince(dir: string, since: number): Refusal[] {
  return (refusals.get(join(dir, "net", "proxy.sock")) ?? []).filter((r) => r.at >= since);
}

// ---- the other direction: the owner's portal reaches a server a sandboxed command runs ----

// A sandboxed command's server listens on the sandbox's own loopback. The
// daemon reaches it for the session's portal by running the relay inside
// that network namespace (nsenter(1): the namespace belongs to the same
// user, so no privilege is needed): the relay listens on a unix socket in
// the scope's folder and passes connections to the sandbox's port, and a
// listener here on this machine's loopback passes connections to that
// socket. `pid`: a process inside the sandbox (the one that listens).
const reaches = new Map<string, Promise<number>>();
export function reachInto(dir: string, pid: number, port: number, ns: string): Promise<number> {
  const key = `${ns}:${port}`;
  const have = reaches.get(key);
  if (have) return have;
  const made = (async () => {
    const nsenter = Bun.which("nsenter") ?? ["/usr/bin/nsenter", "/bin/nsenter"].find((p) => existsSync(p));
    if (!nsenter) throw new Error("nsenter (util-linux) is not installed: the portal cannot reach a server inside a sandbox");
    const into = join(dir, "in");
    mkdirSync(into, { recursive: true, mode: 0o700 });
    const sock = join(into, `${ns.replace(/\W+/g, "")}-${port}.sock`);
    const files = relayFiles(dirname(dir));
    const p = Bun.spawn([nsenter, "-t", String(pid), "-U", "-n", "--preserve-credentials", process.execPath, files.relay, "into", sock, String(port), String(pid)], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { ...process.env, BUN_BE_BUN: "1" } as Record<string, string> });
    const ready = await Promise.race([readFirstLine(p.stdout), Bun.sleep(5_000).then(() => "")]);
    if (ready.trim() !== "ready") { p.kill(); throw new Error("the relay did not start inside the sandbox"); }
    const local = createServer((c) => {
      c.on("error", () => {});
      const s = createConnection(sock);
      s.on("error", () => c.destroy());
      c.on("close", () => s.destroy());
      s.on("close", () => c.destroy());
      c.pipe(s);
      s.pipe(c);
    });
    await new Promise<void>((done, fail) => { local.once("error", fail); local.listen(0, "127.0.0.1", done); });
    local.unref();
    void p.exited.then(() => { reaches.delete(key); local.close(); });
    return (local.address() as { port: number }).port;
  })();
  reaches.set(key, made);
  made.catch(() => reaches.delete(key));
  return made;
}
async function readFirstLine(pipe: ReadableStream<Uint8Array>): Promise<string> {
  let text = "";
  for await (const c of chunks(pipe)) { text += new TextDecoder().decode(c); if (text.includes("\n")) break; }
  return text.split("\n")[0] ?? "";
}

// The relay's text and ssh's settings, as files (written once, and again when this build's differ).
export function relayFiles(root: string): { relay: string; ssh: string } {
  const relayAt = join(root, "relay.js"), ssh = join(root, "ssh-proxy.conf");
  for (const [file, text] of [[relayAt, RELAY_JS], [ssh, SSH_CONFIG]] as const) {
    let now: string | undefined;
    try { now = readFileSync(file, "utf8"); } catch {} // not written yet
    if (now !== text) { mkdirSync(root, { recursive: true, mode: 0o700 }); writeFileSync(file, text, { mode: 0o644 }); }
  }
  return { relay: relayAt, ssh };
}
