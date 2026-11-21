// The second daemon the fleet specs pair with. It must be another daemon: a
// KEEL_PEER_URL that reaches this one (a lane whose own daemon sits on the
// default peer port), or a daemon started on a copy of this one's state, has
// the same daemon id, and a daemon is never paired with itself.
import type { APIRequestContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export async function peerProblem(request: APIRequestContext, peer: string): Promise<string | null> {
  const fix = "start a second daemon with a state of its own (scripts/dev.sh <another port>) and set KEEL_PEER_URL and KEEL_PEER_ROOT";
  const up = await request.get(`${peer}/api/health`, { timeout: 3000 }).then((r) => r.ok(), () => false);
  if (!up) return `no peer daemon at ${peer}: ${fix}`;
  const id = async (base: string) => (await (await request.get(`${base}/api/fleet/identity`, { timeout: 3000 })).json()).daemon_id as string;
  const [here, there] = await Promise.all([id(""), id(peer)]);
  if (here === there) return `the peer at ${peer} is this daemon, or one started on a copy of its state (both are ${here}): ${fix}`;
  return null;
}

// A stand-in for another machine's daemon that the spec can take offline and
// bring back: it pairs, proves its answers, says it is idle and holds a relay
// stream with no sessions. Nothing runs there.
export function standInDaemon(name: string) {
  const daemon_id = randomUUID(), key = randomUUID();
  let server: Server | undefined, port = 0;
  const open = () => new Promise<void>((resolve, reject) => {
    server = createServer((req, res) => {
      req.resume();
      res.setHeader("content-type", "application/json");
      const path = (req.url ?? "").split("?")[0];
      if (path === "/api/fleet/pair") return res.end(JSON.stringify({ daemon_id, key }));
      res.setHeader("x-keel-proof", createHmac("sha256", key).update(`${req.headers["x-keel-nonce"]}|${daemon_id}`).digest("hex"));
      if (path === "/api/fleet/identity") return res.end(JSON.stringify({ daemon_id, server_name: name, version: "stand-in" }));
      if (path === "/api/fleet/facts") return res.end(JSON.stringify({ hostname: name, os: "linux", arch: "x64", cpus: 8, load1: 0, mem_total_mb: 16000, tools: [], sandbox: false, keel_version: "stand-in" }));
      if (path === "/api/fleet/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ t: "snapshot", sessions: [] })}\n\n`);
        const ping = setInterval(() => res.write(": ping\n\n"), 5000);
        return void res.on("close", () => clearInterval(ping));
      }
      res.writeHead(404).end("{}");
    });
    server.once("error", reject).listen(port, "127.0.0.1", () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  const close = () => new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections(); });
  return { open, close, url: () => `http://127.0.0.1:${port}` };
}

// Another Keel with nothing in it, started for one spec and stopped by it: a
// state folder of its own under `dir`, scratch stores of the other harnesses
// (`dir`/stores), the stand-in provider.
export async function emptyKeel(dir: string): Promise<{ url: string; state: string; stop: () => Promise<void> }> {
  for (const d of ["state", "work", "config", "home", "stores"]) mkdirSync(join(dir, d), { recursive: true });
  const proc: ChildProcess = spawn("bun", ["src/main.ts", "serve", "--bind", "127.0.0.1:0", "--state-dir", join(dir, "state"), "--workspace", join(dir, "work")], {
    env: {
      ...process.env, KEEL_SCRIPTED_PROVIDER: "1", KEEL_DEFAULT_MODEL: "scripted:stand-in", KEEL_CONFIG_DIR: join(dir, "config"), KEEL_MCP_CONFIG: join(dir, "mcp.json"),
      KEEL_IMPORT_HOME: join(dir, "home"), KEEL_IMPORT_CLAUDE_DIR: join(dir, "stores/claude"), KEEL_IMPORT_CODEX_DIR: join(dir, "stores/codex"), KEEL_IMPORT_AGY_DIR: join(dir, "stores/agy"),
      KEEL_IMPORT_KEEL_DB: join(dir, "stores/keel.db"), KEEL_IMPORT_HERMES_DIR: join(dir, "stores/hermes"), KEEL_DESKTOP_NOTIFY: "off", TACIT_BIN: resolve("test/e2e/fixtures/tacit-standin.sh"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const url = await new Promise<string>((done, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); done(m[1]!.replace(/\/$/, "")); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
  const stop = () => new Promise<void>((r) => { if (proc.exitCode !== null) return r(); proc.once("exit", () => r()); proc.kill("SIGTERM"); });
  return { url, state: join(dir, "state"), stop };
}

// A daemon of the spec's own on a scratch state, on the scripted stand-in: one
// a spec may kill and start again on the same port. It reads nothing of the
// owner's (its own config folder and stores, an empty ssh configuration), and
// it cannot reach a real model provider whatever the spec was started from:
// of the caller's environment it gets the path only, so no provider key; its
// home is its own, so no sign-in file; and it has no session bus, so no keyring.
// `more`: settings of the spec's own for that daemon (a shorter wait, a gap).
export function ownDaemon(state: string, port = 0, more: Record<string, string> = {}): Promise<{ proc: ChildProcess; url: string; port: number }> {
  for (const d of ["config", "home/run", "stores", "tmp"]) mkdirSync(join(state, d), { recursive: true });
  writeFileSync(join(state, "ssh_config"), "");
  const proc = spawn("bun", ["src/main.ts", "serve", "--bind", `127.0.0.1:${port}`, "--state-dir", state, "--workspace", state], {
    env: {
      PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? join(state, "tmp"), LANG: "C.UTF-8", HOME: join(state, "home"),
      KEEL_KEYRING_SERVICE: "keel-scratch-empty", DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/bus", XDG_RUNTIME_DIR: join(state, "home/run"), KEEL_CRED_GET: "/bin/false",
      KEEL_SCRIPTED_PROVIDER: "1", KEEL_DRAIN_MS: "300", KEEL_DEFAULT_MODEL: "scripted:stand-in", KEEL_SERVER_NAME: "desk", KEEL_CONFIG_DIR: join(state, "config"), KEEL_SSH_CONFIG: join(state, "ssh_config"), KEEL_DESKTOP_NOTIFY: "off",
      KEEL_MCP_CONFIG: join(state, "mcp.json"), KEEL_IMPORT_HOME: join(state, "home"), KEEL_IMPORT_CLAUDE_DIR: join(state, "stores/claude"), KEEL_IMPORT_CODEX_DIR: join(state, "stores/codex"), KEEL_IMPORT_AGY_DIR: join(state, "stores/agy"),
      KEEL_IMPORT_KEEL_DB: join(state, "stores/keel.db"), KEEL_IMPORT_HERMES_DIR: join(state, "stores/hermes"), TACIT_BIN: resolve("test/e2e/fixtures/tacit-standin.sh"),
      ...more,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((done, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`no listen line:\n${out}`)), 30_000);
    const on = (d: Buffer) => {
      out += d;
      const m = out.match(/keel listening on (http:\/\/\S+?)\/? /);
      if (m) { clearTimeout(t); const url = m[1]!.replace(/\/$/, ""); done({ proc, url, port: Number(new URL(url).port) }); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", on);
  });
}
// The environment of a command line run against such a daemon: the path and that daemon's own folders, nothing of the caller's.
export const ownEnv = (state: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "", TMPDIR: process.env.TMPDIR ?? join(state, "tmp"), LANG: "C.UTF-8", HOME: join(state, "home"),
  KEEL_KEYRING_SERVICE: "keel-scratch-empty", DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/bus", XDG_RUNTIME_DIR: join(state, "home/run"), KEEL_CRED_GET: "/bin/false",
  KEEL_CONFIG_DIR: join(state, "config"), KEEL_STATE_DIR: state,
});
export const exited = (p: ChildProcess) => new Promise<void>((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));

// The way to another daemon with a hand on it: every request goes through to
// `target` as it is, and the answer to the next one `hold` matches is kept
// back after the daemon there has done the work. What a daemon that goes down
// in the middle of a call leaves behind, at a step the spec names.
export function holdingProxy(target: string) {
  let server: Server | undefined, port = 0;
  let want: { match: (path: string, body: string) => boolean; held: () => void } | undefined;
  const open = () => new Promise<void>((resolve, reject) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        const body = Buffer.concat(chunks);
        const path = (req.url ?? "").split("?")[0]!;
        const holding = want?.match(path, body.toString("utf8")) ? want : undefined;
        if (holding) want = undefined;
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([k, v]) => typeof v === "string" && !["host", "connection", "content-length"].includes(k))) as Record<string, string>;
        const gone = new AbortController();
        res.on("close", () => gone.abort());
        try {
          const up = await fetch(`${target}${req.url}`, { method: req.method, headers, body: body.length ? body : undefined, signal: holding ? undefined : gone.signal });
          if (holding) { await up.arrayBuffer(); return holding.held(); }
          const out: Record<string, string> = {};
          up.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(k)) out[k] = v; });
          res.writeHead(up.status, out);
          for await (const c of up.body ?? []) res.write(c);
          res.end();
        } catch {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        }
      });
    });
    server.once("error", reject).listen(0, "127.0.0.1", () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  const hold = (match: (path: string, body: string) => boolean) => new Promise<void>((held) => { want = { match, held }; });
  const close = () => new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections(); });
  return { open, close, hold, url: () => `http://127.0.0.1:${port}` };
}
