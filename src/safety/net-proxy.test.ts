// The sandbox's network: the proxy's rule on the address a name resolves to,
// its two ways in (CONNECT and a plain HTTP request), and a confined command
// that cannot reach this machine's loopback by any route while public hosts
// stay reachable through the proxy. The stand-in servers are on this
// machine's loopback: what a sandbox must never reach.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createConnection, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { internalAddress } from "../core/hosts.ts";
import { ownPort, publicOnly, startProxy, type Policy, type Refusal } from "./net-proxy.ts";
import { sandboxSaid } from "./refwatch.ts";
import { confine, sandboxStatus } from "./sandbox.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "keel-net-")));
// A server on the host's loopback that says who asked: the stand-in for Keel's own API and any local service.
const hits: string[] = [];
let standin: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  standin = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => { hits.push(`${req.method} ${new URL(req.url).pathname}`); return new Response(`standin saw ${req.method} ${new URL(req.url).pathname} host=${req.headers.get("host")} proxy=${req.headers.get("proxy-connection")}\n`); } });
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
    expect(plain).toContain(`standin saw POST /plain host=127.0.0.1:${port} proxy=null`);
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
