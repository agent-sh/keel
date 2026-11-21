// The second daemon the fleet specs pair with. It must be another daemon: a
// KEEL_PEER_URL that reaches this one (a lane whose own daemon sits on the
// default peer port), or a daemon started on a copy of this one's state, has
// the same daemon id, and a daemon is never paired with itself.
import type { APIRequestContext } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";
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
