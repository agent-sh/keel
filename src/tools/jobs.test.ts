import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stopKind } from "../core/stops.ts";
import { ackNotices, adoptJobs, awaited, cutCommand, drainNotices, jobEnded, findJob, jobsOf, procfs, running, startJob, stopJob, takeUnread, toolEnv, waitJob } from "./jobs.ts";

// A daemon that starts background commands and exits (a restart); this
// process plays the next daemon.
async function previousDaemon(root: string, commands: string[]) {
  const code = `
    import { startJob } from ${JSON.stringify(join(import.meta.dir, "jobs.ts"))};
    for (const c of ${JSON.stringify(commands)}) startJob({ sessionId: "s1", command: c, cwd: ${JSON.stringify(root)}, logDir: ${JSON.stringify(join(root, "spill/s1/jobs"))}, background: true });
    process.exit(0);`;
  const p = Bun.spawn(["bun", "-e", code], { stdout: "ignore", stderr: "inherit" });
  expect(await p.exited).toBe(0);
}

test("background commands outlive a daemon restart and are adopted by the next one", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "jobs-"));
  await previousDaemon(root, ["echo quick-done", "echo first; sleep 1.5; echo slow-done; exit 3"]);
  // The quick one ends while no daemon runs.
  const deadline = Date.now() + 5000;
  while (!existsSync(join(root, "spill/s1/jobs")) && Date.now() < deadline) await Bun.sleep(20);
  await Bun.sleep(300);

  expect(adoptJobs(join(root, "spill"))).toBe(2);
  const quick = findJob("s1", 1)!;
  const slow = findJob("s1", 2)!;
  expect(running(slow)).toBe(true);
  expect(await waitJob(slow, 5000)).toBe(true);
  expect(slow.exitCode).toBe(3);
  expect(running(quick)).toBe(false);
  expect(quick.exitCode).toBe(0);
  const drained = drainNotices("s1");
  const notes = drained.map((n) => n.text).join("\n");
  expect(notes).toContain("exited with code 0");
  expect(notes).toContain("exited with code 3");
  expect(takeUnread(slow)).toContain("slow-done");
  // Reported once the notes are stored: a third daemon does not report them again.
  ackNotices(drained);
  expect(adoptJobs(join(root, "spill"))).toBe(0);
});

test("after a restart a job goes on from what the model read, its end is said once, and its handle stays its own", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "jobs-"));
  const dir = join(root, "spill/s2/jobs");
  // The previous daemon: one job it read the first line of, one that ended
  // before its note was stored.
  const code = `
    import { startJob, takeUnread, waitJob } from ${JSON.stringify(join(import.meta.dir, "jobs.ts"))};
    const o = { sessionId: "s2", cwd: ${JSON.stringify(root)}, logDir: ${JSON.stringify(dir)}, background: true };
    const done = startJob({ ...o, command: "printf done" });
    const slow = startJob({ ...o, command: "printf 'one\\\\n'; sleep 0.8; printf 'two\\\\n'; sleep 0.8; printf 'three\\\\n'" });
    await waitJob(done, 3000);
    const until = Date.now() + 3000;
    let seen = "";
    while (!seen.includes("one") && Date.now() < until) { seen += takeUnread(slow); await Bun.sleep(20); }
    process.exit(seen.includes("one") ? 0 : 1);`;
  const p = Bun.spawn(["bun", "-e", code], { stdout: "ignore", stderr: "inherit" });
  expect(await p.exited).toBe(0);
  adoptJobs(join(root, "spill"));
  const [done, slow] = [...jobsOf("s2")].sort((a, b) => a.num - b.num);
  expect(await waitJob(slow!, 5000)).toBe(true);
  expect(takeUnread(slow!)).toBe("two\nthree\n");
  const notes = drainNotices("s2");
  expect(notes.filter((n) => n.job === done!.id)).toHaveLength(1);
  ackNotices(notes);
  // The ended job still answers to its IDs; a new one takes a new number.
  expect(findJob("s2", done!.id)?.log).toBe(done!.log);
  const next = startJob({ sessionId: "s2", command: "true", cwd: root, logDir: dir });
  expect(next.num).toBeGreaterThan(slow!.num);
  expect(findJob("s2", done!.num)?.id).toBe(done!.id);
});

