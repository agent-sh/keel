import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ackNotices, adoptJobs, drainNotices, findJob, jobsOf, procfs, running, startJob, stopJob, takeUnread, waitJob } from "./jobs.ts";

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
