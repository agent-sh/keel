// The helper an ssh machine runs for sessions whose tools run there: the hands
// of src/fleet/hands-routes.ts on a unix socket in a directory only its user
// can open (no port, no key), reached through the daemon's ssh connection.
// It holds the sessions' jobs, so it is started detached and outlives a
// dropped link; it ends after a day without a request and with nothing
// running (the daemon starts it again at the next call, in about a second).
//   bun hands.js --dir RUN_DIR --spill SPILL_DIR --version V
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { instructionFiles } from "../engine/turn.ts";
import { jobPids } from "../tools/jobs.ts";
import { handsBusy, handsRoutes } from "./hands-routes.ts";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const dir = arg("--dir");
const spill = arg("--spill");
const HANDS_VERSION = arg("--version") ?? "?";
if (!dir || !spill) { console.error("usage: hands.js --dir RUN_DIR --spill SPILL_DIR --version V"); process.exit(2); }
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const sock = join(dir, "hands.sock");
const IDLE_MS = 24 * 3600_000;

// Another helper already answers there: this one is not needed.
try {
  const r = await fetch("http://h/ping", { unix: sock, signal: AbortSignal.timeout(2000) });
  if (r.ok) process.exit(0);
} catch {}
rmSync(sock, { force: true });

let last = Date.now();
const routes = handsRoutes({
  spillRoot: spill,
  capture: (e, ctx) => { console.error(new Date().toISOString(), ctx, e); return { message: (e as Error)?.message ?? String(e) }; },
  instructions: instructionFiles,
});
const server = Bun.serve({
  unix: sock,
  async fetch(req) {
    last = Date.now();
    const path = new URL(req.url).pathname;
    if (path === "/ping") return Response.json({ version: HANDS_VERSION, pid: process.pid });
    const h = (routes as Record<string, Record<string, (r: Request) => Promise<Response>>>)[path]?.[req.method];
    return h ? h(req) : Response.json({ error: `no ${req.method} ${path} here` }, { status: 404 });
  },
});
chmodSync(sock, 0o600);
writeFileSync(join(dir, "hands.pid"), String(process.pid));
setInterval(() => {
  if (Date.now() - last > IDLE_MS && !handsBusy() && !jobPids().length) { server.stop(true); rmSync(sock, { force: true }); process.exit(0); }
}, 60_000);
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { rmSync(sock, { force: true }); process.exit(0); });
console.error(`${new Date().toISOString()} keel hands ${HANDS_VERSION} on ${sock} (pid ${process.pid})`);
