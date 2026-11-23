// Log waits read on from a durable cursor (a restart, a rotated file, a line
// longer than one read), a monitor matches whole lines, and a cancel says what
// it did. A wake a wait owes survives a daemon that stops at any point between
// reading the match and storing the wake. What a restart does cannot be
// reached from the page.
import { expect, setSystemTime, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { dropPending, flush, setDeps } from "./core.ts";
import * as activity from "./activity.ts";
import * as waits from "./waits.ts";

const dir = mkdtempSync(join(tmpdir(), "keel-waits-"));
const sent: string[] = [];
const store = new Store(join(dir, "state"));
const busy = new Set<string>(); // sessions with a turn running
const faults: { afterAppend?: boolean; draining?: boolean } = {};
const engine = {
  isRunning: (id: string) => busy.has(id),
  isDraining: () => !!faults.draining,
  send: (id: string, text: string, o: any) => {
    sent.push(text);
    const event = store.append(id, "user", { text, ...o?.meta });
    if (faults.afterAppend) throw new Error("the daemon stopped here");
    return { event };
  },
};
setDeps({ store, bus: new Bus(), errors: { capture() {} }, engine, providers: { current: () => [] } } as any);
waits.migrate();
activity.migrate();
const s = store.createSession({ model: "m", workspace: dir, title: "t" });
const log = (name: string, text = "") => (writeFileSync(join(dir, name), text), join(dir, name));
const wait = (path: string) => waits.create(s.id, waits.normalize({ kind: "log", path, match: "^READY$" }, dir), { timeout_seconds: 60 });
const status = (id: string) => waits.get(id)!.status;
// The wakes of a wait stored in the session's transcript.
const wakes = (id: string) => store.events(s.id).filter((e) => e.kind === "user" && String(e.data.text).includes(`<wait_fired id="${id}"`)).map((e) => String(e.data.text));
const until = async (ok: () => boolean) => { for (let i = 0; i < 150 && !ok(); i++) await Bun.sleep(20); };
// A new daemon: what was only in memory is gone, and it recovers from the store.
const restart = () => { busy.clear(); dropPending(s.id); waits.recover(); flush(s.id); };

test("a line written while the daemon was down still wakes the wait; one written before it never does", async () => {
  const p = log("restart.log", "OLD\nREADY\n");
  const w = wait(p);
  appendFileSync(p, "READY\n"); // written during the restart
  waits.recover(); // what a new daemon does with the saved cursor
  await waits.tick();
  expect(status(w.id)).toBe("fired");
  expect(waits.get(w.id)!.outcome).toContain("READY");
});

// A pattern with a leading flag group, as Python, PCRE and Go write it: JavaScript refused it, and the wait was never set.
test("a log wait's pattern may start with an inline flag group", async () => {
  const p = log("flags.log");
  const w = waits.create(s.id, waits.normalize({ kind: "log", path: p, match: "(?i)^ready$|done" }, dir), { timeout_seconds: 60 });
  appendFileSync(p, "Ready\n");
  await waits.tick();
  expect(status(w.id)).toBe("fired");
  expect(() => waits.normalize({ kind: "monitor", command: "true", match: "(?im)^exit" }, dir)).not.toThrow();
});

// A model that wanted a pause, or the end of a command it started in the
// background, sent a process wait with pid 0: the refusal says what to use.
// A background command's end wakes its session by itself; a file wait on its
// exit file waits for it too.
test("a process wait with no pid says what a pid is and what to use instead", () => {
  for (const pid of [0, undefined, 1]) {
    const head = pid === undefined ? "a process wait needs a running process's id" : `pid ${pid} is no process to wait on`;
    expect(() => waits.normalize({ kind: "process", pid, timeout_seconds: 60 }, dir)).toThrow(new RegExp(`^${head}.*"timer".*background command.*wakes this session by itself.*needs no wait.*"file".*\\.exit`, "s"));
  }
});

test("a replaced file is read from its start, whatever its size", async () => {
  for (const [n, text] of [["small", "READY\n"], ["equal", "READY\nab\n"], ["large", "READY\nabcd\n"]] as const) {
    const p = log(`${n}.log`, "12345678");
    const w = wait(p);
    writeFileSync(`${p}.new`, text);
    renameSync(`${p}.new`, p);
    await waits.tick();
    expect(`${n}:${status(w.id)}`).toBe(`${n}:fired`);
  }
  // An append to the same file does not replay what was there before.
  const p = log("append.log", "READY\n");
  const w = wait(p);
  appendFileSync(p, "other\n");
  await waits.tick();
  expect(status(w.id)).toBe("active");
});

test("a line longer than one read is skipped and the next complete line still matches", async () => {
  const p = log("long.log");
  const w = wait(p);
  appendFileSync(p, `${"x".repeat(4 << 20)}\nREADY\n`);
  // A log is probed once a second: the skip, then the line after it.
  for (let i = 0; i < 3 && status(w.id) === "active"; i++) { await waits.tick(); if (status(w.id) === "active") await Bun.sleep(1001); }
  expect(status(w.id)).toBe("fired");
});

test("a monitor matches the whole line, however it is split", async () => {
  const pad = (n: number) => "x".repeat(n);
  // A marker across the 2,000-character display cut, and one across two writes.
  const cmd = `printf '${pad(1996)}READY\\n'; printf '${pad(10)}REA'; sleep 0.2; printf 'DY\\n'; printf 'nothing here\\n'`;
  const w = waits.create(s.id, waits.normalize({ kind: "monitor", command: cmd, match: "READY", coalesce_ms: 0 }, dir), { timeout_seconds: 30 });
  for (let i = 0; i < 40 && status(w.id) === "active"; i++) { await waits.tick(); await Bun.sleep(100); }
  const events = sent.filter((t) => t.includes(`<monitor_event id="${w.id}"`)).join("\n");
  expect(events.match(/READY/g)?.length).toBe(2);
  expect(events).not.toContain("nothing here");
});

test("cancelling a wait that already fired says it did not stop the wake", async () => {
  const t = waits.create(s.id, waits.normalize({ kind: "timer", seconds: 0.001 }, dir));
  await Bun.sleep(5);
  await waits.tick();
  expect(waits.cancel(t.id)).toBe("fired");
  expect(waits.cancelText(t.id, "fired")).toContain("did not stop");
  const u = waits.create(s.id, waits.normalize({ kind: "timer", seconds: 60 }, dir));
  expect(waits.cancel(u.id)).toBe("cancelled");
  expect(waits.cancel(u.id)).toBe("already_cancelled");
  expect(status(u.id)).toBe("cancelled");
});

test("a process wait goes on while a thread of the process still runs, and ends when only its zombie is left", async () => {
  const real = { ...waits.procfs };
  let state = "S", threads = 3;
  const line = () => { const f = Array(22).fill("0"); f[0] = state; f[17] = String(threads); f[19] = "100"; return `4243 (job two) ${f.join(" ")}`; };
  waits.procfs.signal0 = (pid) => (pid === 4243 ? true : real.signal0(pid));
  waits.procfs.stat = (pid) => (pid === 4243 ? line() : real.stat(pid));
  try {
    const w = waits.create(s.id, waits.normalize({ kind: "process", pid: 4243 }, dir), { timeout_seconds: 600 });
    let t = Date.now();
    const later = async () => { setSystemTime(new Date((t += 60_000))); await waits.tick(); };
    await later();
    expect(status(w.id)).toBe("active");
    [state, threads] = ["Z", 2]; // its first thread has ended, another still runs
    await later();
    expect(status(w.id)).toBe("active");
    threads = 1; // all of it has ended; its parent has not read that yet
    await later();
    expect(status(w.id)).toBe("fired");
  } finally {
    Object.assign(waits.procfs, real);
    setSystemTime();
  }
});

test("a process wait ends when its pid comes to name another process", async () => {
  const real = { ...waits.procfs };
  let start = "100", alive = true;
  waits.procfs.signal0 = (pid) => (pid === 4242 ? alive : real.signal0(pid));
  waits.procfs.stat = (pid) => (pid === 4242 ? `4242 (job one) S 1 ${Array.from({ length: 17 }, () => "0").join(" ")} ${start} 0` : real.stat(pid));
  try {
    const w = waits.create(s.id, waits.normalize({ kind: "process", pid: 4242 }, dir), { timeout_seconds: 600 });
    let t = Date.now();
    const later = async () => { setSystemTime(new Date((t += 60_000))); await waits.tick(); };
    await later();
    expect(status(w.id)).toBe("active"); // the same process runs on
    start = "200"; // it ended, and the pid now names a new process
    await later();
    expect(status(w.id)).toBe("fired");
    expect(waits.get(w.id)!.outcome).toContain("another process");
  } finally {
    Object.assign(waits.procfs, real);
    setSystemTime();
  }
});

test("a daemon that stops after reading the matching line still wakes the session, once", async () => {
  const p = log("gap-read.log");
  const w = wait(p);
  appendFileSync(p, "noise\nREADY\n");
  // The line is read and the daemon is gone before the wait is settled.
  const query = store.db.query.bind(store.db);
  (store.db as any).query = (sql: string) => { if (sql.startsWith("UPDATE waits SET status")) throw new Error("the daemon stopped here"); return query(sql); };
  try { await waits.tick(); } finally { (store.db as any).query = query; }
  expect(status(w.id)).toBe("active");
  restart();
  await waits.tick();
  restart(); // and a restart after it fired changes nothing
  expect(status(w.id)).toBe("fired");
  expect(wakes(w.id)).toHaveLength(1);
  expect(wakes(w.id)[0]).toContain("READY");
});

test("a wake settled while the session was busy is sent after a restart, once", async () => {
  const p = log("gap-busy.log");
  const w = wait(p);
  appendFileSync(p, "READY\n");
  busy.add(s.id); // the wake waits in memory for the turn to end
  await waits.tick();
  expect(status(w.id)).toBe("fired");
  expect(wakes(w.id)).toHaveLength(0);
  restart();
  restart();
  expect(wakes(w.id)).toHaveLength(1);
  expect(wakes(w.id)[0]).toContain("READY");
});

// The wake's prompt and its acknowledgement are one write: a daemon that
// stops between them has stored neither, and the next one sends the wake.
test("a daemon that stops while a wake is stored has stored nothing, and the next one sends it once", async () => {
  const p = log("gap-ack.log");
  const w = wait(p);
  appendFileSync(p, "READY\n");
  faults.afterAppend = true; // the write is cut after the prompt, before the wake is acknowledged
  try { await waits.tick(); } finally { faults.afterAppend = false; }
  expect(status(w.id)).toBe("fired");
  expect(wakes(w.id)).toHaveLength(0);
  restart();
  restart();
  expect(wakes(w.id)).toHaveLength(1);
  expect(wakes(w.id)[0]).toContain("READY");
});

// A store from before the two were one write can hold the prompt with the wake still owed.
test("a wake stored before the daemon stopped is not sent again", async () => {
  const p = log("gap-old.log");
  const w = wait(p);
  appendFileSync(p, "READY\n");
  busy.add(s.id);
  await waits.tick();
  expect(wakes(w.id)).toHaveLength(0);
  store.append(s.id, "user", { text: `<wait_fired id="${w.id}" kind="log" outcome="fired">\nREADY\n</wait_fired>`, kind: "wait", wait_id: w.id, outcome: "fired" });
  restart();
  restart();
  expect(wakes(w.id)).toHaveLength(1);
  expect(wakes(w.id)[0]).toContain("READY");
});

test("a cancelled wait sends no wake, before or after a restart", async () => {
  const p = log("gap-cancel.log");
  const w = wait(p);
  appendFileSync(p, "READY\n");
  expect(waits.cancel(w.id)).toBe("cancelled");
  await waits.tick();
  restart();
  await waits.tick();
  expect(status(w.id)).toBe("cancelled");
  expect(wakes(w.id)).toHaveLength(0);
});

// The scheduler's pass never waits for a probe that asks something outside the
// process. The clock is the test's: a probe period, then the probe's limit.
test("a held PR probe holds neither the other waits nor a second request of its own", async () => {
  const pids = join(dir, "gh.pids");
  const gh = join(dir, "gh-held.sh");
  writeFileSync(gh, `#!/bin/sh\necho $$ >> ${pids}\nsleep 20\n`, { mode: 0o755 }); // gh, and a child of its own, not answering
  const started = () => (existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").map(Number) : []);
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  const env = process.env.KEEL_GH_BIN;
  process.env.KEEL_GH_BIN = gh;
  let t = Date.now();
  const at = async (ms: number) => { setSystemTime(new Date((t += ms))); void waits.tick(); await Bun.sleep(0); };
  try {
    setSystemTime(new Date(t));
    const pr = waits.create(s.id, waits.normalize({ kind: "pr_checks", repo: "o/r", pr_number: 7 }, dir), { timeout_seconds: 600 });
    await at(0);
    const timer = waits.create(s.id, waits.normalize({ kind: "timer", seconds: 1 }, dir));
    const file = waits.create(s.id, waits.normalize({ kind: "file", path: gh }, dir), { timeout_seconds: 600 });
    await at(1000); // the next pass
    expect([status(timer.id), status(file.id)]).toEqual(["fired", "fired"]);
    await until(() => started().length === 1);
    await at(10_000); // its period comes round twice: still the one request
    await at(10_000);
    expect(started()).toHaveLength(1);
    expect(waits.get(pr.id)).toMatchObject({ status: "active", last_error: null });
    await at(10_000); // past the limit: stopped and said so
    expect(waits.get(pr.id)!.last_error).toContain("gh pr view did not answer within 30 s");
    const first = started()[0]!;
    await until(() => gone(first));
    for (let i = 0; i < 10 && started().length < 2; i++) { await at(10_000); await Bun.sleep(50); }
    expect(started()).toHaveLength(2); // the next request, after the first was gone
    expect(status(pr.id)).toBe("active");
    expect(waits.cancel(pr.id)).toBe("cancelled"); // cancelling stops the request that is out
    await until(() => gone(started()[1]!));
    expect(gone(started()[1]!)).toBe(true);
    restart();
    expect(wakes(pr.id)).toHaveLength(0);
  } finally {
    for (const pid of started()) { Bun.spawnSync(["pkill", "-P", String(pid)]); try { process.kill(pid); } catch {} }
    if (env === undefined) delete process.env.KEEL_GH_BIN; else process.env.KEEL_GH_BIN = env;
    setSystemTime();
  }
});

test("a slow HTTP target is given up at its limit with one request out", async () => {
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (requests++, new Promise<Response>(() => {})) });
  let t = Date.now();
  const at = async (ms: number) => { setSystemTime(new Date((t += ms))); void waits.tick(); await Bun.sleep(0); };
  try {
    setSystemTime(new Date(t));
    const w = waits.create(s.id, waits.normalize({ kind: "http", url: `http://127.0.0.1:${server.port}/slow` }, dir), { timeout_seconds: 600 });
    await at(0);
    await until(() => requests === 1);
    await at(3000); // its period: the first request is still out
    await Bun.sleep(50);
    expect(requests).toBe(1);
    await at(3000); // six seconds: past the limit
    expect(waits.get(w.id)).toMatchObject({ status: "active" });
    expect(waits.get(w.id)!.last_error).toContain("did not answer within 5 s");
    expect(waits.cancel(w.id)).toBe("cancelled");
  } finally {
    setSystemTime();
    server.stop(true);
  }
});

