// An agent and the background commands it starts, with a stand-in engine and real commands:
// what its parent is told while one runs, and what a stop of either does.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { lineage } from "../core/tree.ts";
import { allHooks } from "../engine/hooks.ts";
import { toolRoutes } from "../server/routes/tools.ts";
import * as jobs from "../tools/jobs.ts";
import * as activity from "./activity.ts";
import * as agents from "./agents.ts";
import * as leftovers from "./leftovers.ts";
import { setDeps } from "./core.ts";
import * as waits from "./waits.ts";

setDefaultTimeout(30_000);

// Process-wide: the turn hooks and the job callbacks the routes set are put back when the file is done.
const hooksAtStart = allHooks().length;
const told = { tell: jobs.jobEnded.tell, read: jobs.jobEnded.read, changed: jobs.jobsChanged.tell };
const started: jobs.Job[] = [];
afterAll(async () => {
  for (const j of started) if (jobs.running(j)) await jobs.stopJob(j, "was stopped by the test");
  allHooks().length = hooksAtStart;
  jobs.jobEnded.tell = told.tell; jobs.jobEnded.read = told.read; jobs.jobsChanged.tell = told.changed;
});

const dir = mkdtempSync(join(tmpdir(), "keel-agent-commands-"));
const store = new Store(join(dir, "state"));
const busy = new Set<string>();
const sends: { id: string; text: string }[] = [];
const held = new Set<string>();
const failures: unknown[] = [];
const engine = {
  isRunning: (id: string) => busy.has(id),
  isHeld: (id: string) => held.has(id),
  send: (id: string, text: string, o: any) => (sends.push({ id, text }), { event: store.append(id, "user", { text, ...o?.meta }) }),
  message: (id: string, text: string, meta: any) => (sends.push({ id, text }), { event: store.append(id, "user", { text, ...meta }) }),
  heldBy: (id: string) => (held.has(id) ? "owner" : undefined),
  holdQueue: (id: string) => { held.add(id); },
  releaseHold: (id: string) => { held.delete(id); return true; },
  hasInput: (id: string, key: string) => !!store.db.query("SELECT 1 FROM input_keys WHERE session_id = ? AND key = ?").get(id, key),
  interrupt: async (id: string) => { busy.delete(id); agents.onTurnEnd(id, "interrupted"); },
  lineage: (id: string) => lineage(store.events(id), store.session(id)?.head ?? null),
  idle: async () => {},
  followUp: async () => undefined,
};
const deps: any = { store, bus: new Bus(), errors: { capture: (...a: unknown[]) => void failures.push(a) }, engine, providers: { models: async () => [], resolve: async () => ({ info: {} }), current: () => [] } };
setDeps(deps);
store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT"); // the fleet adds it in the daemon
store.migrate("CREATE TABLE IF NOT EXISTS input_keys (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, key TEXT NOT NULL, ts INTEGER NOT NULL, fp TEXT, PRIMARY KEY (session_id, key)) WITHOUT ROWID"); // the engine's
agents.migrate();
waits.migrate();
activity.migrate();
leftovers.migrate(store);
toolRoutes(deps);

const to = (id: string) => sends.filter((s) => s.id === id).map((s) => s.text);
const parentOf = (title: string) => {
  const p = store.createSession({ model: "m:x", workspace: dir, title });
  store.append(p.id, "assistant", { blocks: [] });
  return p;
};
const spawn = (parentId: string) => agents.spawn(parentId, { prompt: "do it", isolation: "none", background: true });
const end = (a: { session_id: string }, reason: string, text: string, extra: Record<string, unknown> = {}) => {
  store.append(a.session_id, "assistant", { blocks: [{ type: "text", text }] });
  store.append(a.session_id, "turn_end", { reason, ...extra });
  agents.onTurnEnd(a.session_id, reason);
};
const bg = (sessionId: string, command: string, description?: string) => {
  const j = jobs.startJob({ sessionId, command, description, cwd: dir, logDir: join(dir, "spill", sessionId, "jobs"), background: true });
  started.push(j);
  return j;
};
// Until `f` holds, for at most `ms`.
const until = async (f: () => boolean, ms = 10_000) => { for (const end = Date.now() + ms; !f() && Date.now() < end; ) await Bun.sleep(25); return f(); };
// A server that says its port once it listens.
const SERVER = `${process.execPath} -e 'console.log("port", Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("up") }).port); setInterval(() => {}, 1000)'`;

