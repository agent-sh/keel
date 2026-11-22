// The sandbox's network: the proxy's rule on the address a name resolves to,
// its two ways in (CONNECT and a plain HTTP request), and a confined command
// that cannot reach this machine's loopback by any route while public hosts
// stay reachable through the proxy. The stand-in servers are on this
// machine's loopback: what a sandbox must never reach.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { hostname, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { addressBytes, addressText, internalAddress } from "../core/hosts.ts";
import { sessionPorts, forgetOwnership } from "../fleet/portal.ts";
import { ownPort, publicOnly, reachInto, RELAY_JS, setInterfaces, startProxy, type Policy, type Refusal } from "./net-proxy.ts";
import { sandboxScope, scopeDir } from "./sandbox-scope.ts";
import { sandboxSaid } from "./refwatch.ts";
import { confine, sandboxStatus } from "./sandbox.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-net-")));
// A server on the host's loopback that says who asked: the stand-in for Keel's own API and any local service.
const hits: string[] = [];
let standin: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  standin = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: async (req) => {
    const path = new URL(req.url).pathname;
    hits.push(`${req.method} ${path}`);
    // A redirect to another port of this machine; an answer sent in pieces; else what was asked, as the server saw it.
    if (path.startsWith("/redirect/")) return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${path.slice(10)}/after-redirect` } });
    if (path === "/pieces") return new Response(new ReadableStream({ async start(c) { for (const part of ["one ", "two ", "three"]) { c.enqueue(new TextEncoder().encode(part)); await Bun.sleep(5); } c.close(); } }));
    const body = req.body ? await req.text() : "";
    return new Response(`standin saw ${req.method} ${path} host=${req.headers.get("host")} proxy=${req.headers.get("proxy-connection")} body=${body}\n`);
  } });
});
afterAll(() => { standin.stop(true); rmSync(root, { recursive: true, force: true }); });

// One request through a proxy socket, as text.
function ask(sock: string, text: string, then?: string): Promise<string> {
  return new Promise((done) => {
    const c = createConnection(sock);
    let got = "";
    let sent = false;
    c.on("data", (d) => {
      got += d.toString("latin1");
      if (then && !sent && got.includes("\r\n\r\n")) { sent = true; c.write(then); }
    });
    c.on("close", () => done(got));
    c.on("error", () => done(got));
    c.write(text);
    setTimeout(() => c.destroy(), 5_000).unref();
  });
}

test("an address is judged where it is: loopback, private, carrier, link-local, mapped and reserved ranges are inside; a public one is not", () => {
  const within = ["127.0.0.1", "127.8.9.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.1.1", "0.0.0.0", "192.0.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::10.0.0.1", "64:ff9b::a00:1", "[::1]", "999.1.1.1", "localhost"];
  const outside = ["93.184.216.34", "1.1.1.1", "8.8.8.8", "172.32.0.1", "172.15.0.1", "100.63.0.1", "100.128.0.1", "192.167.1.1", "198.20.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808"];
  expect(within.filter((a) => !internalAddress(a))).toEqual([]);
  expect(outside.filter((a) => internalAddress(a))).toEqual([]);
});

// Every way an address can be written. An IPv4 one: dotted, a trailing dot, one number, hex and octal parts, short
// forms, and inside an IPv6 one (mapped, compatible, NAT64, 6to4), each compressed, written out, zero-padded, in
// upper case and with a dotted tail. An IPv6 one: the same forms of its own.
const hex = (n: number) => n.toString(16), pad = (h: string) => h.padStart(4, "0");
function sixes(groups: number[]): string[] {
  const g = groups.map(hex);
  const out = [g.join(":"), g.map(pad).join(":"), g.join(":").toUpperCase(), g.map(pad).join(":").toUpperCase()];
  // Each run of zero groups, compressed.
  for (let i = 0; i < 8; i++) for (let j = i + 1; j <= 8; j++) {
    if (groups.slice(i, j).some((x) => x !== 0)) continue;
    out.push(`${g.slice(0, i).join(":")}::${g.slice(j).join(":")}`, `${g.slice(0, i).map(pad).join(":")}::${g.slice(j).map(pad).join(":").toUpperCase()}`);
  }
  // The last 32 bits as a dotted quad.
  const tail = `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
  out.push(`${g.slice(0, 6).join(":")}:${tail}`);
  if (groups.slice(0, 5).every((x) => x === 0)) out.push(`::${groups[5] ? `${g[5]}:` : ""}${tail}`, `::${groups[5] ? `${g[5]!.toUpperCase()}:` : ""}${tail}`);
  if (groups.slice(2, 6).every((x) => x === 0)) out.push(`${g[0]}:${g[1]}::${tail}`);
  return [...new Set(out)];
}
function fours(b: number[], embedded = true): { plain: string[]; six: string[] } {
  const [a, x, c, d] = b as [number, number, number, number];
  const n = ((a * 256 + x) * 256 + c) * 256 + d, h = (v: number) => `0x${hex(v)}`, o = (v: number) => `0${v.toString(8)}`;
  const plain = [`${a}.${x}.${c}.${d}`, `${a}.${x}.${c}.${d}.`, String(n), h(n), `0X${hex(n).toUpperCase()}`, o(n), `${h(a)}.${h(x)}.${h(c)}.${h(d)}`, `${o(a)}.${o(x)}.${o(c)}.${o(d)}`,
    `${a}.${x}.${c * 256 + d}`, `${a}.${(x * 256 + c) * 256 + d}`, `${h(a)}.${(x * 256 + c) * 256 + d}`, `${o(a)}.${h(x)}.${c}.${d}`];
  const hi = (a << 8) | x, lo = (c << 8) | d;
  const six = [...sixes([0, 0, 0, 0, 0, 0xffff, hi, lo]), ...sixes([0x64, 0xff9b, 0, 0, 0, 0, hi, lo])];
  if (embedded) six.push(...sixes([0, 0, 0, 0, 0, 0, hi, lo]), ...sixes([0x2002, hi, lo, 0, 0, 0, 0, 1]), ...sixes([0, 0, 0, 0, 0xffff, 0, hi, lo]));
  return { plain: [...new Set(plain)], six: [...new Set(six)] };
}
const groupsOf = (text: string) => { const [l, r = ""] = text.split("::"); const a = l ? l.split(":") : [], z = r ? r.split(":") : []; return [...a, ...Array(8 - a.length - z.length).fill("0"), ...z].map((x) => parseInt(x, 16)); };
// What a sandbox must never reach: loopback, this machine's own addresses, link-local, private and carrier ranges, the unspecified address.
const INSIDE4 = ["127.0.0.1", "127.1.2.3", "127.255.255.254", "0.0.0.0", "0.1.2.3", "10.0.0.5", "10.255.255.255", "172.16.0.1", "172.31.255.254", "192.168.1.1", "169.254.169.254", "169.254.0.1", "100.64.0.1", "100.127.255.254"];
const INSIDE6 = ["::1", "::", "fe80::1", "fe80::abcd:1:2:3", "febf::1", "fc00::1", "fd12:3456:789a::1", "fec0::1", "ff02::1", "64:ff9b:1::1"];