test("a probe that answers after its wait was cancelled wakes nobody", async () => {
  let calls = 0;
  let answer!: (v: string) => void;
  waits.registerWaitKind("held", { every: 0, normalize: (spec) => ({ kind: spec.kind }) as any, probe: () => (calls++, new Promise<string>((r) => (answer = r))) });
  const w = waits.create(s.id, waits.normalize({ kind: "held" }, dir), { timeout_seconds: 600 });
  void waits.tick();
  void waits.tick();
  await Bun.sleep(0);
  expect(calls).toBe(1);
  expect(waits.cancel(w.id)).toBe("cancelled");
  answer("it is ready");
  await Bun.sleep(0);
  restart();
  expect(status(w.id)).toBe("cancelled");
  expect(wakes(w.id)).toHaveLength(0);
});

test("an http wait's status is a real status or left out", async () => {
  const http = (status?: unknown, path = "/") => waits.normalize({ kind: "http", url: `http://127.0.0.1:${server.port}${path}`, ...(status === undefined ? {} : { status }) }, dir);
  const answers: Record<string, number> = { "/ok": 200, "/empty": 204, "/moved": 301, "/missing": 404 };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => new Response(null, { status: answers[new URL(r.url).pathname] ?? 500, headers: { location: "/ok" } }) });
  try {
    for (const bad of ["ready", "", "2xx", 204.5, "204.5", 0, 99, 600, -204, NaN, true, [204]]) expect(() => http(bad)).toThrow("whole number from 200 to 599");
    expect(http()).not.toHaveProperty("status");
    expect(http(null)).not.toHaveProperty("status");
    expect(http(204)).toMatchObject({ status: 204 });
    expect(http("204")).toMatchObject({ status: 204 });
    // Left out: any 2xx or 3xx. Given: that status only.
    const start = (status: unknown, path: string) => waits.create(s.id, http(status, path), { timeout_seconds: 600 });
    const any = { ok: start(undefined, "/ok"), moved: start(undefined, "/moved"), missing: start(undefined, "/missing") };
    const only = { ok: start(204, "/ok"), empty: start(204, "/empty") };
    await waits.tick();
    await until(() => !!waits.get(any.missing.id)!.last_error && !!waits.get(only.ok.id)!.last_error && status(only.empty.id) !== "active" && status(any.moved.id) !== "active" && status(any.ok.id) !== "active");
    expect([status(any.ok.id), status(any.moved.id), status(any.missing.id)]).toEqual(["fired", "fired", "active"]);
    expect([status(only.ok.id), status(only.empty.id)]).toEqual(["active", "fired"]);
    expect(waits.get(only.ok.id)!.last_error).toBe("HTTP 200");
    for (const w of [any.missing, only.ok]) waits.cancel(w.id);
  } finally {
    server.stop(true);
  }
});