test("a read past the cap keeps the start and the end, and says what it left out", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "jobs-"));
  const j = startJob({ sessionId: "s3", command: "printf FIRST-LINE; head -c 2000000 /dev/zero | tr '\\0' x; printf LAST-LINE", cwd: root, logDir: join(root, "jobs") });
  expect(await waitJob(j, 10_000)).toBe(true);
  const out = takeUnread(j);
  expect(out.startsWith("FIRST-LINE")).toBe(true);
  expect(out.endsWith("LAST-LINE")).toBe(true);
  expect(out).toContain(`bytes not shown here; the whole output is in ${j.log}`);
  expect(j.taken).toBe(2_000_019);
});

// A job whose process has ended and stays as a zombie (its parent never reads its end) is over.
// A synthetic pid: nothing is signalled for real.
test("an adopted job whose process is a zombie has ended; one with a thread left still runs", async () => {
  const pid = 987654322;
  const real = { kill: process.kill, stat: procfs.stat };
  let threads = 2;
  procfs.stat = (p: number) => { if (p !== pid) return real.stat(p); const f = Array(50).fill("0"); f[0] = "Z"; f[17] = String(threads); f[19] = "100"; return `${pid} (fixture) ${f.join(" ")}`; };
  process.kill = ((p: number, s: any = 0) => (Math.abs(p) === pid ? true : real.kill(p, s))) as typeof process.kill;
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "jobs-zombie-"));
  const dir = join(root, "spill", "s-zombie", "jobs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "fixture-zombie.log"), "");
  writeFileSync(join(dir, "fixture-zombie.json"), JSON.stringify({ id: "fixture-zombie", num: 901, sessionId: "s-zombie", command: "nothing runs", cwd: root, started: Date.now(), background: true, pid, boot: "100" }));
  try {
    adoptJobs(join(root, "spill"));
    const job = jobsOf("s-zombie")[0]!;
    expect(running(job)).toBe(true);
    threads = 1;
    for (let i = 0; i < 40 && running(job); i++) await Bun.sleep(100);
    expect(running(job)).toBe(false);
  } finally {
    process.kill = real.kill;
    procfs.stat = real.stat;
  }
});

// A stop signals the job's process only while it is still the one the job
// started as: its start time is read right before each signal. A pid reused
// after adoption (or before it) gets nothing, and the job ends as gone.
// A synthetic pid and a kill spy: nothing is signalled for real.
test("a stop signals only the process the job started as", async () => {
  const pid = 987654321;
  const stat = (start: string) => { const f = Array(50).fill("0"); f[19] = start; return `${pid} (fixture) ${f.join(" ")}`; };
  const real = { kill: process.kill, stat: procfs.stat };
  for (const [name, atAdopt, atStop, signals] of [
    ["matched", "100", "100", ["SIGTERM"]],
    ["changed after adoption", "100", "200", []],
    ["changed before adoption", "200", "200", []],
  ] as const) {
    const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "jobs-stop-"));
    const dir = join(root, "spill", `s-${name}`, "jobs");
    mkdirSync(dir, { recursive: true });
    const id = `fixture-${name.replace(/ /g, "-")}`;
    writeFileSync(join(dir, `${id}.log`), "");
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, num: 900, sessionId: `s-${name}`, command: "nothing runs", cwd: root, started: Date.now(), background: true, pid, boot: "100" }));
    let start: string = atAdopt;
    let alive = true;
    const sent: string[] = [];
    procfs.stat = (p: number) => { if (p !== pid || !alive) throw new Error("no such process"); return stat(start); };
    process.kill = ((p: number, s: any = 0) => {
      if (Math.abs(p) !== pid) return real.kill(p, s);
      if (s === 0) { if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" }); return true; }
      sent.push(String(s));
      alive = false;
      return true;
    }) as typeof process.kill;
    try {
      adoptJobs(join(root, "spill"));
      const job = jobsOf(`s-${name}`)[0]!;
      start = atStop;
      await stopJob(job, "was stopped");
      expect([name, sent]).toEqual([name, [...signals]]);
      expect(running(job)).toBe(false);
    } finally {
      process.kill = real.kill;
      procfs.stat = real.stat;
    }
  }
});

test("a command reaches the shell as written: its own braced variables and exit code survive the job scope", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "jobs-"));
  const j = startJob({ sessionId: "s-expand", command: 'x=5; a=(p q); echo "[${x}][${a[1]}][${#x}][$$]" | grep -c "\\[5\\]\\[q\\]\\[1\\]\\[[0-9]"; exit 7', cwd: root, logDir: join(root, "spill/s-expand/jobs") });
  expect(await waitJob(j, 10000)).toBe(true);
  expect(takeUnread(j).trim()).toBe("1");
  expect(j.exitCode).toBe(7);
});