test("an address is judged by its bytes: every spelling of an inside address is inside, and of a public one is not", () => {
  const wrong: string[] = [];
  for (const a of INSIDE4) {
    const s = fours(a.split(".").map(Number));
    for (const t of [...s.plain, ...s.six, ...s.six.map((x) => `[${x}]`), ...s.six.map((x) => `${x}%eth0`), ...s.six.map((x) => `[${x}%25lo]`)]) if (!internalAddress(t)) wrong.push(t);
  }
  for (const a of INSIDE6) for (const t of sixes(groupsOf(a))) for (const u of [t, `[${t}]`, `${t}%lo`, `[${t}%25eth0]`]) if (!internalAddress(u)) wrong.push(u);
  expect(wrong).toEqual([]);
  // Public addresses stay public in every spelling of theirs (an IPv4 one also mapped and through NAT64).
  const closed: string[] = [];
  for (const a of ["93.184.216.34", "1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "140.82.121.4"]) {
    const s = fours(a.split(".").map(Number), false);
    for (const t of [...s.plain, ...s.six, ...s.six.map((x) => `[${x}]`)]) if (internalAddress(t)) closed.push(t);
  }
  for (const a of ["2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e"]) for (const t of sixes(groupsOf(a))) if (internalAddress(t)) closed.push(t);
  expect(closed).toEqual([]);
  // What is not an address is not one: nothing to connect to.
  for (const t of ["", "example.com", "1.2.3.4.5", "1.2.3.256", "08.1.1.1", "0x", "::1::", "1:2:3:4:5:6:7:8:9", "12345::", ":::", "g::1", "1.2.3.4:80", "::ffff:1.2.3", "::ffff:1.2.3.4.5"]) expect([t, internalAddress(t)]).toEqual([t, true]);
  // The bytes, and the one text of them: what the proxy connects to.
  expect(addressText(addressBytes("0:0:0:0:0:FFFF:7F00:1")!)).toBe("127.0.0.1");
  expect(addressText(addressBytes("0x7f.1")!)).toBe("127.0.0.1");
  expect(addressText(addressBytes("[2606:4700:4700:0:0:0:0:1111]")!)).toBe("2606:4700:4700::1111");
  expect(addressText(addressBytes("0000:0000:0000:0000:0000:0000:0000:0001")!)).toBe("::1");
  expect(addressText(addressBytes("64:FF9B::8.8.8.8")!)).toBe("64:ff9b::808:808");
  expect(addressBytes("example.com")).toBeNull();
});

test("the proxy never reaches this machine under any spelling of its addresses, by CONNECT or by a plain request", async () => {
  // A listener on every address of this machine (IPv4 and IPv6), on a port that is not Keel's own: the address rule alone must hold.
  const reached: string[] = [];
  const local = createServer((c) => { c.on("error", () => {}); c.once("data", () => { reached.push("x"); c.end("HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nREACHED\n"); }); });
  await new Promise<void>((ok) => local.listen(0, "::", ok));
  const port = (local.address() as { port: number }).port;
  const sock = join(root, "spell.sock");
  // (No name resolves here: an address written any way is judged as the address it is, without a resolver.)
  const server = startProxy(sock, { resolve: async () => { throw new Error("no names in this test"); } });
  try {
    // (This machine's own addresses, a public one among them where it has one, and an address the test says is
    // this machine's: a public one, so the rule for own addresses is tested on every machine.)
    const PUBLIC4 = "203.0.113.7", PUBLIC6 = "2001:4860:4860::7";
    setInterfaces(() => ({ ...networkInterfaces(), test0: [{ address: PUBLIC4, family: "IPv4", internal: false }, { address: PUBLIC6, family: "IPv6", internal: false }] as any }));
    const own = Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal);
    const table: string[] = [];
    for (const a of ["127.0.0.1", "127.1.2.3", "0.0.0.0", PUBLIC4, ...own.filter((a) => a!.family === "IPv4").map((a) => a!.address)]) {
      const s = fours(a.split(".").map(Number));
      table.push(...s.plain, ...s.six.map((x) => `[${x}]`));
    }
    for (const a of ["::1", "::", PUBLIC6, ...own.filter((a) => a!.family === "IPv6").map((a) => a!.address)]) table.push(...sixes(groupsOf(a)).map((x) => `[${x}]`));
    const got: string[] = [];
    // (Eight at a time: a few hundred spellings.)
    const list = [...new Set(table)];
    for (let i = 0; i < list.length; i += 8) {
      await Promise.all(list.slice(i, i + 8).map(async (h) => {
        const a = await ask(sock, `CONNECT ${h}:${port} HTTP/1.1\r\nHost: ${h}:${port}\r\n\r\n`, "GET / HTTP/1.1\r\nHost: x\r\n\r\n");
        const b = await ask(sock, `GET http://${h}:${port}/ HTTP/1.1\r\nHost: example.com\r\n\r\n`);
        for (const [how, r] of [["CONNECT", a], ["GET", b]] as const) if (r.includes("REACHED") || !/^HTTP\/1\.1 (403|400) /.test(r)) got.push(`${how} ${h}: ${r.split("\r\n")[0]}`);
      }));
    }
    expect(got).toEqual([]);
    expect(reached).toEqual([]);
    expect(list.length).toBeGreaterThan(300);
  } finally {
    setInterfaces();
    server.close();
    local.close();
  }
}, 60_000);

