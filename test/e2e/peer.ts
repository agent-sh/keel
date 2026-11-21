// The second daemon the fleet specs pair with. It must be another daemon: a
// KEEL_PEER_URL that reaches this one (a lane whose own daemon sits on the
// default peer port), or a daemon started on a copy of this one's state, has
// the same daemon id, and a daemon is never paired with itself.
import type { APIRequestContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
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