test("a monitor that reaches its deadline delivers the lines it still held, then says it timed out", async () => {
  const marker = join(dir, "monitor-wrote");
  // One matching line, held for a window far longer than the monitor's deadline.
  const w = waits.create(s.id, waits.normalize({ kind: "monitor", command: `printf 'READY one\\n'; touch ${marker}; sleep 20`, match: "READY", coalesce_ms: 60_000 }, dir), { timeout_seconds: 30 });
  await until(() => existsSync(marker));
  await Bun.sleep(200); // the line is read from the pipe
  await waits.tick();
  expect(waits.get(w.id)).toMatchObject({ status: "active", events: 0 });
  try {
    setSystemTime(new Date(w.deadline + 1));
    await waits.tick();
  } finally {
    setSystemTime();
  }
  flush(s.id);
  const said = store.events(s.id).filter((e) => e.kind === "user" && String(e.data.text).includes(`id="${w.id}"`)).map((e) => String(e.data.text)).join("\n");
  expect(said.match(/<monitor_event /g)).toHaveLength(1);
  expect(said.match(/<wait_fired /g)).toHaveLength(1);
  expect(said).toContain("READY one");
  expect(said.indexOf("READY one")).toBeLessThan(said.indexOf('outcome="timeout"'));
  expect(waits.get(w.id)).toMatchObject({ status: "timeout", events: 1 });
});

