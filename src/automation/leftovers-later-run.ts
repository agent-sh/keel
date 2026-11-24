// A run for leftovers.test.ts: an agent's server that another process is connected to is kept at the agent's
// end, and looked at again by the one-minute pass (scopes.looseOnes): kept while the connection lasts,
// stopped once it is gone. Started as a process of its own so its commands have the containment its
// environment gives. argv: a scratch folder. Prints one JSON line.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { jobsOf, startJob, stopJob } from "../tools/jobs.ts";
import * as leftovers from "./leftovers.ts";
import * as scopes from "./scopes.ts";

const root = process.argv[2]!;
const ws = join(root, "ws");
mkdirSync(ws, { recursive: true });
const store = new Store(join(root, "state"));
if (!store.columnExists("sessions", "machine")) store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
leftovers.migrate(store);
const agent = store.createSession({ workspace: ws, title: "agent", model: "scripted:stand-in" });
const port = await new Promise<number>((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
const tag = "9" + Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => b % 10).join("");
writeFileSync(join(root, "server.ts"), `Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch: () => new Response("x") }); setInterval(() => {}, 1 << 30);`);
writeFileSync(join(root, "client.ts"), `await Bun.connect({ hostname: "127.0.0.1", port: ${port}, socket: { open(s) { s.write("GET / HTTP/1.1\\r\\nHost: x\\r\\n"); }, data() {} } }); await Bun.write(${JSON.stringify(join(root, "connected"))}, "1"); setInterval(() => {}, 1 << 30);`);
const job = startJob({ sessionId: agent.id, command: `exec ${process.execPath} ${join(root, "server.ts")} ${tag}`, description: "the agent's server", cwd: ws, logDir: join(root, "jobs"), background: true });
// (A probe that connects and lets go at once: a pooled connection of this process would be a client too.)
const up = async () => { for (let i = 0; i < 100; i++) { if (await new Promise<boolean>((ok) => { const c = connect(port, "127.0.0.1"); c.once("connect", () => { c.destroy(); ok(true); }); c.once("error", () => ok(false)); })) return; await Bun.sleep(50); } };
await up();
// Another process (not a command of the agent) is connected to the server, in the middle of a request (the
// kernel holds a connection that has sent nothing out of the server's sight).
const client = Bun.spawn([process.execPath, join(root, "client.ts"), tag], { stdout: "ignore", stderr: "ignore" });
for (let i = 0; i < 200 && !(await Bun.file(join(root, "connected")).exists()); i++) await Bun.sleep(50);
await Bun.sleep(100);
const alive = (pid: number) => { try { const st = readFileSync(`/proc/${pid}/stat`, "utf8"); return !/^[ZX]$/.test(st.slice(st.lastIndexOf(") ") + 2).split(" ")[0] ?? ""); } catch { return false; } };
const line = await leftovers.settle({ store, isRunning: () => false }, { id: `ag-${tag}`, session_id: agent.id, parent_id: "p", created: Date.now() - 60_000 });
const told: string[] = [];
const ctx: scopes.Ctx = {
  spillRoot: join(root, "spill"), endedOf: () => "its agent ended", keeps: () => new Set(), tell: (_s, l) => void told.push(l),
};
const pid = job.pid;
const keptAtEnd = alive(pid);
const withClient = await scopes.looseOnes(ctx);
const aliveWithClient = alive(pid);
client.kill("SIGKILL");
await client.exited;
await Bun.sleep(300);
// The first pass that finds no client waits (a client may come back within the minute); the next stops it.
const first = await scopes.looseOnes(ctx);
const aliveFirst = alive(pid);
const later = await scopes.looseOnes(ctx);
for (let i = 0; i < 60 && alive(pid); i++) await Bun.sleep(50);
const result = { contain: job.contain, line, keptAtEnd, withClient, aliveWithClient, first, aliveFirst, later, aliveAfter: alive(pid), told, tag, port, jobs: jobsOf(agent.id).length };
for (const j of jobsOf(agent.id)) await stopJob(j, "the run's own cleanup");
console.log(JSON.stringify(result));
process.exit(0);