test("a session's command gets no pager, whichever tool starts it and with a terminal too", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "jobs-"));
  const command = 'echo "$PAGER/$GIT_PAGER/$SYSTEMD_PAGER/$DPKG_PAGER/$MANPAGER"';
  // The default environment, one a tool hands over, and a terminal: none may bring a pager back.
  for (const o of [{}, { env: { ...(process.env as Record<string, string>), PAGER: "less", GIT_PAGER: "less" } }, { pty: true }]) {
    const j = startJob({ sessionId: "s-pager", command, cwd: root, logDir: join(root, "spill/s-pager/jobs"), ...o });
    expect(await waitJob(j, 10000)).toBe(true);
    expect(takeUnread(j).trim()).toBe("cat/cat/cat/cat/cat");
  }
});

test("a command does not get the daemon's own supervision settings", () => {
  const keep = { ...process.env };
  Object.assign(process.env, { KEEL_SUPERVISED: "systemd", KEEL_DRAIN_MS: "600000", KEEL_GH_BIN: "/x/gh" });
  try {
    const env = toolEnv("s1");
    expect(env.KEEL_SUPERVISED).toBeUndefined();
    expect(env.KEEL_DRAIN_MS).toBeUndefined();
    expect(env.KEEL_GH_BIN).toBe("/x/gh");
    expect(env.KEEL_SESSION).toBe("s1");
  } finally {
    for (const k of ["KEEL_SUPERVISED", "KEEL_DRAIN_MS", "KEEL_GH_BIN"]) if (keep[k] === undefined) delete process.env[k]; else process.env[k] = keep[k];
  }
});

// What a call a restart cut is told about its command: what became of it, never "interrupted" for one that runs.
test("a call a restart cut is told what became of its command: it runs on, it ended and how, or it was stopped", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "jobs-"));
  const dir = join(root, "spill/s9/jobs");
  // The daemon before: three commands in the foreground of three calls, then it is gone (a kill).
  const code = `
    import { startJob } from ${JSON.stringify(join(import.meta.dir, "jobs.ts"))};
    const o = { sessionId: "s9", cwd: ${JSON.stringify(root)}, logDir: ${JSON.stringify(dir)}, stops: true };
    startJob({ ...o, command: "sleep 30", callId: "runs", handle: "pid" });
    startJob({ ...o, command: "sleep 0.3; exit 4", callId: "ended" });
    startJob({ ...o, command: "sleep 30", callId: "exec", handle: "num" });
    process.exit(0);`;
  expect(await Bun.spawn(["bun", "-e", code], { stdout: "ignore", stderr: "inherit" }).exited).toBe(0);
  await Bun.sleep(900);
  adoptJobs(join(root, "spill"));
  const jobs = jobsOf("s9");
  const of = (call: string) => jobs.find((j) => j.callId === call)!;
  try {
    // One that outlived the daemon: named by its family's handle, with its log, and not to be started again.
    const runs = cutCommand("s9", "runs")!;
    expect(runs).toBe(`The daemon restarted while this command ran. The command was not interrupted: it still runs in the background (PID ${of("runs").pid}). Its output is being written to ${of("runs").log}. Do not start it again: you are told when it ends.`);
    expect(cutCommand("s9", "exec")).toContain(`(session ID ${of("exec").num})`);
    expect(running(of("runs"))).toBe(true);
    // One that ended while no daemon ran: its exit code, and no second telling of its end.
    expect(cutCommand("s9", "ended")).toMatch(/^The daemon restarted while this command ran\. The command was not interrupted: it exited with code 4 after \d+ s\. Its output is in .*\.log\. Do not run it again for its result\.$/);
    expect(drainNotices("s9")).toEqual([]);
    // A call that started no command: nothing is known here.
    expect(cutCommand("s9", "no-such-call")).toBeUndefined();
    // Each reads as a cut call, not a failed one.
    expect(stopKind(runs)).toBe("cut");
    // While this daemon stops: a command its call stops says so, and an exec session without a terminal goes on.
    const mine = startJob({ sessionId: "s9", command: "sleep 30", cwd: root, logDir: dir, callId: "parked", stops: true });
    const session = startJob({ sessionId: "s9", command: "sleep 30", cwd: root, logDir: dir, callId: "session", handle: "num" });
    expect(cutCommand("s9", "parked")).toMatch(/^The daemon restarted while this command ran\. The restart stopped the command after \d+ s, before it finished\. Its output up to then is in .*\. Run it again if its work is still needed\.$/);
    expect(cutCommand("s9", "session")).toContain(`it still runs in the background (session ID ${session.num})`);
    await stopJob(mine, "was interrupted");
    await stopJob(session);
    // Asked again after its stop: it says how it ended.
    expect(cutCommand("s9", "parked")).toContain("The command was interrupted after");
  } finally {
    for (const j of jobsOf("s9")) await stopJob(j);
  }
});