test("a wake says the whole outcome, and a cut one says it was cut", async () => {
  // A monitor that ends with five long last lines and no event to carry them.
  const line = (i: number) => `${"x".repeat(1900)}END${i}`;
  const cmd = [1, 2, 3, 4, 5].map((i) => `printf '%s\\n' ${line(i)}`).join("; ");
  const w = waits.create(s.id, waits.normalize({ kind: "monitor", command: cmd, match: "never-there" }, dir), { timeout_seconds: 30 });
  await until(() => status(w.id) !== "active");
  expect(wakes(w.id)).toHaveLength(1);
  for (const i of [1, 2, 3, 4, 5]) expect(wakes(w.id)[0]).toContain(`END${i}`);
  expect(wakes(w.id)[0]).not.toContain("[cut here");
  // An outcome longer than what is kept: cut with a mark, in the row and in the wake.
  waits.registerWaitKind("wordy", { every: 0, normalize: (spec) => ({ kind: spec.kind }) as any, probe: () => `START${"y".repeat(20_000)}` });
  const long = waits.create(s.id, waits.normalize({ kind: "wordy" }, dir), { timeout_seconds: 600 });
  await waits.tick();
  expect(waits.get(long.id)!.outcome).toMatch(/y\n\[cut here: 8005 more characters are not kept\]$/);
  expect(wakes(long.id)[0]).toContain("[cut here: 8005 more characters are not kept]");
});

test("a wake owed at start waits for a cut turn to end, and a draining daemon sends none", async () => {
  const cut = store.createSession({ model: "m", workspace: dir, title: "cut" });
  const stored = () => store.events(cut.id).filter((e) => e.kind === "user").length;
  const w = waits.create(cut.id, waits.normalize({ kind: "timer", seconds: 0.001 }, dir));
  await Bun.sleep(5);
  faults.draining = true; // the daemon is on its way down: the wake starts no turn
  await waits.tick();
  faults.draining = false;
  expect([status(w.id), stored()]).toEqual(["fired", 0]);
  // The next daemon finds the session's turn cut by the restart: the engine continues it.
  store.append(cut.id, "turn_end", { reason: "restart" });
  dropPending(cut.id);
  waits.recover();
  await Bun.sleep(400); // past the wait a wake at start has for other sessions
  expect(stored()).toBe(0);
  flush(cut.id); // the continued turn ended
  expect(stored()).toBe(1);
  expect(store.events(cut.id).at(-1)!.data.text).toContain(`<wait_fired id="${w.id}"`);
});

test("a daemon that stops also stops the probe that is out", async () => {
  const pids = join(dir, "gh-stop.pids");
  const gh = join(dir, "gh-stop.sh");
  writeFileSync(gh, `#!/bin/sh\necho $$ >> ${pids}\nsleep 20\n`, { mode: 0o755 });
  const started = () => (existsSync(pids) ? readFileSync(pids, "utf8").trim().split("\n").map(Number) : []);
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  const env = process.env.KEEL_GH_BIN;
  process.env.KEEL_GH_BIN = gh;
  const w = waits.create(s.id, waits.normalize({ kind: "pr_checks", repo: "o/r", pr_number: 8 }, dir), { timeout_seconds: 600 });
  try {
    await waits.tick();
    await until(() => started().length === 1);
    waits.stopAll(); // what the daemon does as it exits
    await until(() => gone(started()[0]!));
    expect(gone(started()[0]!)).toBe(true);
  } finally {
    for (const pid of started()) { Bun.spawnSync(["pkill", "-P", String(pid)]); try { process.kill(pid); } catch {} }
    if (env === undefined) delete process.env.KEEL_GH_BIN; else process.env.KEEL_GH_BIN = env;
    waits.cancel(w.id);
  }
});

