// The model's waits, agents and notices run with no card (they act only on what Keel keeps for the session),
// so what each refuses is the whole of its permission.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { setDeps } from "./core.ts";
import * as loops from "./loops.ts";
import * as waits from "./waits.ts";
import { automationTools } from "./tools.ts";

const store = new Store(mkdtempSync(join(tmpdir(), "keel-auto-")));
// The fleet's column, before the first read of a session (a read prepared before it would not see it).
if (!store.columnExists("sessions", "machine")) store.migrate("ALTER TABLE sessions ADD COLUMN machine TEXT");
setDeps({ store, bus: new Bus(), errors: { capture() {} } } as any);
loops.migrate();
waits.migrate();
const s = store.createSession({ model: "m", workspace: "/", title: "t" });
const ctx = { sessionId: s.id, cwd: "/", signal: new AbortController().signal, spillDir: "/", seen: new Map() };
const tool = (name: string) => automationTools.find((t) => t.name === name)!;
const text = (o: { content: unknown }) => String(o.content);

test("an http wait follows web fetch's address rules", async () => {
  const r = await tool("WaitFor").run({ kind: "http", url: "http://127.0.0.1:3000/health" }, ctx);
  expect(r.is_error).toBe(true);
  expect(text(r)).toContain("no process of this session listens on 3000 yet");
  const priv = await tool("WaitFor").run({ kind: "http", url: "http://10.0.0.5:3000/health" }, ctx);
  expect(text(priv)).toContain("local or private address");
});

test("a wait on a background command's output file that no command of the session has is refused", async () => {
  const spill = mkdtempSync(join(tmpdir(), "keel-spill-"));
  const own = { ...ctx, spillDir: spill };
  const r = await tool("WaitFor").run({ kind: "file", path: join(spill, "jobs", "b1made-up.log"), contains: "done" }, own);
  expect(r.is_error).toBe(true);
  expect(text(r)).toContain("wakes this session by itself when it ends: it needs no wait");
  expect(text(r)).toContain('plus ".exit"');
  mkdirSync(join(spill, "jobs"));
  writeFileSync(join(spill, "jobs", "b1real.log"), "");
  const real = await tool("WaitFor").run({ kind: "log", path: join(spill, "jobs", "b1real.log"), match: "^done" }, own);
  expect(real.is_error).toBeFalsy();
  // The exit file of a command that runs: written when it ends, so the wait is the wake for its end.
  const exit = await tool("WaitFor").run({ kind: "file", path: join(spill, "jobs", "b1real.log.exit") }, own);
  expect(exit.is_error).toBeFalsy();
  const noExit = await tool("WaitFor").run({ kind: "file", path: join(spill, "jobs", "b1made-up.log.exit") }, own);
  expect(noExit.is_error).toBe(true);
  const elsewhere = await tool("WaitFor").run({ kind: "file", path: join(spill, "later.log") }, own);
  expect(elsewhere.is_error).toBeFalsy();
  for (const w of waits.list(s.id)) waits.cancel(w.id, s.id);
});

test("the same wait asked again before it fired is the one already set, with the later deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-twin-"));
  const log = join(dir, "rv.log");
  writeFileSync(log, "");
  const first = await tool("WaitFor").run({ kind: "log", path: log, match: "Summary:", timeout_seconds: 600 }, ctx);
  const again = await tool("WaitFor").run({ kind: "log", path: log, match: "Summary:", timeout_seconds: 1800 }, ctx);
  const active = waits.list(s.id, 0).filter((w) => w.status === "active");
  expect(active.length).toBe(1);
  expect(text(again)).toContain(`wait ${active[0]!.id}`);
  expect(text(again)).toContain("no second one was set");
  expect(text(first)).toContain(active[0]!.id);
  expect(active[0]!.deadline - Date.now()).toBeGreaterThan(1700_000);
  // Another condition, or a timer, is a wait of its own.
  await tool("WaitFor").run({ kind: "log", path: log, match: "FAILED" }, ctx);
  await tool("WaitFor").run({ kind: "timer", seconds: 60 }, ctx);
  await tool("WaitFor").run({ kind: "timer", seconds: 60 }, ctx);
  expect(waits.list(s.id, 0).filter((w) => w.status === "active").length).toBe(4);
  for (const w of waits.list(s.id)) waits.cancel(w.id, s.id);
});

// A session whose commands run on another machine: its jobs and their exit files are there, and a wait
// here checks this disk. It is not told to wait on an exit file, nor refused by what this disk lacks.
test("a session on another machine is not told to wait for a file of its machine here", async () => {
  const far = store.createSession({ model: "m", workspace: "/", title: "far" });
  store.db.run("UPDATE sessions SET machine = 'm2' WHERE id = ?", [far.id]);
  const spill = mkdtempSync(join(tmpdir(), "keel-spill-"));
  const own = { ...ctx, sessionId: far.id, spillDir: spill };
  const r = await tool("WaitFor").run({ kind: "process", pid: 0 }, own);
  expect(r.is_error).toBe(true);
  expect(text(r)).toContain("does not wake it when it ends");
  expect(text(r)).toContain("runs on the session's machine, whose files and processes a wait here does not see: wait there with a command in the shell tool");
  expect(text(r)).not.toContain(".exit");
  const near = await tool("WaitFor").run({ kind: "process", pid: 0 }, ctx);
  expect(text(near)).toContain("wakes this session by itself when it ends");
  expect(text(near)).toContain('plus ".exit"');
  // A file wait of such a session is refused for where its files are, not as a command it does not have.
  const there = await tool("WaitFor").run({ kind: "file", path: join(spill, "jobs", "b1there.log.exit") }, own);
  expect(text(there)).not.toContain("output file of no background command");
  for (const w of waits.list(far.id)) waits.cancel(w.id, far.id);
});