test("an agent that leaves a server listening reports; one with a run to come waits on it and its parent is woken once", async () => {
  const p = parentOf("server");
  const a = await spawn(p.id);
  const srv = bg(a.session_id, SERVER, "dev server");
  expect(await until(() => /port \d+/.test(readFileSync(srv.log, "utf8")))).toBe(true);
  end(a, "end_turn", "The dev server is up. Done.");
  expect(await until(() => agents.get(a.id)!.status === "completed", 15_000)).toBe(true);
  expect(await until(() => to(p.id).some((t) => t.includes("The dev server is up. Done.")), 3000)).toBe(true);
  // Seen as a server, it was never a park: the parent was told nothing else.
  expect(to(p.id).filter((t) => t.includes("is waiting for"))).toEqual([]);

  // A run with a result to come: the agent waits on it, and its parent is woken for that once in the task.
  const q = parentOf("run");
  const b = await spawn(q.id);
  const run = bg(b.session_id, "sleep 30", "slow tests");
  end(b, "end_turn", "Started the tests.");
  expect(agents.get(b.id)!.status).toBe("waiting");
  expect(await until(() => to(q.id).length === 1, 3000)).toBe(true);
  expect(to(q.id)[0]).toContain(`(${b.id}) is waiting for background command ${run.id} (slow tests)`);
  // It goes on and parks again on the same command: that park rides the parent's next input.
  agents.onTurnStart(b.session_id);
  end(b, "end_turn", "Still running.");
  await Bun.sleep(400);
  expect(to(q.id)).toHaveLength(1);
  await jobs.stopJob(run, "was stopped by the test");
});

test("the owner's Stop of an agent's turn stops the agent, though a command it started runs", async () => {
  const p = parentOf("owner stop");
  const a = await spawn(p.id);
  bg(a.session_id, "sleep 30", "long build");
  end(a, "interrupted", "partial", { stopped_by: "owner" });
  expect(await until(() => agents.get(a.id)!.status === "stopped", 3000)).toBe(true);
  expect(await until(() => to(p.id).some((t) => t.includes("partial")), 3000)).toBe(true);
});

test("a stop of the command an agent waits on gives the agent its turn", async () => {
  const p = parentOf("command stop");
  const a = await spawn(p.id);
  const j = bg(a.session_id, "sleep 30", "test run");
  end(a, "end_turn", "Started the tests; I will report when they finish.");
  expect(agents.get(a.id)!.status).toBe("waiting");
  const before = to(a.session_id).length;
  await jobs.stopJob(j, "was stopped by the owner");
  expect(await until(() => to(a.session_id).length > before, 3000)).toBe(true);
  expect(to(a.session_id).at(-1)).toContain(`(ID ${j.id}) was stopped by the owner`);
});

test("a command a restart took back from in front of a call is no wait of the agent", async () => {
  const p = parentOf("front");
  const a = await spawn(p.id);
  const j = bg(a.session_id, "sleep 30", "in front");
  j.front = true;
  expect(agents.waitsOn(agents.get(a.id)!)).toBe("");
  await jobs.stopJob(j, "was stopped by the test");
});

test("command ends a moment apart start one turn of an idle session", async () => {
  const s = store.createSession({ model: "m:x", workspace: dir, title: "two ends" });
  const before = to(s.id).length;
  bg(s.id, "sleep 0.3", "first");
  bg(s.id, "sleep 0.4", "second");
  expect(await until(() => to(s.id).length > before, 3000)).toBe(true);
  await Bun.sleep(500);
  expect(to(s.id).length - before).toBe(1);
  expect(to(s.id).at(-1)).toContain('"first"');
  expect(to(s.id).at(-1)).toContain('"second"');
  expect(failures).toEqual([]);
});

// Servers of other kinds, a server that comes up after the turn ended, and a run whose own server is up.
const UNIX = (path: string) => `${process.execPath} -e 'Bun.serve({ unix: ${JSON.stringify(path)}, fetch: () => new Response("up") }); console.log("up"); setInterval(() => {}, 1000)'`;
const UDP = `${process.execPath} -e 'await Bun.udpSocket({ port: 0, hostname: "127.0.0.1" }); console.log("up"); setInterval(() => {}, 1000)'`;