// A monitor's batches for a session that is busy are kept in the table until
// their prompt is stored: a restart in that time loses none and sends none
// twice. Only the newest EVENTS_KEPT are kept, and the event says how many
// older ones went.
test("a monitor's batches for a busy session survive a restart, once, and only the newest are kept", async () => {
  const mine = (text: string) => text.includes(`<monitor_event id="${w.id}"`);
  const inputs = () => store.events(s.id).filter((e) => e.kind === "user" && mine(String(e.data.text))).map((e) => String(e.data.text));
  busy.add(s.id); // a turn runs in the session for as long as the monitor writes
  // One matching line every 100 ms: each tick delivers what came since the last one as a batch.
  const lines = 32;
  const w = waits.create(s.id, waits.normalize({ kind: "monitor", command: `for i in $(seq 1 ${lines}); do echo "READY line-$i."; sleep 0.1; done; sleep 30`, match: "READY", coalesce_ms: 0, max_events: 200 }, dir), { timeout_seconds: 60 });
  const all = () => store.db.query<{ n: number }, [string]>("SELECT n FROM wait_events WHERE wait_id = ? ORDER BY n").all(w.id).map((r) => r.n);
  for (let i = 0; i < 400 && !store.db.query("SELECT 1 FROM wait_events WHERE wait_id = ? AND instr(text, ?) > 0").get(w.id, `line-${lines}.`); i++) { await waits.tick(); await Bun.sleep(25); }
  const batches = waits.get(w.id)!.events;
  expect(batches).toBeGreaterThan(waits.EVENTS_KEPT);
  // Nothing reached the busy session, and the table holds the newest batches only.
  expect(inputs()).toEqual([]);
  expect(all()).toEqual(Array.from({ length: waits.EVENTS_KEPT }, (_, i) => batches - waits.EVENTS_KEPT + 1 + i));

  // The daemon restarts: the kept batches arrive in one input, in order, before the wake that says the monitor ended.
  restart();
  restart();
  expect(inputs()).toHaveLength(1);
  const said = inputs()[0]!;
  const numbers = [...said.matchAll(/<monitor_event id="[^"]+" batch="(\d+)"/g)].map((m) => Number(m[1]));
  expect(numbers).toEqual(Array.from({ length: waits.EVENTS_KEPT }, (_, i) => batches - waits.EVENTS_KEPT + 1 + i));
  const dropped = batches - waits.EVENTS_KEPT;
  expect(said).toContain(`[${dropped} earlier ${dropped === 1 ? "batch" : "batches"} of this monitor`);
  expect(said).toContain(`line-${lines}.`);
  expect(said).not.toContain("line-1.");
  expect(said.match(new RegExp(`line-${lines}\\.`, "g"))).toHaveLength(1);
  expect(said.indexOf(`line-${lines}.`)).toBeLessThan(said.indexOf("The daemon restarted and stopped this monitor"));
  expect(all()).toEqual([]);
  // Nothing is left to send at a later start.
  restart();
  expect(inputs()).toHaveLength(1);
}, 60_000);

// A wait told after a downtime says so in its outcome (the model's wake) and its rows (the owner's).
test("a timer due while the daemon was down fires late and says so; a file seen at the start may have held since", async () => {
  const { lateOf } = await import("./waits.ts");
  const t0 = Date.UTC(2026, 10, 22, 18, 12);
  const down = { from: t0 + 11 * 60_000, to: t0 + 54 * 60_000 };
  const timer = { kind: "timer" as const, spec: { kind: "timer" as const, at_ms: t0 + 40 * 60_000 }, created: t0, deadline: t0 + 41 * 60_000 };
  const fired = lateOf(timer, "fired", down.to + 1000, down);
  expect(fired.late).toMatch(/^14 min late: the daemon was down from \d\d:\d\d to \d\d:\d\d$/);
  expect(fired.note).toBe(`It fired ${fired.late}.`);
  expect(lateOf(timer, "fired", t0 + 40 * 60_000 + 1000, down)).toEqual({});
  const file = { kind: "file" as const, spec: { kind: "file" as const, path: "/x" }, created: t0, deadline: t0 + 3600_000 };
  expect(lateOf(file, "fired", down.to + 2000, down).note).toBe("It was seen at the daemon's start: the daemon was down for 43 min before it, so this may have held since then.");
  expect(lateOf(file, "fired", down.to + 5 * 60_000, down)).toEqual({});
});

test("a file or log wait's wake carries what the file gained since the wait began, secrets hidden as in a tool's output", async () => {
  const { setConcealer } = await import("../core/conceal.ts");
  const p = log("carry.log", "before the wait\n");
  const w = wait(p);
  appendFileSync(p, "step 1 ok\nkey hunter2 here\nREADY\nafter\n");
  setConcealer({ text: (t: string) => t.replaceAll("hunter2", "[secret]"), pairs: () => [] } as any);
  try { await waits.tick(); } finally { setConcealer(undefined as any); }
  expect(status(w.id)).toBe("fired");
  const wake = wakes(w.id)[0]!;
  expect(wake).toContain(`What ${p} gained since the wait began (from byte 16 of`);
  expect(wake).toContain("step 1 ok\nkey [secret] here\nREADY\nafter");
  expect(wake).not.toContain("before the wait");
  expect(wake).not.toContain("hunter2");
  // A file that appears whole: all of it; a deadline: what it holds then.
  const q = join(dir, "carry-new.json");
  const f = waits.create(s.id, waits.normalize({ kind: "file", path: q }, dir), { timeout_seconds: 60 });
  writeFileSync(q, '{"result":"pass"}\n');
  await waits.tick();
  expect(wakes(f.id)[0]).toContain(`${q} (18 bytes):\n{"result":"pass"}`);
  const t = waits.create(s.id, waits.normalize({ kind: "file", path: q, contains: "never" }, dir), { timeout_seconds: 0.01 });
  await Bun.sleep(20);
  await waits.tick();
  expect([status(t.id), wakes(t.id)[0]]).toEqual(["timeout", expect.stringContaining(`The end of ${q} (nothing was added since the wait began):\n{"result":"pass"}`)]);
});

// The job's end is judged only when every process of it is known: in a cgroup of its own.
const { jobScope } = await import("../tools/jobs.ts");
test.skipIf(!jobScope().slice)(`a wait on the file a job writes says what is known of the job, and the job's end without the condition wakes it before its deadline${jobScope().slice ? "" : ` (needs a job cgroup: ${jobScope().why})`}`, async () => {
  const { startJob, waitJob } = await import("../tools/jobs.ts");
  const out = join(dir, "job-out.log");
  writeFileSync(out, "");
  const job = startJob({ sessionId: s.id, command: `echo started > ${out}; sleep 0.3; echo finished >> ${out}`, cwd: dir, logDir: join(dir, "jobs") });
  const w = waits.create(s.id, waits.normalize({ kind: "file", path: out, contains: "PASSED" }, dir), { timeout_seconds: 600 });
  expect(w.outcome ?? "").toBe("");
  expect(waits.carries(w)).toContain(`job ${job.id} that writes it`);
  await waitJob(job, 5000);
  expect(job.contain).toBe("cgroup");
  await waits.tick();
  expect(status(w.id)).toBe("active"); // (a moment after the end, for the last writes)
  await Bun.sleep(2100);
  await waits.tick();
  expect(status(w.id)).toBe("ended");
  const wake = wakes(w.id)[0]!;
  expect(wake).toContain(`The job that writes ${out} ended and it does not contain "PASSED".`);
  expect(wake).toContain("started\nfinished");
  expect(wake).toMatch(new RegExp(`Job ${job.id} \\(\`echo started .*\`\\) that writes it ended \\d+ s ago \\(exit 0\\)`));
});

test.skipIf(!jobScope().slice)(`a wait on a job that stopped making progress says it stalled before its deadline${jobScope().slice ? "" : ` (needs a job cgroup: ${jobScope().why})`}`, async () => {
  const { startJob, stopJob } = await import("../tools/jobs.ts");
  const out = join(dir, "stall-out.log");
  // It writes a line, then stops itself: no output and no processor time from then on.
  const job = startJob({ sessionId: s.id, command: `echo started > ${out}; kill -STOP $$`, cwd: dir, logDir: join(dir, "jobs") });
  const w = waits.create(s.id, waits.normalize({ kind: "log", path: out, match: "^DONE$" }, dir), { timeout_seconds: 600 });
  const was = waits.stall.ms;
  waits.stall.ms = 1500;
  try {
    await until(() => existsSync(out) && readFileSync(out, "utf8").includes("started"));
    await Bun.sleep(300);
    await waits.tick(); // (the first look: where its progress stands)
    expect(status(w.id)).toBe("active");
    await Bun.sleep(1700);
    await waits.tick();
    expect(status(w.id)).toBe("ended");
    expect(wakes(w.id)[0]).toMatch(new RegExp(`Job ${job.id} that writes ${out} still runs, but in \\d+ s it wrote nothing and used no processor time, and none of its \\d+ process(es)? was seen waiting`));
    expect(wakes(w.id)[0]).toContain(`Job ${job.id} (`);
  } finally {
    waits.stall.ms = was;
    try { process.kill(job.pid, "SIGCONT"); } catch {}
    await stopJob(job);
  }
});

test("a waited path that is not a regular file is not opened, and one that leads where the session may not read is not carried", async () => {
  // A FIFO with no writer: its open would hold the daemon's loop until one came.
  const fifo = join(dir, "carry.fifo");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const seen = waits.create(s.id, waits.normalize({ kind: "file", path: fifo }, dir), { timeout_seconds: 60 });
  const holds = waits.create(s.id, waits.normalize({ kind: "file", path: fifo, contains: "x" }, dir), { timeout_seconds: 60 });
  const lines = waits.create(s.id, waits.normalize({ kind: "log", path: fifo, match: "x" }, dir), { timeout_seconds: 60 });
  await waits.tick();
  expect(status(seen.id)).toBe("fired");
  expect(wakes(seen.id)[0]).toContain(`${fifo} is not a regular file: it is not carried.`);
  expect([status(holds.id), status(lines.id)]).toEqual(["active", "active"]);
  // A link made after the wait was set, to one of Keel's own files: neither matched nor carried.
  const own = join(process.env.KEEL_STATE_DIR!, "wait-target.txt");
  writeFileSync(own, "READY\nthe daemon's own words\n");
  const link = join(dir, "carry-link.txt");
  const viaLog = waits.create(s.id, waits.normalize({ kind: "log", path: link, match: "^READY$" }, dir), { timeout_seconds: 60 });
  const viaFile = waits.create(s.id, waits.normalize({ kind: "file", path: link }, dir), { timeout_seconds: 60 });
  symlinkSync(own, link);
  await waits.tick();
  // (A path that leads where the session may not read is never read before the deadline: the wait ends now.)
  expect(status(viaLog.id)).toBe("ended");
  expect(waits.get(viaLog.id)!.outcome).toContain(`${link} leads where this session may not read without the owner`);
  expect(waits.get(viaLog.id)!.outcome).not.toContain("the daemon's own words");
  expect(status(viaFile.id)).toBe("fired");
  expect(wakes(viaFile.id)[0]).toContain(`${link} is not carried: it leads where this session may not read without the owner.`);
  expect(wakes(viaFile.id)[0]).not.toContain("the daemon's own words");
  for (const w of [holds, lines]) waits.cancel(w.id);
});

test.skipIf(!jobScope().slice)(`a job that ended before the wait is not its writer, and one started after the linked one ended is${jobScope().slice ? "" : ` (needs a job cgroup: ${jobScope().why})`}`, async () => {
  const { startJob, stopJob, waitJob } = await import("../tools/jobs.ts");
  const out = join(dir, "link-out.log");
  const before = startJob({ sessionId: s.id, command: `echo early > ${out}`, cwd: dir, logDir: join(dir, "jobs") });
  await waitJob(before, 5000);
  const late = waits.create(s.id, waits.normalize({ kind: "file", path: out, contains: "PASSED" }, dir), { timeout_seconds: 600 });
  expect(waits.carries(late)).not.toContain(`job ${before.id}`);
  waits.cancel(late.id);
  // The first writer ends, a second takes over: the wait follows the second, and does not end with the first.
  const a = startJob({ sessionId: s.id, command: `echo a >> ${out}; sleep 0.3`, cwd: dir, logDir: join(dir, "jobs") });
  const w = waits.create(s.id, waits.normalize({ kind: "file", path: out, contains: "PASSED" }, dir), { timeout_seconds: 600 });
  expect(waits.carries(w)).toContain(`job ${a.id} that writes it`);
  await waitJob(a, 5000);
  const b = startJob({ sessionId: s.id, command: `sleep 30; echo PASSED >> ${out}`, cwd: dir, logDir: join(dir, "jobs") });
  try {
    await Bun.sleep(2100);
    await waits.tick();
    expect(status(w.id)).toBe("active");
    expect(waits.carries(w)).toContain(`job ${b.id} that writes it`);
  } finally {
    waits.cancel(w.id);
    await stopJob(b);
  }
});

test("a wait the gate or the owner let read a file reads that file there, and ends when the path leads elsewhere", async () => {
  // One of Keel's own files, which the session's sandbox does not show: the wait on it was allowed (the owner's card).
  const own = join(process.env.KEEL_STATE_DIR!, "wait-approved.log");
  writeFileSync(own, "before\n");
  const w = waits.create(s.id, waits.normalize({ kind: "log", path: own, match: "^READY$" }, dir), { timeout_seconds: 60 });
  appendFileSync(own, "READY\n");
  await waits.tick();
  expect(status(w.id)).toBe("fired");
  expect(wakes(w.id)[0]).toContain("READY");
  // Another file put at the path: read only when the session may read it, else the wait ends now, saying why.
  const swapped = join(process.env.KEEL_STATE_DIR!, "wait-swapped.log");
  writeFileSync(swapped, "first\n");
  const v = waits.create(s.id, waits.normalize({ kind: "log", path: swapped, match: "^READY$" }, dir), { timeout_seconds: 60 });
  writeFileSync(`${swapped}.new`, "READY\nother words\n");
  renameSync(`${swapped}.new`, swapped);
  await waits.tick();
  expect(status(v.id)).toBe("ended");
  expect(waits.get(v.id)!.outcome).toContain(`${swapped} leads where this session may not read without the owner, which is not what the wait was set on: the wait ends here.`);
  expect(waits.get(v.id)!.outcome).not.toContain("other words");
});

test("a file or log wait of a session whose files are on another machine is refused when it is set", async () => {
  const { migrate } = await import("../fleet/db.ts");
  migrate(store);
  const far = store.createSession({ model: "m", workspace: "/far/w", title: "far" });
  // (As a move to another machine sets it: src/fleet/handoff.ts.)
  store.atomic(far.id, () => { store.db.query("UPDATE sessions SET machine = ? WHERE id = ?").run("box-b", far.id); store.updateSession(far.id, { workspace: "/far/w" }); });
  expect(store.session(far.id)?.machine).toBe("box-b");
  expect(() => waits.create(far.id, waits.normalize({ kind: "log", path: "/far/w/x.log", match: "x" }, "/far/w"))).toThrow("a log wait reads this machine's files, and this session's are on box-b: wait there with a command in the shell tool instead");
  expect(() => waits.create(far.id, waits.normalize({ kind: "file", path: "/far/w/x" }, "/far/w"))).toThrow("this session's are on box-b");
  expect(waits.create(far.id, waits.normalize({ kind: "timer", seconds: 60 }, "/far/w")).status).toBe("active");
});

// A blocking read of a socket, a main thread that joins a sleeping thread: each waits, and is not called stuck.
test.skipIf(!jobScope().slice)(`a job that waits on the network or on a sleeping thread is not called stuck${jobScope().slice ? "" : ` (needs a job cgroup: ${jobScope().why})`}`, async () => {
  const { startJob, stopJob } = await import("../tools/jobs.ts");
  const py = (name: string, code: string) => { const f = join(dir, `${name}.py`); writeFileSync(f, code); return f; };
  const recv = py("recv", "import socket\ns = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen()\nc = socket.create_connection(s.getsockname()); a, _ = s.accept()\nprint('started', flush=True)\nc.recv(1)\n");
  const join2 = py("join", "import threading, time\nt = threading.Thread(target=time.sleep, args=(60,)); t.start()\nprint('started', flush=True)\nt.join()\n");
  const jobs: Awaited<ReturnType<typeof startJob>>[] = [];
  const was = waits.stall.ms;
  waits.stall.ms = 1500;
  try {
    const ws = [recv, join2].map((f, k) => {
      const out = join(dir, `waiting-${k}.log`);
      jobs.push(startJob({ sessionId: s.id, command: `exec python3 ${f} > ${out}`, cwd: dir, logDir: join(dir, "jobs") }));
      return { out, w: waits.create(s.id, waits.normalize({ kind: "log", path: out, match: "^DONE$" }, dir), { timeout_seconds: 600 }) };
    });
    await until(() => ws.every(({ out }) => existsSync(out) && readFileSync(out, "utf8").includes("started")));
    await Bun.sleep(300);
    await waits.tick(); // (the first look: where their progress stands)
    await Bun.sleep(1700);
    await waits.tick();
    expect(ws.map(({ w }) => status(w.id))).toEqual(["active", "active"]);
    for (const { w } of ws) waits.cancel(w.id);
  } finally {
    waits.stall.ms = was;
    for (const j of jobs) await stopJob(j);
  }
});

test("a wait set before the job that writes its file finds the job when it starts", async () => {
  const { startJob, stopJob } = await import("../tools/jobs.ts");
  const out = join(dir, "later-job.log");
  const w = waits.create(s.id, waits.normalize({ kind: "log", path: out, match: "^DONE$" }, dir), { timeout_seconds: 60 });
  expect(waits.carries(w)).not.toContain("that writes it");
  const job = startJob({ sessionId: s.id, command: `echo started > ${out}; sleep 5`, cwd: dir, logDir: join(dir, "jobs") });
  try {
    expect(waits.carries(w)).toContain(`job ${job.id} that writes it`);
  } finally {
    waits.cancel(w.id);
    await stopJob(job);
  }
});

// A wait whose writer is gone can no longer fire: it ends at the writer's end with the reason, whatever
// holds the job (a cgroup of its own, or its process group and session), and however the writer is known:
// its command names the file, it holds the file open for writing, or the model named it.
test("a log wait on a file a job writes inside itself ends at the job's end, with the reason", async () => {
  const { startJob, waitJob } = await import("../tools/jobs.ts");
  const out = join(dir, "inside.log");
  const script = join(dir, "inside.sh");
  writeFileSync(script, `exec 3>>"${out}"\necho started >&3\nsleep 0.6\necho finished >&3\n`);
  const job = startJob({ sessionId: s.id, command: `bash ${script}`, cwd: dir, logDir: join(dir, "jobs") });
  await until(() => existsSync(out) && readFileSync(out, "utf8").includes("started"));
  const w = waits.create(s.id, waits.normalize({ kind: "log", path: out, match: "^DONE$" }, dir), { timeout_seconds: 600 });
  expect(waits.carries(w)).toContain(`job ${job.id} that writes it`);
  await waitJob(job, 5000);
  await Bun.sleep(2100);
  await waits.tick();
  expect(status(w.id)).toBe("ended");
  expect(wakes(w.id)[0]).toContain(`The job that writes ${out} ended and no line of it matched ^DONE$.`);
});

test("a file wait on the command the model named as its writer ends at its end; a writer that is not one of the session's commands is refused", async () => {
  const { startJob, waitJob } = await import("../tools/jobs.ts");
  const out = join(dir, "named.out");
  const job = startJob({ sessionId: s.id, command: `python3 -c "import time; time.sleep(0.4); open('${out}', 'w').write('partial')"`, cwd: dir, logDir: join(dir, "jobs") });
  const w = waits.create(s.id, waits.normalize({ kind: "file", path: out, contains: "PASSED", writer: job.id }, dir), { timeout_seconds: 600 });
  await waitJob(job, 5000);
  await Bun.sleep(2100);
  await waits.tick();
  expect([status(w.id), wakes(w.id)[0]]).toEqual(["ended", expect.stringContaining(`The job that writes ${out} ended and it does not contain "PASSED".`)]);
  expect(() => waits.create(s.id, waits.normalize({ kind: "file", path: out, writer: "bnope" }, dir))).toThrow(/no background command bnope in this session/);
  // No writer known: the wait stays until its deadline, as before.
  const lone = waits.create(s.id, waits.normalize({ kind: "file", path: join(dir, "never.out") }, dir), { timeout_seconds: 600 });
  await waits.tick();
  expect(status(lone.id)).toBe("active");
  waits.cancel(lone.id);
});

test("a log line the writer left without a newline is matched at its end", async () => {
  const { startJob, waitJob } = await import("../tools/jobs.ts");
  const out = join(dir, "no-newline.log");
  writeFileSync(out, "");
  const job = startJob({ sessionId: s.id, command: `sleep 0.3; printf 'step\\nDONE' >> ${out}`, cwd: dir, logDir: join(dir, "jobs") });
  const w = waits.create(s.id, waits.normalize({ kind: "log", path: out, match: "^DONE$" }, dir), { timeout_seconds: 600 });
  await waitJob(job, 5000);
  await waits.tick();
  expect(status(w.id)).toBe("active");
  await Bun.sleep(2100);
  await waits.tick();
  expect(status(w.id)).toBe("fired");
  expect(wakes(w.id)[0]).toContain(`its last line, which job ${job.id} left without a newline before it ended):\nDONE`);
});

// A second watch of one run woke an agent a second time for the same line, after its report.
test("waits on the same file that hold at once fire in one wake", async () => {
  const p = log("two-watches.log");
  const a = waits.create(s.id, waits.normalize({ kind: "file", path: p, contains: "exit" }, dir), { timeout_seconds: 60 });
  const b = waits.create(s.id, waits.normalize({ kind: "log", path: p, match: "^exit" }, dir), { timeout_seconds: 60, note: "second watch" });
  const before = sent.length;
  appendFileSync(p, "exit 0\n");
  await waits.tick();
  await until(() => sent.length > before);
  await Bun.sleep(50);
  expect([status(a.id), status(b.id)]).toEqual(["fired", "fired"]);
  const told = sent.slice(before);
  expect(told).toHaveLength(1);
  expect(told[0]).toContain(`Wait ${b.id} ("second watch") on the same file fired with it`);
});

test("an agent's wake names its other waits; its waits on a writer it was told ended are dropped at its turn's end", async () => {
  const { startJob, waitJob } = await import("../tools/jobs.ts");
  const kid = store.createSession({ model: "m", workspace: dir, title: "kid" });
  // (The column the agents' migration adds: an agent's session names its parent.)
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id) ON DELETE CASCADE");
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(s.id, kid.id);
  const p = join(dir, "kid.log");
  writeFileSync(p, "");
  const timer = waits.create(kid.id, waits.normalize({ kind: "timer", seconds: 300 }, dir), { note: "fallback check" });
  const first = waits.create(kid.id, waits.normalize({ kind: "file", path: p, contains: "exit" }, dir), { timeout_seconds: 60 });
  appendFileSync(p, "exit 1\n");
  await waits.tick();
  expect(waits.get(first.id)!.outcome).toContain(`Still set: timer wait ${timer.id} (due `);
  expect(waits.get(first.id)!.outcome).toContain('"fallback check"');
  waits.cancel(timer.id);
  // Its command ended in the turn (its call's result said so): a wait on its file is spent.
  const out = join(dir, "kid.out");
  const job = startJob({ sessionId: kid.id, command: `echo partial > ${out}`, cwd: dir, logDir: join(dir, "jobs"), background: false });
  const spent = waits.create(kid.id, waits.normalize({ kind: "log", path: out, match: "PASSED" }, dir), { timeout_seconds: 600 });
  const runs = startJob({ sessionId: kid.id, command: `sleep 5 > ${join(dir, "kid.run")}`, cwd: dir, logDir: join(dir, "jobs"), background: false });
  const live = waits.create(kid.id, waits.normalize({ kind: "file", path: join(dir, "kid.run"), contains: "x" }, dir), { timeout_seconds: 600 });
  await waitJob(job, 5000);
  expect(waits.dropSpent(kid.id)).toEqual([spent.id]);
  expect([status(spent.id), status(live.id)]).toEqual(["cancelled", "active"]);
  expect(waits.get(spent.id)!.outcome).toContain(`job ${job.id} that writes ${out} ended and the agent was told in the turn`);
  waits.cancel(live.id);
  const { stopJob } = await import("../tools/jobs.ts");
  await stopJob(runs);
});