test("a stop the last daemon began and did not see through is finished by the next one", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "jobs-"));
  const dir = join(root, "spill/s10/jobs");
  // The daemon before asked a command that ignores the first signal to stop, and went down at once.
  const code = `
    import { startJob, stopJob } from ${JSON.stringify(join(import.meta.dir, "jobs.ts"))};
    const j = startJob({ sessionId: "s10", cwd: ${JSON.stringify(root)}, logDir: ${JSON.stringify(dir)}, command: "trap '' TERM; sleep 30 & wait; sleep 30", callId: "c1", stops: true });
    await Bun.sleep(300);
    void stopJob(j, "was interrupted");
    await Bun.sleep(100);
    process.exit(0);`;
  expect(await Bun.spawn(["bun", "-e", code], { stdout: "ignore", stderr: "inherit" }).exited).toBe(0);
  adoptJobs(join(root, "spill"));
  const j = jobsOf("s10")[0]!;
  // What ignored the first signal is still there, and is ended: nothing of the command's group is left.
  const groupLeft = () => { try { process.kill(-j.pid, 0); return true; } catch { return false; } };
  expect(groupLeft()).toBe(true);
  for (const until = Date.now() + 8000; groupLeft() && Date.now() < until; ) await Bun.sleep(50);
  expect(groupLeft()).toBe(false);
  expect(running(j)).toBe(false);
  // Its call was told it was stopped: its end makes no note of its own.
  expect(drainNotices("s10")).toEqual([]);
});

// --- what a cut call is told is looked at first (the review's schedules)

// A daemon before this one, as a process of its own: it starts commands and is killed, or stops them and exits.
// `env`: what decides how its commands are held (with no user manager to ask, the process group).
async function daemonBefore(code: string, env: Record<string, string> = {}): Promise<number> {
  const p = Bun.spawn(["bun", "-e", code], { stdout: "ignore", stderr: "inherit", env: { ...process.env, ...env } });
  return p.exited;
}
const JOBS = JSON.stringify(join(import.meta.dir, "jobs.ts"));
// No systemd user manager is reached: a job is held by its process group, as on a machine without one.
const GROUP = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent/bus", XDG_RUNTIME_DIR: mkdtempSync(join(process.env.TMPDIR ?? ".", "norun-")) };
// The processes whose command line ends with one of these lengths of sleep (each test has its own).
const sleeping = (...lengths: string[]) => Bun.spawnSync(["ps", "-eo", "pid,args"], { stdout: "pipe" }).stdout.toString().split("\n").filter((l) => lengths.some((n) => l.trimEnd().endsWith(`sleep ${n}`)));
const until = async (ok: () => boolean, ms = 8000) => { for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await Bun.sleep(50); return ok(); };