test("a server on a unix socket or a UDP port, or one that binds after the turn ended, ends its agent's wait", async () => {
  const cases = [
    { title: "unix", command: UNIX(join(dir, "dev.sock")) },
    { title: "udp", command: UDP },
    { title: "late", command: `sleep 2; ${SERVER}` },
  ];
  const as = await Promise.all(cases.map(async (c) => {
    const p = parentOf(c.title);
    const a = await spawn(p.id);
    bg(a.session_id, c.command, `${c.title} server`);
    end(a, "end_turn", `The ${c.title} server is up. Done.`);
    return { p, a };
  }));
  for (const { p, a } of as) {
    expect(await until(() => agents.get(a.id)!.status === "completed", 20_000)).toBe(true);
    expect(await until(() => to(p.id).some((t) => t.includes("server is up. Done.")), 3000)).toBe(true);
  }
});

test("a run whose own server is up when the turn ends is waited on, and its end reaches the agent", async () => {
  const p = parentOf("tests with a server");
  const a = await spawn(p.id);
  const j = bg(a.session_id, `${SERVER} & sleep 3; kill %1; echo tests-passed`, "tests");
  expect(await until(() => /port \d+/.test(readFileSync(j.log, "utf8")))).toBe(true);
  end(a, "end_turn", "Tests started.");
  const before = to(a.session_id).length;
  expect(await until(() => to(a.session_id).length > before, 10_000)).toBe(true);
  expect(agents.get(a.id)!.status).toBe("waiting");
  expect(j.exitCode).toBe(0);
  expect(to(a.session_id).at(-1)).toContain(j.id);
  // Its parent was told of no server's end and no report: the agent reads the result first.
  expect(to(p.id).some((t) => t.includes("Tests started."))).toBe(false);
});

test("a run that keeps a processor busy beside its server is not taken for a server", async () => {
  const p = parentOf("busy run");
  const a = await spawn(p.id);
  const busyLoop = `nice -n 15 ${process.execPath} -e 'const t = Date.now() + 14000; while (Date.now() < t) {}'`;
  const j = bg(a.session_id, `${SERVER} & ${busyLoop}; kill %1`, "integration run");
  expect(await until(() => /port \d+/.test(readFileSync(j.log, "utf8")))).toBe(true);
  end(a, "end_turn", "Running.");
  await Bun.sleep(jobs.SERVE_HOLD_MS + 2 * agents.PARK_LOOK_MS);
  expect(jobs.running(j)).toBe(true);
  expect(agents.get(a.id)!.status).toBe("waiting");
  await jobs.stopJob(j, "was stopped by the test");
});

test("the sockets that serve are read from the /proc/net tables", () => {
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0",
    "   1: 0100007F:A1B2 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 222 1 0",
  ].join("\n");
  expect([...jobs.servingInodes("tcp", tcp)]).toEqual(["111"]);
  const udp = [
    "   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops",
    "  10: 0100007F:14E9 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 333 2 0 0",
    "  11: 0100007F:C350 0100007F:0035 01 00000000:00000000 00:00000000 00000000  1000        0 444 2 0 0",
  ].join("\n");
  expect([...jobs.servingInodes("udp", udp)]).toEqual(["333"]);
  const unix = [
    "Num       RefCount Protocol Flags    Type St Inode Path",
    "0000000000000000: 00000002 00000000 00010000 0001 01 555 /run/dev.sock",
    "0000000000000000: 00000003 00000000 00000000 0001 03 666 /run/dev.sock",
  ].join("\n");
  expect([...jobs.servingInodes("unix", unix)]).toEqual(["555"]);
});

test("a listener serves once it held with the job idle; a busy run starts the hold again", () => {
  let s = jobs.nextServe(undefined, { at: 0, listens: true, cpu: 0 });
  s = jobs.nextServe(s, { at: jobs.SERVE_HOLD_MS, listens: true, cpu: 50 });
  expect(s).toEqual({ from: 0, cpu: 0, at: jobs.SERVE_HOLD_MS });
  expect(jobs.nextServe(s, { at: jobs.SERVE_HOLD_MS + 1000, listens: true, cpu: jobs.SERVE_HOLD_MS })).toEqual({ from: jobs.SERVE_HOLD_MS + 1000, cpu: jobs.SERVE_HOLD_MS, at: jobs.SERVE_HOLD_MS + 1000 });
  expect(jobs.nextServe(s, { at: jobs.SERVE_HOLD_MS + 1000, listens: false, cpu: 0 })).toBeUndefined();
});