test("the proxy refuses this machine and private networks by the resolved address, and Keel's own port by name", async () => {
  const refusals: Refusal[] = [];
  const sock = join(root, "a.sock");
  // Names resolve as the test says: a public name that points inside, one with an address inside and one outside.
  const names: Record<string, string[]> = { "rebind.example": ["127.0.0.1"], "mixed.example": ["93.184.216.34", "10.0.0.5"], "meta.example": ["169.254.169.254"], "gone.example": [] };
  const server = startProxy(sock, { refused: (r) => refusals.push(r), resolve: async (h) => { if (!(h in names)) throw new Error("no such name"); return names[h]!; } });
  try {
    ownPort(standin.port);
    const port = standin.port!;
    const connect = (to: string) => ask(sock, `CONNECT ${to} HTTP/1.1\r\nHost: ${to}\r\n\r\n`);
    const get = (url: string) => ask(sock, `GET ${url} HTTP/1.1\r\nHost: x\r\n\r\n`);
    // Keel's own port on any of this machine's addresses, by address and by a name that points there.
    for (const r of [await connect(`127.0.0.1:${port}`), await get(`http://127.0.0.1:${port}/api/sessions`), await connect(`rebind.example:${port}`), await get(`http://[::1]:${port}/api/sessions`), await connect(`[::ffff:127.0.0.1]:${port}`)]) {
      expect(r).toStartWith("HTTP/1.1 403 Forbidden\r\n");
      expect(r).toContain("X-Keel-Sandbox: refused");
      expect(r).toContain("Keel's own API is never reachable from a sandbox");
    }
    // Any other local or private address, the metadata address, and a name with one address inside.
    for (const r of [await connect("127.0.0.1:5432"), await get("http://10.0.0.1/"), await get("http://169.254.169.254/latest/meta-data/"), await connect("meta.example:80"), await connect("mixed.example:443"), await get("http://192.168.1.1:8080/x"), await connect("[fe80::1]:22")]) {
      expect(r).toStartWith("HTTP/1.1 403 Forbidden\r\n");
      expect(r).toContain("it is an address on this machine or a private network");
    }
    expect(hits).toEqual([]);
    expect(refusals.map((r) => `${r.host}:${r.port}`)).toContain(`rebind.example:${port}`);
    expect(refusals).toHaveLength(12);
    // What is not a proxy request, a name that does not resolve, another scheme: said, not served.
    expect(await ask(sock, "GET /api/sessions HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")).toStartWith("HTTP/1.1 400 ");
    expect(await ask(sock, "GET ftp://example.com/x HTTP/1.1\r\n\r\n")).toStartWith("HTTP/1.1 400 ");
    expect(await connect("nowhere.example:443")).toStartWith("HTTP/1.1 502 ");
    expect(await connect("gone.example:443")).toStartWith("HTTP/1.1 502 ");
    expect(await ask(sock, `GET http://x/${"a".repeat(70_000)}`)).toStartWith("HTTP/1.1 431 ");
    // The default rule itself.
    expect(publicOnly("example.com", "93.184.216.34", 443)).toEqual({ allow: true });
    expect(publicOnly("x", "127.0.0.1", port)).toEqual({ allow: false, why: "Keel's own API is never reachable from a sandbox" });
  } finally {
    server.close();
  }
});