test("a command in a terminal that ignores the hangup is not told it ended while it runs: what outlived the terminal is ended first", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "jobs-"));
  const dir = join(root, "spill/s11/jobs");
  // Codex's exec_command with a terminal; the command ignores the hangup; the daemon is killed during the call.
  const code = `
    import { startJob } from ${JOBS};
    startJob({ sessionId: "s11", cwd: ${JSON.stringify(root)}, logDir: ${JSON.stringify(dir)}, pty: true, handle: "num", callId: "tty", command: "trap '' HUP; sleep 311.01 & wait; sleep 311.02", argv: ["bash", "-c", "trap '' HUP; sleep 311.01 & wait; sleep 311.02"] });
    await Bun.sleep(700);
    process.kill(process.pid, "SIGKILL");`;
  expect(await daemonBefore(code)).toBe(137);
  try {
    // Its terminal is gone and it runs on: main said "may have partly run", the first cut of this said "it ended with the daemon".
    expect(sleeping("311.01", "311.02").length).toBeGreaterThan(0);
    adoptJobs(join(root, "spill"));
    const text = cutCommand("s11", "tty")!;
    expect(text).toMatch(/^The daemon restarted while this command ran\. It ran in a terminal the daemon held, so it ended with the daemon \((1 process of it had outlived the terminal and was|\d+ processes of it had outlived the terminal and were) ended at this start\), before it finished\. Its output up to then is in .*\.log\. Run it again if its work is still needed\.$/);
    // And that is so: nothing of it is alive when the sentence is given.
    expect(sleeping("311.01", "311.02")).toEqual([]);
    expect(running(jobsOf("s11")[0]!)).toBe(false);
  } finally {
    for (const l of sleeping("311.01", "311.02")) try { process.kill(Number(l.trim().split(/\s+/)[0]), "SIGKILL"); } catch {}
  }
});

test("a command that ended with a child still alive is told so, with the process and the way to stop it", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "jobs-"));
  const dir = join(root, "spill/s12/jobs");
  // In front, held by its process group only; it leaves a child in a session of its own and exits; the daemon is killed.
  const code = `
    import { startJob } from ${JOBS};
    startJob({ sessionId: "s12", cwd: ${JSON.stringify(root)}, logDir: ${JSON.stringify(dir)}, stops: true, callId: "left", command: "(setsid sleep 312.01 &); sleep 0.2; exit 0" });
    await Bun.sleep(900);
    process.kill(process.pid, "SIGKILL");`;
  expect(await daemonBefore(code, GROUP)).toBe(137);
  try {
    adoptJobs(join(root, "spill"));
    const j = jobsOf("s12")[0]!;
    const pid = Number(sleeping("312.01")[0]!.trim().split(/\s+/)[0]);
    expect(cutCommand("s12", "left")).toBe(`The daemon restarted while this command ran. The command's own process exited with code 0, but process ${pid} of it still runs. Do not run the command again before it is stopped: TaskStop with ID ${j.id}. Its output is in ${j.log}.`);
    // It reads as running, so the family's stop reaches it; after the stop nothing is left.
    expect(running(j)).toBe(true);
    expect(await stopJob(j)).toEqual([]);
    expect(sleeping("312.01")).toEqual([]);
    expect(running(j)).toBe(false);
  } finally {
    for (const l of sleeping("312.01")) try { process.kill(Number(l.trim().split(/\s+/)[0]), "SIGKILL"); } catch {}
  }
});

test("a stop ends a child that took a session of its own, also where only the process group holds the job", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "jobs-"));
  const dir = join(root, "spill/s13/jobs");
  // The restart's stop of a command in front: its call is told "The restart stopped the command". One child left the group.
  const code = `
    import { startJob, stopJob, cutCommand } from ${JOBS};
    import { writeFileSync } from "node:fs";
    const j = startJob({ sessionId: "s13", cwd: ${JSON.stringify(root)}, logDir: ${JSON.stringify(dir)}, stops: true, callId: "kids", command: "sleep 313.01 & (setsid sleep 313.02 &); wait" });
    await Bun.sleep(600);
    writeFileSync(${JSON.stringify(join(root, "told.txt"))}, cutCommand("s13", "kids") + "\\n" + j.contain);
    const left = await stopJob(j, "was interrupted");
    process.exit(left.length ? 3 : 0);`;
  expect(await daemonBefore(code, GROUP)).toBe(0);
  const [told, contain] = readFileSync(join(root, "told.txt"), "utf8").split("\n");
  expect(contain).toBe("group");
  expect(told).toMatch(/^The daemon restarted while this command ran\. The restart stopped the command after \d+ s, before it finished\./);
  // It said one child (the one in its own session) was still running after the stop.
  expect(sleeping("313.01", "313.02")).toEqual([]);
});