// Models sent pid 0 or 1 with a few seconds' timeout as a pause, and their own command's log path
// with no pid: the wait they meant is set, and the result says so.
test("a process wait with no process to wait on is set as the wait the call meant", async () => {
  const spill = mkdtempSync(join(tmpdir(), "keel-spill-"));
  const own = { ...ctx, spillDir: spill };
  const pause = await tool("WaitFor").run({ kind: "process", pid: 1, timeout_seconds: 5, note: "noop" }, own);
  expect(pause.is_error).toBeFalsy();
  expect(text(pause)).toContain("Scheduled timer wait");
  expect(text(pause)).toContain('pid 1 is no process: set a pause of 5 s instead. For a pause, use kind "timer" with seconds.');
  mkdirSync(join(spill, "jobs"));
  const log = join(spill, "jobs", "b1run.log");
  writeFileSync(log, "");
  const path = await tool("WaitFor").run({ kind: "process", path: log, timeout_seconds: 1800, note: "remote run" }, own);
  expect(path.is_error).toBeFalsy();
  expect(text(path)).toContain("Scheduled file wait");
  expect(text(path)).toContain("waited for the end of your background command b1run (its exit file) instead");
  expect(waits.list(s.id).some((w) => w.kind === "file" && (w.spec as any).path === `${log}.exit`)).toBe(true);
  // What names nothing to reframe stays a refusal that says what to use.
  const other = await tool("WaitFor").run({ kind: "process", path: join(spill, "out.txt") }, own);
  expect(other.is_error).toBe(true);
  expect(text(other)).toContain('To wait for that file, use kind "file"');
  const none = await tool("WaitFor").run({ kind: "process", pid: 0 }, own);
  expect(none.is_error).toBe(true);
  for (const w of waits.list(s.id)) waits.cancel(w.id, s.id);
});

// A pid with a kind that takes none is ignored.
test("a pid given with another kind is ignored", async () => {
  const r = await tool("WaitFor").run({ kind: "timer", seconds: 30, pid: 1 }, ctx);
  expect(r.is_error).toBeFalsy();
  expect(text(r)).toContain("Scheduled timer wait");
  for (const w of waits.list(s.id)) waits.cancel(w.id, s.id);
});

// A loopback http wait is answered with the exact other way, per family.
test("a local http wait names the monitor call that does it", async () => {
  const r = await tool("WaitFor").run({ kind: "http", url: "http://127.0.0.1:48555/api/health" }, ctx);
  expect(r.is_error).toBe(true);
  expect(text(r)).toContain("no process of this session listens on 48555 yet: start the server, then wait, or use Monitor with curl");
  expect(text(r)).toContain('command: "until curl -fsS -o /dev/null http://127.0.0.1:48555/api/health;');
  const other = await tool("wait_for").run({ kind: "http", url: "http://10.0.0.5/x" }, ctx);
  expect(text(other)).toContain("monitor (command:");
});


// A server the session started is its own: a port its process listens on. A port a command only names is not.
test("an http wait on a loopback port a process of the session listens on is set", async () => {
  const { startJob, stopJob } = await import("../tools/jobs.ts");
  const dir = mkdtempSync(join(tmpdir(), "keel-job-"));
  const port = 48777;
  const job = startJob({ sessionId: s.id, command: `exec bun -e 'Bun.serve({ port: ${port}, hostname: "127.0.0.1", fetch: () => new Response("ok") }); setInterval(() => {}, 1000)' # ${port + 1}`, cwd: dir, logDir: join(dir, "jobs"), background: true });
  try {
    const refused = await tool("WaitFor").run({ kind: "http", url: `http://127.0.0.1:${port + 1}/health` }, ctx);
    expect(refused.is_error).toBe(true);
    expect(text(refused)).toContain(`no process of this session listens on ${port + 1} yet`);
    let ok: any;
    for (let i = 0; i < 100; i++) {
      ok = await tool("WaitFor").run({ kind: "http", url: `http://127.0.0.1:${port}/health` }, ctx);
      if (!ok.is_error) break;
      await Bun.sleep(100);
    }
    expect(ok.is_error).toBeFalsy();
    expect(text(ok)).toContain("Scheduled http wait");
  } finally {
    await stopJob(job);
    for (const w of waits.list(s.id)) waits.cancel(w.id, s.id);
  }
});

test("CronDelete deletes the model's own scheduled tasks, not the owner's", async () => {
  const mine = loops.create({ session_id: s.id, schedule: "10m", prompt: "check", created_by: "model" }).loop;
  const owners = loops.create({ session_id: s.id, schedule: "10m", prompt: "report", created_by: "owner" }).loop;
  expect((await tool("CronDelete").run({ id: owners.id }, ctx)).is_error).toBe(true);
  expect(loops.get(owners.id)).toBeTruthy();
  expect((await tool("CronDelete").run({ id: mine.id }, ctx)).is_error).toBeFalsy();
});

test("CronCreate offers no gate, and a gate sent anyway is refused with the owner's way, the loop not made", async () => {
  expect(JSON.stringify(tool("CronCreate").input_schema)).not.toContain("gate");
  const n = loops.list().length;
  const r = await tool("CronCreate").run({ cron: "10m", prompt: "check", gate: "git status" }, ctx);
  expect(r.is_error).toBe(true);
  expect(text(r)).toContain("A check command for a loop is set by the owner, in the Loops panel; this loop runs its prompt each time.");
  expect(loops.list()).toHaveLength(n);
  expect((await tool("CronCreate").run({ cron: "10m", prompt: "check" }, ctx)).is_error).toBeFalsy();
});
