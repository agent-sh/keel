// The terminal list over a generated session, where the e2e cannot reach: more
// finished jobs than a list carries and one running, with every file read and
// every read of the transcript counted. A list reads no log of a job it leaves
// out, and a second list reads nothing that did not change.
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import { io, ownerRun, stopOne, waitOne } from "../../tools/terminal.ts";
import { COMMANDS_KEPT, terminalRoutes, type TermEntry } from "./terminal.ts";

const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "terminal-routes-"));
const store = new Store(dir);
const spill = join(dir, "spill");
const s = store.createSession({ workspace: dir, model: "p:m" });
const jobs = join(spill, s.id, "jobs");
mkdirSync(jobs, { recursive: true });
const routes = terminalRoutes({ store, engine: { isRunning: () => false }, errors: { capture: () => {} } } as any) as any;
afterAll(async () => {
  await stopOne(s.id, active);
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Counted: the files a list opens or reads whole, and what it asks of the transcript.
const opened: string[] = [], read: string[] = [];
const asked: { after: number; got: number }[] = [];
const { openSync, readFileSync } = io;
io.openSync = ((p: string, ...a: any[]) => { opened.push(p); return (openSync as any)(p, ...a); }) as typeof io.openSync;
io.readFileSync = ((p: string, ...a: any[]) => { read.push(p); return (readFileSync as any)(p, ...a); }) as typeof io.readFileSync;
const events = store.events.bind(store);
store.events = (id: string, after = 0) => { const got = events(id, after); asked.push({ after, got: got.length }); return got; };
const list = async (id = s.id) => {
  opened.length = read.length = asked.length = 0;
  const r = (await routes["/api/sessions/:id/terminal"].GET({ params: { id } })) as Response;
  expect(r.status).toBe(200);
  return ((await r.json()) as { commands: TermEntry[] }).commands;
};
const logsOpened = () => opened.filter((p) => p.endsWith(".log"));

// 320 finished jobs, the oldest first; the model ran the newest through a call.
const FINISHED = 320, LISTED = 300;
const T0 = Date.now() - 3_600_000;
const jobId = (i: number) => `bjob${String(i).padStart(4, "0")}`;
const logOf = (id: string) => join(jobs, `${id}.log`);
const call = (id: string, command: string) => store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id, name: "Bash", input: { command } }] });
const result = (id: string, text: string, error = false) => store.append(s.id, "tool_result", { results: [{ tool_use_id: id, content: text, is_error: error }] });
for (let i = 0; i < 40; i++) store.append(s.id, "note", { text: `An earlier note ${i}.` });
call("call-newest", `echo job ${FINISHED - 1}`);
result("call-newest", `output of job ${FINISHED - 1}`);
for (let i = 0; i < FINISHED; i++) {
  const id = jobId(i);
  writeFileSync(join(jobs, `${id}.json`), JSON.stringify({ id, num: i + 1, sessionId: s.id, command: `echo job ${i}`, cwd: dir, started: T0 + i * 1000, background: false, pid: 1, reported: true, ended: T0 + i * 1000 + 500, exit_code: i % 7 === 0 ? 2 : 0, signal: null, ...(i === FINISHED - 1 ? { call_id: "call-newest" } : { by: "owner" }) }));
  // One log is longer than the end a list carries.
  writeFileSync(logOf(id), `${"x".repeat(i === 150 ? 10_000 : 200)}\noutput of job ${i}\n`);
}
// One running: it says a line, waits for a file, says another, waits, exits 3.
const go = join(dir, "go"), end = join(dir, "end");
const active = ownerRun(spill, s.id, `echo first; while [ ! -e ${go} ]; do sleep 0.05; done; echo second; while [ ! -e ${end} ]; do sleep 0.05; done; exit 3`, dir).id;
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(50); expect(ok()).toBe(true); };

