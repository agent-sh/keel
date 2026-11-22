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
import { createConnection, createServer, isIP, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { internalAddress } from "../core/hosts.ts";

// ---- the relay: the program that runs inside the sandbox ----

// Self-contained: its text is written to a file and run by this process's
// own runtime (bun, or the keel binary as bun) inside the sandbox.
//   relay.js listen SOCKET          prints the port it listens on, then relays
//   relay.js connect SOCKET HOST PORT   ssh's ProxyCommand: stdin and stdout through a CONNECT
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
  process.stderr.write("usage: relay listen SOCKET | relay connect SOCKET HOST PORT\n");
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
// This machine's own addresses (a public one among them is still this machine).
function ownAddresses(): Set<string> {
  if (mine && Date.now() - mine.at < 30_000) return mine.set;
  const set = new Set<string>();
  try { for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) set.add(a.address.toLowerCase()); } catch {} // unreadable: the ranges below still hold
  mine = { at: Date.now(), set };
  return set;
}
// The daemon's own listeners: never reachable from a sandbox, whatever a list says later.
const ownPorts = new Set<number>();
export const ownPort = (port: number | undefined) => { if (port) ownPorts.add(port); };

export const publicOnly: Policy = (_host, address, port) => {
  const local = internalAddress(address) || ownAddresses().has(address.toLowerCase());
  if (local && ownPorts.has(port)) return { allow: false, why: "Keel's own API is never reachable from a sandbox" };
  if (local) return { allow: false, why: "it is an address on this machine or a private network" };
  return { allow: true };
};

// ---- the proxy ----

export type Refusal = { host: string; port: number; why: string; at: number };
const HEAD_MAX = 64 * 1024;
const HEAD_MS = 30_000;

const refusalText = (host: string, port: number, why: string) =>
  `Keel's sandbox proxy refused ${host}:${port}: ${why}.`;
function refuse(c: Socket, status: string, text: string) {
  c.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nX-Keel-Sandbox: refused\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(text) + 1}\r\n\r\n${text}\n`);
}

// One proxy on one unix socket. `policy` is asked once per connection, with
// the address the connection is then made to (no second resolution).
export function startProxy(path: string, o: { policy?: () => Policy; refused?: (r: Refusal) => void; resolve?: (host: string) => Promise<string[]> } = {}): Server {
  // (IPv4 first: the address connected to is the first, and a machine without an IPv6 route has many names with both.)
  const resolve = o.resolve ?? (async (host: string) => (await lookup(host, { all: true, verbatim: true })).sort((a, b) => a.family - b.family).map((a) => a.address));
  const server = createServer((c) => {
    c.on("error", () => {});
    let head: Buffer = Buffer.alloc(0);
    const timer = setTimeout(() => c.destroy(), HEAD_MS);
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
      // The request as its server takes it: the path alone, no word for the proxy, one request a connection.
      const headers = lines.slice(1).filter((l) => !/^(proxy-connection|proxy-authorization|connection|keep-alive):/i.test(l));
      first = Buffer.from(`${method} ${u.pathname}${u.search} HTTP/1.1\r\n${headers.join("\r\n")}${headers.length ? "\r\n" : ""}Connection: close\r\n\r\n`, "latin1");
    }
    if (!(port > 0 && port < 65536)) return refuse(c, "400 Bad Request", "The port is not one.");
    const no = (why: string) => {
      o.refused?.({ host, port, why, at: Date.now() });
      refuse(c, "403 Forbidden", refusalText(host, port, why));
    };
    let addresses: string[];
    try { addresses = isIP(host) ? [host] : await resolve(host); } catch { return refuse(c, "502 Bad Gateway", `Keel's sandbox proxy could not resolve ${host}.`); }
    if (!addresses.length) return refuse(c, "502 Bad Gateway", `Keel's sandbox proxy could not resolve ${host}.`);
    // Every address the name has must pass: a name with one address inside and one outside is not taken apart.
    const policy = (o.policy ?? (() => publicOnly))();
    for (const a of addresses) { const v = policy(host, a, port); if (!v.allow) return no(v.why); }
    if (c.destroyed) return;
    const up = createConnection({ host: addresses[0]!, port });
    let connected = false;
    up.once("connect", () => {
      connected = true;
      up.setNoDelay(true);
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
    up.on("close", () => c.destroy());
    c.on("close", () => up.destroy());
  };
  rmSync(path, { force: true });
  server.listen(path);
  server.unref();
  return server;
}

// ---- one proxy per sandbox scope, in this process ----

const proxies = new Map<string, { server: Server; refusals: Refusal[] }>();
// The folder a sandbox scope's proxy socket is in (bound into its sandboxes),
// with the proxy started when it is not yet. `dir` is the scope's own folder
// in Keel's state (scopeDir).
export function proxyDir(dir: string): string {
  const net = join(dir, "net");
  const sock = join(net, "proxy.sock");
  const have = proxies.get(net);
  if (have && existsSync(sock)) return net;
  have?.server.close();
  mkdirSync(net, { recursive: true, mode: 0o700 });
  const refusals: Refusal[] = [];
  const server = startProxy(sock, { refused: (r) => { refusals.push(r); if (refusals.length > 200) refusals.splice(0, 100); } });
  proxies.set(net, { server, refusals });
  return net;
}
// What a scope's proxy refused since a moment (a command's start): named in that command's result.
export function refusedSince(dir: string, since: number): Refusal[] {
  return (proxies.get(join(dir, "net"))?.refusals ?? []).filter((r) => r.at >= since);
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
