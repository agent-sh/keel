// A run of an agent's end with real commands, for leftovers.test.ts: started as a process of its own so its
// commands run with the containment its environment gives (a cgroup scope where the user manager is reachable,
// else the process group and session), and so the jobs it starts are not in the test process's table.
// argv: a scratch folder, how many other commands to run first (to pass the jobs kept after they end).
// Prints one JSON line: the containment, the report's line, which jobs were still held, what still runs.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
// Digits (a sleep takes it as its fraction), random and long, and found only as a whole number: a pid alone is a
// substring of many a long number in another process's command line (a browser's), which `ours` then counted and
// the test's sweep then killed.
const tag = "9" + Array.from(crypto.getRandomValues(new Uint8Array(15)), (b) => b % 10).join("");
const named = new RegExp(`(?<![0-9])${tag}(?![0-9])`);
writeFileSync(join(root, "server.ts"), `Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch: () => new Response("x") }); setInterval(() => {}, 1 << 30);`);
// The client says when it is connected (a file), so the run goes on at that signal and not after a fixed time.
const ready = join(root, "client.ready");
writeFileSync(join(root, "client.ts"), `import { writeFileSync } from "node:fs"; await Bun.connect({ hostname: "127.0.0.1", port: ${port}, socket: { data() {} } }); writeFileSync(${JSON.stringify(ready)}, "x"); setInterval(() => {}, 1 << 30);`);
// What runs of this run's commands, by the words only they carry.
const ours = () => readdirSync("/proc").filter((n) => /^\d+$/.test(n)).flatMap((n) => {
  try { const c = readFileSync(`/proc/${n}/cmdline`, "utf8").replaceAll("\0", " "); return named.test(c) && !c.includes("leftovers-run") && !c.startsWith("bash -c") ? [c.trim()] : []; } catch { return []; }
});
const bun = process.execPath;
const start = (sessionId: string, command: string, background = true, description?: string) => startJob({ sessionId, command, description, cwd: ws, logDir: join(root, "jobs", sessionId), background });
const jobs = [
  start(agent.id, `sleep 600.${tag} & echo started`),
  start(agent.id, `setsid sh -c 'sleep 601.${tag} & exit 0' & sleep 0.2; echo done`),
  start(agent.id, `exec ${bun} ${join(root, "server.ts")} ${tag}`, true, "the agent's server"),
];
// A step waits for the thing it needs (at most 60 s), never for a fixed time: each command starts when the user
// manager has made its scope, which waits on the machine's load.
const until = async (what: string, ok: () => boolean) => {
  for (const end = Date.now() + 60_000; !ok(); await Bun.sleep(25)) if (Date.now() > end) throw new Error(`${what} did not come up`);
};
const listening = () => new Promise<boolean>((ok) => { const c = connect(port, "127.0.0.1"); c.once("connect", () => { c.destroy(); ok(true); }); c.once("error", () => ok(false)); });
for (const end = Date.now() + 60_000; !(await listening()); await Bun.sleep(50)) if (Date.now() > end) throw new Error("the server did not listen");
jobs.push(start(agent.id, `exec ${bun} ${join(root, "client.ts")} ${tag}`));
const has = (word: string) => ours().some((c) => c.includes(word));
await until("the commands", () => has(`sleep 600.${tag}`) && has(`sleep 601.${tag}`) && has("server.ts") && has("client.ts") && existsSync(ready));
for (let k = 0; k < others; k += 20) {
  const batch = Array.from({ length: Math.min(20, others - k) }, () => start(other.id, "true", false));
  await Promise.all(batch.map((j) => j.exited));
}
if (others) await Bun.sleep(300);
const ids = new Set(jobsOf(agent.id).map((j) => j.id));
const held = jobs.map((j) => ids.has(j.id));
const before = ours();
// A unit its commands start (named only: the `systemd-run` after `||` never runs).
await start(agent.id, `true || systemd-run --user --unit=keel-left-${tag} true`, false).exited;
const line = await leftovers.settle({ store, isRunning: () => false }, { id: `ag-${tag}`, session_id: agent.id, parent_id: "p", created: Date.now() - 60_000 });
await until("the stop", () => !ours().length).catch(() => {});
const after = ours();
for (const j of jobs) await stopJob(j, "the run's own cleanup");
console.log(JSON.stringify({ contain: jobs[0]!.contain, line, held, before, after, port, tag }));
process.exit(0);