test("a list reads no log it leaves out, and a second one only what changed", async () => {
  await until(() => existsSync(logOf(active)) && statSync(logOf(active)).size >= 6);
  const excluded = new Set(Array.from({ length: FINISHED + 1 - LISTED }, (_, i) => logOf(jobId(i))));

  // The first list: the newest 300 jobs with their output, the running one among them.
  const first = await list();
  expect(first.length).toBe(LISTED);
  expect(first[0]!.command).toBe(`echo job ${FINISHED + 1 - LISTED}`);
  expect(first.at(-1)).toMatchObject({ job_id: active, state: "running", by: "owner", last: "first", output: "first\n" });
  expect(first.at(-2)).toMatchObject({ call_id: "call-newest", job_id: jobId(FINISHED - 1), state: "ok", by: "model", last: `output of job ${FINISHED - 1}` });
  expect(first.find((e) => e.command === "echo job 28")).toMatchObject({ state: "failed", exit_code: 2, bytes: 218, output_from: 0 });
  expect(first.find((e) => e.command === "echo job 150")).toMatchObject({ bytes: 10_019, output_from: 10_019 - 8192, last: "output of job 150" });
  expect(logsOpened().filter((p) => excluded.has(p))).toEqual([]);
  expect(logsOpened().length).toBe(LISTED);
  expect(asked).toEqual([{ after: 0, got: 42 }]);

  // Nothing changed: no log and no record is read again, and no event of the transcript.
  const second = await list();
  expect(second).toEqual(first);
  expect([opened, read]).toEqual([[], []]);
  expect(asked).toEqual([{ after: 42, got: 0 }]);

  // The running command says more: its log alone is read again.
  writeFileSync(go, "");
  await until(() => statSync(logOf(active)).size >= 13);
  const more = await list();
  expect(more.at(-1)).toMatchObject({ job_id: active, state: "running", last: "second", output: "first\nsecond\n" });
  expect(more.slice(0, -1)).toEqual(first.slice(0, -1));
  expect([opened, read]).toEqual([[logOf(active)], []]);

  // It ends: its record is read once more, and it shows how it ended.
  writeFileSync(end, "");
  await waitOne(spill, s.id, active, 10_000);
  const ended = await list();
  expect(ended.at(-1)).toMatchObject({ job_id: active, state: "failed", exit_code: 3, output: "first\nsecond\n" });
  expect(logsOpened()).toEqual([]);
  const settled = await list();
  expect(settled).toEqual(ended);
  expect([opened, read]).toEqual([[], []]);

  // A finished job's log grows (a late writer) and another's goes missing: each is seen, nothing else is read.
  appendFileSync(logOf(jobId(100)), "a late line\n");
  unlinkSync(logOf(jobId(200)));
  const changed = await list();
  expect(changed.find((e) => e.job_id === jobId(100))).toMatchObject({ last: "a late line", bytes: 231 });
  expect(changed.find((e) => e.job_id === jobId(200))).toMatchObject({ log_missing: true, output: "", bytes: 0, state: "ok" });
  expect([opened, read]).toEqual([[logOf(jobId(100))], []]);

  // A command only the transcript knows (no job here): the two new events are read, no file.
  call("call-far", "make test");
  result("call-far", "3 failed\nExit code: 2", true);
  const far = await list();
  expect(far.length).toBe(LISTED + 1);
  expect(far.at(-1)).toMatchObject({ call_id: "call-far", command: "make test", state: "failed", exit_code: 2, output: "3 failed\nExit code: 2", by: "model" });
  expect(far.at(-1)!.job_id).toBeUndefined();
  expect([opened, read]).toEqual([[], []]);
  expect(asked).toEqual([{ after: 42, got: 2 }]);
  // A call that has not answered yet stands as stopped (no turn runs), then takes its result.
  call("call-open", "sleep 1");
  expect((await list()).at(-1)).toMatchObject({ call_id: "call-open", state: "stopped" });
  result("call-open", "done");
  expect((await list()).at(-1)).toMatchObject({ call_id: "call-open", state: "ok", output: "done" });
  expect(asked).toEqual([{ after: 45, got: 1 }]);
});

test("what a list keeps is not trusted past what it can tell: another file, an exit code not written yet, a long history", async () => {
  // A log replaced by another file of the same size and time is read again.
  const log = logOf(jobId(300));
  const at = new Date(Date.now() - 60_000);
  utimesSync(log, at, at);
  expect((await list()).find((e) => e.job_id === jobId(300))).toMatchObject({ last: "output of job 300" });
  const before = statSync(log);
  writeFileSync(`${log}.new`, `${"z".repeat(200)}\nOUTPUT of job 300\n`);
  utimesSync(`${log}.new`, at, at);
  renameSync(`${log}.new`, log);
  expect([statSync(log).size, statSync(log).mtimeMs]).toEqual([before.size, before.mtimeMs]);
  expect((await list()).find((e) => e.job_id === jobId(300))).toMatchObject({ last: "OUTPUT of job 300" });
  expect(logsOpened()).toEqual([log]);

  // A job no daemon saw end: its wrapper's exit file is there before the code is in it.
  const orphan = "borphan1";
  writeFileSync(join(jobs, `${orphan}.json`), JSON.stringify({ id: orphan, num: 999, sessionId: s.id, command: "make deploy", cwd: dir, started: Date.now(), background: true, pid: 1, by: "owner" }));
  writeFileSync(logOf(orphan), "deploying\n");
  writeFileSync(`${logOf(orphan)}.exit`, "");
  expect((await list()).find((e) => e.job_id === orphan)).toMatchObject({ state: "stopped", exit_code: null });
  writeFileSync(`${logOf(orphan)}.exit`, "7\n");
  expect((await list()).find((e) => e.job_id === orphan)).toMatchObject({ state: "failed", exit_code: 7 });
  await list();
  expect(read.filter((p) => p.endsWith(".exit"))).toEqual([]); // the code is final once read

  // A session whose commands outgrow what is kept is read from its events for each list.
  const long = store.createSession({ workspace: dir, model: "p:m" });
  const big = Math.ceil(COMMANDS_KEPT / 4);
  for (let i = 0; i < 5; i++) {
    store.append(long.id, "assistant", { blocks: [{ type: "tool_use", id: `long-${i}`, name: "Bash", input: { command: `echo ${i} ${"#".repeat(big)}` } }] });
    store.append(long.id, "tool_result", { results: [{ tool_use_id: `long-${i}`, content: `said ${i}` }] });
  }
  for (const _ of [1, 2]) {
    const all = await list(long.id);
    expect(all.map((e) => e.output)).toEqual([0, 1, 2, 3, 4].map((i) => `said ${i}`));
    expect(asked).toEqual([{ after: 0, got: 10 }]);
  }
});