test("a stop a killed daemon left under way is finished at the start, and its call is told that; a stopped background command is still told", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "jobs-"));
  const dir = join(root, "spill/s14/jobs");
  const code = `
    import { startJob, stopJob } from ${JOBS};
    const o = { sessionId: "s14", cwd: ${JSON.stringify(root)}, logDir: ${JSON.stringify(dir)} };
    const front = startJob({ ...o, stops: true, callId: "front", command: "trap '' TERM; sleep 314.01 & wait; sleep 314.02" });
    const back = startJob({ ...o, background: true, callId: "back", command: "trap '' TERM; sleep 314.03 & wait; sleep 314.04" });
    await Bun.sleep(600);
    void stopJob(front, "was interrupted");
    void stopJob(back, "was stopped by the owner");
    await Bun.sleep(80);
    process.kill(process.pid, "SIGKILL");`;
  expect(await daemonBefore(code)).toBe(137);
  try {
    adoptJobs(join(root, "spill"));
    // The call of the one in front was cut with no result: it is not told the command "still runs".
    expect(cutCommand("s14", "front")).toMatch(/^The daemon restarted while this command ran\. The command was interrupted before the daemon went down, and that stop is finished at this start, before the command finished\. Its output up to then is in .*\. Run it again if its work is still needed\.$/);
    expect(await until(() => !sleeping("314.01", "314.02", "314.03", "314.04").length)).toBe(true);
    await until(() => jobsOf("s14").every((j) => !running(j)));
    // The background one's call had returned: the model hears of the owner's stop with one note. The other is told by its call.
    const notes = drainNotices("s14");
    expect(notes.map((n) => n.text)).toEqual([expect.stringMatching(/^Background command `trap '' TERM; sleep 314\.03 & wait; sleep 314\.04` \(ID \w+\) was stopped by the owner\. Output: /)]);
  } finally {
    for (const l of sleeping("314.01", "314.02", "314.03", "314.04")) try { process.kill(Number(l.trim().split(/\s+/)[0]), "SIGKILL"); } catch {}
  }
});

test("the end of a command a cut call was waiting on starts a turn, is told with its real run time, and belongs to its own turn", async () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? ".", "jobs-"));
  const dir = join(root, "spill/s15/jobs");
  const code = `
    import { startJob } from ${JOBS};
    const o = { sessionId: "s15", cwd: ${JSON.stringify(root)}, logDir: ${JSON.stringify(dir)}, stops: true };
    startJob({ ...o, callId: "quick", command: "sleep 0.4; echo done-quick; exit 0" });
    startJob({ ...o, callId: "late", command: "sleep 2.5; echo first; echo done-late; exit 7" });
    await Bun.sleep(200);
    process.kill(process.pid, "SIGKILL");`;
  expect(await daemonBefore(code)).toBe(137);
  // The quick one ends while no daemon runs, well before the next one looks.
  await Bun.sleep(1500);
  const woke: { id: string; text: string; sent: () => void }[] = [];
  jobEnded.tell = (job, text, sent) => { woke.push({ id: job.id, text, sent }); return true; };
  try {
    const t0 = Date.now();
    adoptJobs(join(root, "spill"));
    // It ran for 0.4 s, not until this start found it (it read "after 2 s").
    expect(cutCommand("s15", "quick")).toMatch(/it exited with code 0 after [01] s\./);
    const late = jobsOf("s15").find((j) => j.callId === "late")!;
    expect(cutCommand("s15", "late")).toBe(`The daemon restarted while this command ran. The command was not interrupted: it still runs in the background (ID: ${late.id}). Its output is being written to ${late.log}. Do not start it again: you are told when it ends.`);
    // A call of a later turn with the same id started no command of its own.
    expect(cutCommand("s15", "late", { since: Date.now() + 1000 })).toBeUndefined();
    // Its session is still waiting on it; and its end is an input that starts a turn, not a note for some later request.
    expect(awaited("s15").map((j) => j.id)).toEqual([late.id]);
    expect(await waitJob(late, 8000)).toBe(true);
    expect(woke).toHaveLength(1);
    expect(woke[0]!.text).toMatch(new RegExp(`^\\[harness\\] The command you were running when the daemon restarted has ended, after [23] s: \`sleep 2\\.5; echo first; echo done-late; exit 7\` \\(ID ${late.id}\\) exited with code 7\\. Its output is in ${late.log.replace(/[.]/g, "\\.")}; it ends with:\nfirst\ndone-late$`));
    expect(drainNotices("s15")).toEqual([]);
    // Until the input is stored the session is still owed that turn (an agent is not "completed" before it).
    expect(awaited("s15").map((j) => j.id)).toEqual([late.id]);
    woke[0]!.sent();
    expect(awaited("s15")).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(8000);
  } finally {
    jobEnded.tell = undefined;
    for (const j of jobsOf("s15")) await stopJob(j);
  }
});