// Review of the turn-end drop: it took back the wake of a wait that had fired (the agent was told the
// job ended, never that the line matched), and it cancelled a wait whose file already held its text.
test("an agent's turn end keeps a fired wait's wake and a wait that holds already; its end leaves the owner's waits", async () => {
  const { startJob, waitJob } = await import("../tools/jobs.ts");
  const kid = store.createSession({ model: "m", workspace: dir, title: "kid2" });
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id) ON DELETE CASCADE");
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(s.id, kid.id);
  const kidWakes = (id: string) => store.events(kid.id).filter((e) => e.kind === "user" && String(e.data.text).includes(`<wait_fired id="${id}"`));
  const out = join(dir, "kid2.out");
  writeFileSync(out, "");
  const fired = waits.create(kid.id, waits.normalize({ kind: "log", path: out, match: "^DONE$" }, dir), { timeout_seconds: 600 });
  const job = startJob({ sessionId: kid.id, command: `echo DONE >> ${out}`, cwd: dir, logDir: join(dir, "jobs"), background: false });
  await waitJob(job, 5000);
  busy.add(kid.id); // its turn is at work: the wake waits to be stored
  await waits.tick();
  expect(status(fired.id)).toBe("fired");
  // Made after its writer ended, on a file that holds what it waits for already.
  const holds = waits.create(kid.id, waits.normalize({ kind: "file", path: out, contains: "DONE", writer: job.id }, dir), { timeout_seconds: 600 });
  expect(waits.dropSpent(kid.id)).toEqual([]);
  expect(status(holds.id)).toBe("active");
  busy.delete(kid.id);
  flush(kid.id);
  await until(() => kidWakes(fired.id).length > 0);
  expect(kidWakes(fired.id)).toHaveLength(1);
  await waits.tick();
  expect(status(holds.id)).toBe("fired");
  // The agent ends: its own waits go, the one the owner set by hand stays.
  const mine = waits.create(kid.id, waits.normalize({ kind: "timer", seconds: 300 }, dir));
  const owners = waits.create(kid.id, waits.normalize({ kind: "timer", seconds: 300 }, dir), { by: "owner" });
  expect([...waits.cancelForSession(kid.id, "agent ended", { keepOwner: true })]).toContain(owners.id);
  expect([status(mine.id), status(owners.id)]).toEqual(["cancelled", "active"]);
  waits.cancel(owners.id);
});