test("an allowed destination is carried: CONNECT as a tunnel, a plain request as its server takes it", async () => {
  const sock = join(root, "b.sock");
  // (A rule that lets the stand-in through, as a listed host will: the carrying is what is tested.)
  const allow: Policy = () => ({ allow: true });
  const server = startProxy(sock, { policy: () => allow });
  try {
    const port = standin.port!;
    const tunnel = await ask(sock, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`, `GET /through-tunnel HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    expect(tunnel).toStartWith("HTTP/1.1 200 Connection Established\r\n\r\n");
    expect(tunnel).toContain("standin saw GET /through-tunnel");
    // The path alone reaches the server, the proxy's own header does not, and the connection is one request's.
    const plain = await ask(sock, `POST http://127.0.0.1:${port}/plain?x=1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nProxy-Connection: keep-alive\r\nContent-Length: 2\r\n\r\nhi`);
    expect(plain).toContain(`standin saw POST /plain host=127.0.0.1:${port} proxy=null body=hi`);
    expect(hits.slice(-2)).toEqual(["GET /through-tunnel", "POST /plain"]);
  } finally {
    server.close();
  }
});

test.skipIf(!sandboxStatus().available)("a confined command reaches no service of this machine, with the network on or off, in either profile; a public host goes through the proxy", async () => {
  const ws = join(root, "ws");
  await Bun.$`mkdir -p ${ws}`.quiet();
  ownPort(standin.port);
  const port = standin.port!;
  const run = async (script: string, perm: { sandbox: "workspace-write" | "read-only"; network: boolean }) => {
    const p = Bun.spawn(confine(["bash", "-c", script], perm, ws), { cwd: ws, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    return out + err;
  };
  // Every route a command has to the stand-in: straight, through the proxy variables, through the proxy's socket by
  // hand, by another name for loopback, and by reading the port from the kernel's tables (they are the sandbox's own).
  const routes = [
    `curl -s -m 3 --noproxy '*' http://127.0.0.1:${port}/direct || echo "direct: no"`,
    // (The proxy asked outright: the variables themselves send loopback straight, to the sandbox's own.)
    `curl -s -m 3 --noproxy '' -x "$HTTP_PROXY" http://127.0.0.1:${port}/by-proxy | head -1`,
    `curl -s -m 3 --noproxy '' -x "$HTTP_PROXY" http://localhost:${port}/by-name | head -1`,
    `curl -s -m 3 --noproxy '' -p -x "$HTTP_PROXY" http://127.0.0.1:${port}/by-tunnel || echo "tunnel: no"`,
    `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo "raw: yes" || echo "raw: no"`,
    `grep -c ":$(printf '%04X' ${port}) " /proc/net/tcp 2>/dev/null | sed 's/^/listed in proc: /'`,
  ].join("; ");
  for (const sandbox of ["workspace-write", "read-only"] as const) {
    const on = await run(routes, { sandbox, network: true });
    expect(on).toContain("direct: no");
    expect(on).toContain(`Keel's sandbox proxy refused 127.0.0.1:${port}: Keel's own API is never reachable from a sandbox.`);
    expect(on).toContain(`Keel's sandbox proxy refused localhost:${port}`);
    expect(on).toContain("tunnel: no");
    expect(on).toContain("raw: no");
    expect(on).toContain("listed in proc: 0");
    const off = await run(`echo "proxy=[$HTTP_PROXY]"; ${routes}`, { sandbox, network: false });
    expect(off).toContain("proxy=[]");
    expect(off).toContain("direct: no");
    expect(off).toContain("raw: no");
  }
  expect(hits.filter((h) => !/through-tunnel|plain/.test(h))).toEqual([]);
  // The command's own loopback is its own: a server it starts is reached there, straight.
  const own = await run(`python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 & for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -m 2 -o /dev/null -w "own server: %{http_code}\\n" http://127.0.0.1:8765/ && break; sleep 0.3; done`, { sandbox: "workspace-write", network: true });
  expect(own).toContain("own server: 200");
});

test("a command that went around the proxy, or was refused by it, is told how the sandbox's network works", () => {
  const at = { linked: false, network: true, escape: "ESCAPE." };
  expect(sandboxSaid("curl: (6) Could not resolve host: example.com", at)).toEqual([expect.stringMatching(/^This session's sandbox has a network of its own\. Public hosts are reached through Keel's proxy, .* localhost there is the sandbox's own: this machine's services are not on it\. ESCAPE\.$/)]);
  expect(sandboxSaid("psql: error: connection to server at \"localhost\" (127.0.0.1), port 5432 failed\ncurl: (7) Failed to connect to 127.0.0.1 port 5432", at)).toHaveLength(1);
  expect(sandboxSaid("ok", at)).toEqual([]);
  // A refusal of the proxy is named with its host; Keel's own API gets no way around.
  expect(sandboxSaid("x", { ...at, refused: () => [{ host: "10.0.0.5", port: 80, why: "it is an address on this machine or a private network" }] }))
    .toEqual(["This session's sandbox reaches the network only through Keel's proxy, which refused 10.0.0.5:80: an address on this machine or a private network is not reachable from a sandbox. Public hosts are. ESCAPE."]);
  const own = sandboxSaid("x", { ...at, refused: () => [{ host: "127.0.0.1", port: 47960, why: "Keel's own API is never reachable from a sandbox" }] });
  expect(own[0]).toContain("which refused 127.0.0.1:47960: Keel's own API is never reachable from a sandbox");
  expect(own[0]).not.toContain("ESCAPE");
  // With the network off the older sentence stands alone.
  expect(sandboxSaid("curl: (6) Could not resolve host: example.com", { ...at, network: false })).toEqual([expect.stringContaining("This session's network is off")]);
});

test("the rule's edges: other spellings of this machine, a name that points inside, the header and the request line, slow and long heads, bodies in pieces, a redirect", async () => {
  const port = standin.port!;
  ownPort(port);
  const before = hits.length;
  // The real resolver, for the spellings a resolver turns into an address.
  const sock = join(root, "c.sock");
  const server = startProxy(sock, { headMs: 300 });
  try {
    const connect = (to: string) => ask(sock, `CONNECT ${to} HTTP/1.1\r\nHost: ${to}\r\n\r\n`);
    const get = (url: string, more = "") => ask(sock, `GET ${url} HTTP/1.1\r\n${more}\r\n`);
    // IPv6 loopback in its forms, IPv4 inside IPv6, decimal, octal, hexadecimal and short IPv4, localhost with a dot and
    // its subdomains, this machine's own name: none reaches the stand-in (refused, or no such name).
    const spellings = ["[::1]", "[0:0:0:0:0:0:0:1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "2130706433", "0x7f.1", "0x7f000001", "127.1", "0177.0.0.1", "017700000001", "localhost", "localhost.", "app.localhost", "LOCALHOST", hostname(), "0.0.0.0", "0"];
    for (const h of spellings) {
      for (const r of [await connect(`${h}:${port}`), await get(`http://${h}:${port}/edge`)]) expect([h, r.split("\r\n")[0]]).toEqual([h, expect.stringMatching(/^HTTP\/1\.1 (403|502|400) /)]);
    }
    // This machine's address on a network (a LAN's, a VPN's, a tailnet's): its own, whatever the range.
    const lan = Object.values(networkInterfaces()).flat().find((a) => a && !a.internal && a.family === "IPv4")?.address;
    if (lan) expect((await connect(`${lan}:${port}`)).split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden");
    expect(hits.length).toBe(before);
    // A head that does not end is not waited for; one that is too long is refused.
    expect(await ask(sock, "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n")).toBe("");
    expect(await ask(sock, `GET http://x/${"a".repeat(1_000_000)} HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 431 ");
  } finally {
    server.close();
  }
  // Carried (a rule that lets the stand-in's port through, as a listed host will): what the server is told, and bodies in pieces.
  const names: Record<string, string[]> = { "chain.example": ["127.0.0.1"], "six.example": ["::1"] };
  const only: Policy = (_h, _a, p) => (p === port ? { allow: true } : { allow: false, why: "it is not listed" });
  const sock2 = join(root, "d.sock");
  const carried = startProxy(sock2, { policy: () => only, resolve: async (h) => names[h] ?? [h] });
  try {
    // The server is told the host of the request line, not the header's; a request with no Host header gets one.
    expect(await ask(sock2, `GET http://127.0.0.1:${port}/host HTTP/1.1\r\nHost: other.example\r\n\r\n`)).toContain(`standin saw GET /host host=127.0.0.1:${port} `);
    expect(await ask(sock2, `GET http://127.0.0.1:${port}/old HTTP/1.0\r\n\r\n`)).toContain(`standin saw GET /old host=127.0.0.1:${port} `);
    // A name is resolved once, through its chain, and the address that was judged is the one connected to.
    expect(await ask(sock2, `GET http://chain.example:${port}/by-name HTTP/1.1\r\n\r\n`)).toContain(`standin saw GET /by-name host=chain.example:${port} `);
    // A body sent in pieces, and an answer in pieces.
    const chunked = await ask(sock2, `POST http://127.0.0.1:${port}/chunked HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n`);
    expect(chunked).toContain("body=abcde");
    expect(await ask(sock2, `GET http://127.0.0.1:${port}/pieces HTTP/1.1\r\n\r\n`)).toMatch(/one .*two .*three/s);
    // A tunnel carries any bytes (the proxy does not read them).
    const raw = await ask(sock2, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`, "\x00\x01 not http at all\r\n\r\n");
    expect(raw).toStartWith("HTTP/1.1 200 Connection Established");
    // A redirect is the client's: its next request comes back to the proxy and is judged again.
    const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("the other service\n") });
    try {
      mkdirSync(join(root, "relay"), { recursive: true });
      writeFileSync(join(root, "relay/relay.js"), RELAY_JS);
      const relay = Bun.spawn([process.execPath, join(root, "relay/relay.js"), "listen", sock2], { stdout: "pipe", env: { ...process.env, BUN_BE_BUN: "1" } as Record<string, string> });
      const relayPort = Number((await relay.stdout.getReader().read().then((r) => new TextDecoder().decode(r.value))).trim());
      const curl = Bun.spawn(["curl", "-s", "-L", "--noproxy", "", "-x", `http://127.0.0.1:${relayPort}`, `http://127.0.0.1:${port}/redirect/${other.port}`], { stdout: "pipe", stderr: "pipe" });
      const out = await new Response(curl.stdout).text();
      await curl.exited;
      relay.kill();
      expect(out).toContain(`Keel's sandbox proxy refused 127.0.0.1:${other.port}: it is not listed.`);
      expect(out).not.toContain("the other service");
    } finally {
      other.stop(true);
    }
  } finally {
    carried.close();
  }
  // No more than its share of connections at once: one past it is refused, and said.
  const sock3 = join(root, "e.sock");
  const small = startProxy(sock3, { policy: () => only, max: 2 });
  try {
    const held = [1, 2].map(() => createConnection(sock3));
    for (const h of held) h.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`);
    await Bun.sleep(100);
    expect(await ask(sock3, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`)).toStartWith("HTTP/1.1 503 ");
    for (const h of held) h.destroy();
    await Bun.sleep(50);
    expect(await ask(sock3, `GET http://127.0.0.1:${port}/after HTTP/1.1\r\n\r\n`)).toContain("standin saw GET /after");
  } finally {
    small.close();
  }
  // The default rule on addresses that are public: IPv6 too.
  expect(publicOnly("example.com", "2606:4700:4700::1111", 443)).toEqual({ allow: true });
  expect(publicOnly("six.example", "::1", 443)).toEqual({ allow: false, why: "it is an address on this machine or a private network" });
});

test.skipIf(!sandboxStatus().available || !Bun.which("nsenter"))("the owner's portal reaches a server a sandboxed command runs, on the sandbox's own loopback", async () => {
  const ws = join(root, "ws-portal");
  mkdirSync(ws, { recursive: true });
  const sid = `portal-test-${Date.now()}`;
  // A dev server inside a sandbox: on its own 127.0.0.1, which is not this machine's.
  const p = Bun.spawn(confine(["bash", "-c", "echo hello-from-inside > index.html; exec python3 -m http.server 8765 --bind 127.0.0.1"], { sandbox: "workspace-write", network: false }, ws), { cwd: ws, stdout: "ignore", stderr: "ignore", env: { ...process.env, KEEL_SESSION: sid } as Record<string, string> });
  try {
    let at: { port: number; pid: number; ns?: string } | undefined;
    for (let i = 0; i < 50 && !at; i++) { await Bun.sleep(100); forgetOwnership(); at = sessionPorts().get(sid)?.find((x) => x.port === 8765); }
    expect(at?.ns).toMatch(/^net:\[\d+\]$/);
    // Straight from here there is nothing on that port; through the namespace there is.
    expect(await fetch("http://127.0.0.1:8765/index.html").then((r) => r.status, () => 0)).not.toBe(200);
    const local = await reachInto(scopeDir(sandboxScope(ws)), at!.pid, at!.port, at!.ns!);
    expect(await (await fetch(`http://127.0.0.1:${local}/index.html`)).text()).toBe("hello-from-inside\n");
    // The same reach is used again for the next request.
    expect(await reachInto(scopeDir(sandboxScope(ws)), at!.pid, at!.port, at!.ns!)).toBe(local);
  } finally {
    p.kill();
    await p.exited;
  }
}, 30_000);
