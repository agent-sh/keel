// Daemons' lives over a state folder, for scopes.test.ts, each a process of its own (the jobs table is per
// process, as it is per daemon, and so are the idle marks a pass keeps in memory).
//   a ROOT TAG MODE: the first daemon starts a command in its job scope that leaves a process there and
//     ends, says "ready" with the job's record and waits to be killed. MODE:
//       gone: the command is an agent's; its session is then deleted, and 210 more commands run after it
//         (so its record is past the newest ones a start keeps).
//       archived: its session is then archived.
//       build: what it leaves is a stand-in for a Gradle daemon listening on a port; its session lives.
//       old: as an older build's job: what it leaves carries no state folder's id, nor does its record; its
//         session lives.
//   b ROOT NOW [TAG]: a later daemon takes the jobs back as a start does and makes one pass over the job scopes at
//     the clock NOW, with the idle marks and told lines kept in the store. Prints one JSON line: the scopes it
//     lists as not its jobs (`foreign`), and the records it would have said once (`said`). With TAG, the owner
//     then stops the listed scope that holds a process named by TAG (`stop`), and what is listed after.
//   c ROOT NOW0 NOW1 PORT: a later daemon decides at NOW0 and NOW1 without acting, then a client connects to
//     PORT and the decision is acted on; then once more with the client gone. Prints one JSON line.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { adoptJobs, allJobs, jobLive, startJob } from "../tools/jobs.ts";
import * as leftovers from "./leftovers.ts";
import * as scopes from "./scopes.ts";

const [phase, root] = [process.argv[2]!, process.argv[3]!];
const state = join(root, "state");
const store = new Store(state);
leftovers.migrate(store);
store.db.run("CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, parent_id TEXT, session_id TEXT, status TEXT, created INTEGER)");
const spill = join(state, "spill");

if (phase === "a") {
  const [tag, mode] = [process.argv[4]!, process.argv[5]!];
  const parent = store.createSession({ workspace: root, title: "parent", model: "scripted:stand-in" });
  const s = store.createSession({ workspace: root, title: "left", model: "scripted:stand-in" });
  if (mode === "gone") store.db.run("INSERT INTO agents VALUES ('ag-left', ?, ?, 'done', 1)", [parent.id, s.id]);
  const run = (sid: string, command: string) => startJob({ sessionId: sid, command, cwd: root, logDir: join(spill, sid, "jobs") });
  const left = mode === "build"
    ? `setsid python3 -c 'import socket,sys; s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(); open(sys.argv[1],"w").write(str(s.getsockname()[1])); held=[s.accept() for _ in iter(int, 1)]' ${join(root, "port")} org.gradle.launcher.daemon.bootstrap.GradleDaemon ${tag}`
    : mode === "old" ? `env -u KEEL_JOB_STATE setsid sleep 900.${tag}` : `setsid sleep 900.${tag}`;
  const j = run(s.id, `${left} < /dev/null > /dev/null 2>&1 & echo started`);
  await j.exited;
  const record = j.log.replace(/\.log$/, ".json");
  if (mode === "old") {
    await Bun.sleep(50);
    const { state_id: _, ...m } = JSON.parse(readFileSync(record, "utf8"));
    writeFileSync(record, JSON.stringify(m));
  }
  if (mode === "gone") store.db.run("DELETE FROM sessions WHERE id = ?", [s.id]);
  if (mode === "archived") store.db.query("UPDATE sessions SET archived = 1 WHERE id = ?").run(s.id);
  if (mode === "gone") for (let k = 0; k < 210; k += 30) await Promise.all(Array.from({ length: 30 }, () => run(parent.id, "true").exited));
  if (mode === "build") while (!(await Bun.file(join(root, "port")).exists())) await Bun.sleep(50);
  console.log(JSON.stringify({ ready: true, job: j.id, session: s.id, parent: parent.id, contain: j.contain, cgroup: j.cgroup, record }));
  setInterval(() => {}, 1 << 30);
} else {
  const refused: string[] = [];
  const said: string[] = [];
  adoptJobs(spill, (_f, why) => refused.push(why));
  const lines: string[] = [];
  const ctx: scopes.Ctx = {
    spillRoot: spill, endedOf: (sid) => leftovers.endedOf(store, sid), keeps: () => leftovers.keeps(store),
    tell: (sid, line, key) => void leftovers.tellLeft(store, sid, line, key, (to, l) => lines.push(`${to}: ${l}`)),
    refused: (_f, why, scope) => { refused.push(why); if (leftovers.foreignFirst(store, scope.cgroup, scope.mark, why)) said.push(scope.cgroup); }, loadIdle: () => leftovers.loadIdle(store), saveIdle: (m) => leftovers.saveIdle(store, m),
  };
  const alive = (pid: number) => { try { const st = readFileSync(`/proc/${pid}/stat`, "utf8"); return !/^[ZX]$/.test(st.slice(st.lastIndexOf(") ") + 2).split(" ")[0] ?? ""); } catch { return false; } };
  const lingering = () => allJobs().filter((j) => j.cgroup && j.ended !== undefined && jobLive(j)).map((j) => j.id);
  if (phase === "b") {
    const d = await scopes.pass(ctx, { now: Number(process.argv[4]) });
    const foreign = await scopes.foreignScopes();
    const tag = process.argv[5];
    const mine = tag ? foreign.find((f) => f.commands.some((c) => c.includes(tag))) : undefined;
    const stop = mine ? await scopes.stopForeign(mine.cgroup, { marks: mine.marks }) : undefined;
    console.log(JSON.stringify({ taken: lingering(), views: d.map((x) => ({ job: x.job.id, memory: x.view.memory_bytes, fate: x.view.fate })), held: scopes.heldNow(), lines, refused, said, foreign, stop, after: stop ? (await scopes.foreignScopes()).map((f) => f.cgroup) : undefined }));
  } else {
    const [now0, now1, port] = process.argv.slice(4).map(Number) as [number, number, number];
    await scopes.pass(ctx, { now: now0, dry: true });
    const d = (await scopes.pass(ctx, { now: now1, dry: true }))[0]!;
    const sock = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    await Bun.sleep(200); // taken by the server
    await scopes.act(ctx, d);
    const withClient = { lines: [...lines], alive: d.view.builds.every((b) => alive(b.pid)) };
    sock.end();
    await Bun.sleep(200);
    await scopes.act(ctx, d);
    const after = { lines: [...lines], alive: d.view.builds.some((b) => alive(b.pid)) };
    console.log(JSON.stringify({ fate: d.view.fate, withClient, after }));
  }
  process.exit(0);
}
