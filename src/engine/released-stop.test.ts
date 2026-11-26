// The owner's Stop of a session ends the commands a restart let run on from in front of its calls, as those
// calls would have ended them. After the restart such a command was a background command of the session, and
// the owner's Stop no longer ended it. Another stopper's stop leaves it running.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { adoptJobs, jobsOf, running, stopJob, waitJob } from "../tools/jobs.ts";
import { Engine } from "./turn.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("the owner's Stop ends a command a restart let run on, another stop does not", async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "released-stop-"));
  dirs.push(dir);
  const store = new Store(dir);
  const s = store.createSession({ model: "p:m", workspace: dir });
  const logDir = join(dir, "spill", s.id, "jobs");
  // The daemon before: a command in front of a call, let run on by a restart.
  const code = `
    import { releaseFronts, startJob } from ${JSON.stringify(join(import.meta.dir, "../tools/jobs.ts"))};
    startJob({ sessionId: ${JSON.stringify(s.id)}, command: "sleep 30", cwd: ${JSON.stringify(dir)}, logDir: ${JSON.stringify(logDir)}, callId: "build", stops: true });
    releaseFronts();
    process.exit(0);`;
  expect(await Bun.spawn(["bun", "-e", code], { stdout: "ignore", stderr: "inherit" }).exited).toBe(0);
  adoptJobs(join(dir, "spill"));
  const j = jobsOf(s.id).find((x) => x.callId === "build")!;
  const engine = new Engine(store, new Bus(), {} as any, { capture: (_s: string, e: unknown) => ({ message: String(e) }), recovered: () => {} } as any, join(dir, "spill"));
  try {
    await engine.interrupt(s.id, "api");
    expect(running(j)).toBe(true);
    await engine.interrupt(s.id, "owner");
    expect(await waitJob(j, 4000)).toBe(true);
  } finally {
    for (const x of jobsOf(s.id)) await stopJob(x);
    store.db.close();
  }
});
