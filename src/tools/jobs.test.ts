import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stopKind } from "../core/stops.ts";
import { ackNotices, adoptJobs, cutCommand, drainNotices, findJob, jobsOf, procfs, running, startJob, stopJob, takeUnread, toolEnv, waitJob } from "./jobs.ts";

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
    expect(runs).toBe(`The daemon restarted while this command ran. The command was not interrupted: it still runs in the background (PID ${of("runs").pid}). Its output is being written to ${of("runs").log}. Do not start it again: a notice comes when it ends.`);
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
