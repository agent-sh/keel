// A run of an agent's end with real commands, for leftovers.test.ts: started as a process of its own so its
// commands run with the containment its environment gives (a cgroup scope where the user manager is reachable,
// else the process group and session), and so the jobs it starts are not in the test process's table.
// argv: a scratch folder, how many other commands to run first (to pass the jobs kept after they end).
// Prints one JSON line: the containment, the report's line, which jobs were still held, what still runs.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { jobsOf, startJob, stopJob } from "../tools/jobs.ts";
import * as leftovers from "./leftovers.ts";

const [root, others] = [process.argv[2]!, Number(process.argv[3] ?? 0)];
const ws = join(root, "ws");
mkdirSync(ws, { recursive: true });
const store = new Store(join(root, "state"));
if (!store.columnExists("sessions", "machine")) store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
leftovers.migrate(store);
const agent = store.createSession({ workspace: ws, title: "agent", model: "scripted:stand-in" });
const other = store.createSession({ workspace: ws, title: "other", model: "scripted:stand-in" });
const port = await new Promise<number>((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
const tag = String(process.pid);
writeFileSync(join(root, "server.ts"), `Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch: () => new Response("x") }); setInterval(() => {}, 1 << 30);`);
writeFileSync(join(root, "client.ts"), `await Bun.connect({ hostname: "127.0.0.1", port: ${port}, socket: { data() {} } }); setInterval(() => {}, 1 << 30);`);
const bun = process.execPath;
const start = (sessionId: string, command: string, background = true, description?: string) => startJob({ sessionId, command, description, cwd: ws, logDir: join(root, "jobs", sessionId), background });
const jobs = [
  start(agent.id, `sleep 600.${tag} & echo started`),
  start(agent.id, `setsid sh -c 'sleep 601.${tag} & exit 0' & sleep 0.2; echo done`),
  start(agent.id, `exec ${bun} ${join(root, "server.ts")} ${tag}`, true, "the agent's server"),
];
for (let i = 0; i < 100; i++) { if (await new Promise<boolean>((ok) => { const c = connect(port, "127.0.0.1"); c.once("connect", () => { c.destroy(); ok(true); }); c.once("error", () => ok(false)); })) break; await Bun.sleep(50); }
jobs.push(start(agent.id, `exec ${bun} ${join(root, "client.ts")} ${tag}`));
await Bun.sleep(800);
for (let k = 0; k < others; k += 20) {
  const batch = Array.from({ length: Math.min(20, others - k) }, () => start(other.id, "true", false));
  await Promise.all(batch.map((j) => j.exited));
}
await Bun.sleep(300);
const ids = new Set(jobsOf(agent.id).map((j) => j.id));
const held = jobs.map((j) => ids.has(j.id));
// What runs of this run's commands, by the words only they carry.
const ours = () => readdirSync("/proc").filter((n) => /^\d+$/.test(n)).flatMap((n) => {
  try { const c = readFileSync(`/proc/${n}/cmdline`, "utf8").replaceAll("\0", " "); return c.includes(tag) && !c.includes("leftovers-run") && !c.startsWith("bash -c") ? [c.trim()] : []; } catch { return []; }
});
const before = ours();
// A unit its commands start (named only: the `systemd-run` after `||` never runs).
await start(agent.id, `true || systemd-run --user --unit=keel-left-${tag} true`, false).exited;
const line = await leftovers.settle({ store, isRunning: () => false }, { id: `ag-${tag}`, session_id: agent.id, parent_id: "p", created: Date.now() - 60_000 });
for (let i = 0; i < 60 && ours().length; i++) await Bun.sleep(50);
const after = ours();
for (const j of jobs) await stopJob(j, "the run's own cleanup");
console.log(JSON.stringify({ contain: jobs[0]!.contain, line, held, before, after, port, tag }));
process.exit(0);
