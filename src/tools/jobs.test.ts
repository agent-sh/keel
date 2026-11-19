import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { ackNotices, adoptJobs, drainNotices, findJob, jobsOf, running, startJob, takeUnread, waitJob } from "./jobs.ts";

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
