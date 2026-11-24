import { expect, test } from "./isolate.ts";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { HAIKU, ask, scrollsSideways, shoot } from "./shots.ts";

// Feature: Settings > Resources shows the daemon and the processes it started,
// a command a session's tool runs in the background is booked to that session,
// and the memory and CPU of the last hour are charted. A command's descendant
// that called setsid and lost its parent is still counted, from the job's cgroup.
test("resources view", async ({ page, request }) => {
  const cmd = `sleep ${100 + Math.floor(Math.random() * 800)}`;
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const s = (await (await request.post("/api/sessions", {
    data: { model: HAIKU, title: "Resources check", text: ask(`Start \`${cmd}\` in the background with your shell tool (run_in_background), then reply with the word started.`, `script:calls [{"name":"Bash","input":{"command":"${cmd}","run_in_background":true}}]`) },
  })).json()).session;
  await expect.poll(async () => {
    const r = await (await request.get(`/api/resources?session_id=${s.id}&refresh=1`)).json();
    return r.processes.some((p: any) => p.command.includes(cmd) && p.kind === "tool");
  }, { timeout: 120_000 }).toBe(true);
  // The orphan part needs a cgroup per job, which takes a systemd user manager. Whether
  // there is one is asked here, of this run's own environment (the daemon of a run
  // shares it), never of the daemon: with a manager, a job without a cgroup fails.
  const orphan = `sleep ${1000 + Math.floor(Math.random() * 800)}`;
  const manager = spawnSync("systemctl", ["--user", "show", "-p", "ControlGroup", "--value", "app.slice"], { encoding: "utf8" });
  if (existsSync("/sys/fs/cgroup/cgroup.controllers") && manager.status === 0 && manager.stdout.trim().startsWith("/")) {
    await request.post(`/api/sessions/${s.id}/terminal/run`, { data: { command: `(setsid ${orphan} &); sleep 900` } });
    await expect.poll(async () => {
      const r = await (await request.get(`/api/resources?session_id=${s.id}&refresh=1`)).json();
      const p = r.processes.find((x: any) => x.name === "sleep" && x.command === orphan);
      return !!p && r.jobs.some((j: any) => j.contain === "cgroup" && j.pids.includes(p.pid) && j.memory_bytes > 0);
    }, { timeout: 20_000 }).toBe(true);
  } else test.info().annotations.push({ type: "not checked", description: "an orphaned descendant counted from the job's cgroup: this run has no systemd user manager to give a job one" });

  await page.goto("/settings/resources");
  const panel = page.getByTestId("resources-panel");
  await expect(panel.getByTestId("tile-memory")).not.toContainText("none");
  const row = panel.getByTestId("process-row").filter({ hasText: cmd }).first();
  await expect(row).toContainText("Resources check");
  await expect(panel.getByTestId("resources-sessions")).toContainText("Resources check");
  await shoot(page, "resources-01");
  await panel.getByTestId("resources-processes").scrollIntoViewIfNeeded();
  await shoot(page, "resources-02-processes");
  // A phone: the tables fit their boxes, and what they dropped is listed under each row.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel.getByTestId("resources-processes").locator("dl").first()).toContainText("Threads");
  expect(await scrollsSideways(panel.getByTestId("resources-processes"))).toEqual([]);
  expect(await scrollsSideways(panel.getByTestId("resources-sessions"))).toEqual([]);
  await shoot(page, "resources-03-narrow");
  await page.setViewportSize({ width: 1280, height: 720 });

  // Deleting the session stops its commands.
  await request.delete(`/api/sessions/${s.id}`);
  await expect.poll(async () => (await (await request.get("/api/resources?refresh=1")).json()).processes.some((p: any) => p.command.includes(cmd) || p.command === orphan)).toBe(false);
  await request.put("/api/permissions/settings", { data: { default_mode: prev } });
});

// The panel reads the daemon every five seconds. With a slow answer and a
// hidden tab: one request at a time, none while hidden, and one at once when
// the tab shows again. The page's clock is driven by the test.
test("the resources panel waits for a slow answer and rests while hidden", async ({ page }) => {
  let started = 0, flying = 0, most = 0;
  let hold: Promise<void> | undefined;
  let every: number | undefined; // the interval the next answers claim, to see the panel take them
  let lost = false; // the next request gets no answer at all
  await page.route(/\/api\/resources\?/, async (route) => {
    started++;
    if (lost) return void (lost = false);
    most = Math.max(most, ++flying);
    const answer = await route.fetch();
    await hold;
    flying--;
    if (every === undefined) return route.fulfill({ response: answer });
    await route.fulfill({ response: answer, json: { ...(await answer.json()), interval_ms: every } });
  });
  const visibility = (state: "hidden" | "visible") => page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
  await page.clock.install();
  await page.goto("/settings/resources");
  const panel = page.getByTestId("resources-panel");
  await expect(panel.getByTestId("tile-memory")).not.toContainText("none");
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await expect.poll(() => flying).toBe(0);
  const base = started;

  // The next answer is slow: the ticks that pass meanwhile start nothing more.
  let release!: () => void;
  hold = new Promise<void>((r) => (release = r));
  await page.clock.runFor(5000);
  await expect.poll(() => started).toBe(base + 1);
  await page.clock.runFor(11_000);
  await page.waitForTimeout(300);
  expect([started, most]).toEqual([base + 1, 1]);
  every = 77_000;
  release();
  hold = undefined;
  await expect(panel).toContainText("every 77 s");
  await expect.poll(() => flying).toBe(0);

  // Hidden: twenty seconds of ticks ask for nothing.
  await visibility("hidden");
  await page.clock.runFor(20_000);
  await page.waitForTimeout(300);
  expect(started).toBe(base + 1);
  // Shown again: read at once, with no tick, and the panel takes the answer.
  every = 33_000;
  await visibility("visible");
  await expect.poll(() => started).toBe(base + 2);
  await expect(panel).toContainText("every 33 s");
  // And the five-second reads go on.
  await expect.poll(() => flying).toBe(0);
  await page.clock.runFor(5000);
  await expect.poll(() => started).toBe(base + 3);
  expect(most).toBe(1);
  // A request that never gets an answer is given up after fifteen seconds: the reads go on.
  await expect.poll(() => flying).toBe(0);
  lost = true;
  await page.clock.runFor(5000);
  await expect.poll(() => started).toBe(base + 4);
  await page.clock.runFor(10_000);
  await page.waitForTimeout(300);
  expect(started).toBe(base + 4);
  every = 55_000;
  await page.clock.runFor(10_000);
  await expect.poll(() => started).toBeGreaterThan(base + 4);
  await expect(panel).toContainText("every 55 s");
  await shoot(page, "resources-03-polling");
});

// The daemon says once when its memory stepped by over 200 MB in 10 s, with the split it has and what ran then.
// The daemon has no step to show on a scripted run, so the report is the same answer with one in it.
test("the resources panel notes a step of the daemon's memory", async ({ page, request }) => {
  const real = await (await request.get("/api/resources?refresh=1")).json();
  expect(Array.isArray(real.daemon.steps)).toBe(true);
  let steps: unknown[] | undefined;
  await page.route(/\/api\/resources\?/, async (route) => {
    const answer = await route.fetch();
    const body = await answer.json();
    await route.fulfill({ response: answer, json: steps ? { ...body, daemon: { ...body.daemon, steps } } : body });
  });
  await page.goto("/settings/resources");
  const panel = page.getByTestId("resources-panel");
  await expect(panel.getByTestId("tile-memory")).not.toContainText("none");
  // (A scratch daemon may have told a step of its own while it started: the mocked one below replaces it.)
  const MB = 1024 * 1024, now = Date.now();
  steps = [{
    at_ms: now - 60_000, from_ms: now - 65_000, from_bytes: 520 * MB, to_bytes: 1000 * MB, heap_bytes: 164 * MB, memory: { anon_bytes: 900 * MB, file_bytes: 90 * MB },
    running: { turns: 2, readers: 3, run_code: 1, acp_agents: 0, cold_reads: { n: 4, rows: 9000, ms: 80 }, body_reads: { n: 7, rows: 300, bytes: 1_000_000, ms: 20 }, processes: [], spawned: [{ label: "bun -e", kind: "tool", rss_bytes: 80 * MB }] },
  }];
  await page.reload();
  const note = panel.getByTestId("resources-step");
  await expect(note).toContainText("memory grew 480 MB in 5 s");
  await expect(note).toContainText("heap 164 MB, kernel anon 900 MB");
  await expect(note).toContainText("2 turns, 3 readers, 1 run_code program, 0 ACP agents, 4 whole-session reads and 7 body reads on the loop, 1 process started");
  await shoot(page, "resources-05-step");
});

// The daemon's report says what of it is in swap (its own process, and its unit from the cgroup's
// memory.swap.current). The panel says nothing while that is zero, and says how much and what it
// costs when it is not. The daemon's own answer is shown first; the swapped one is the same answer
// with the numbers a swapped unit reports.
test("the resources panel says when the daemon's memory is in swap", async ({ page, request }) => {
  const real = await (await request.get("/api/resources?refresh=1")).json();
  expect(typeof real.daemon.swap.process_bytes).toBe("number");
  let swap: Record<string, number | string | boolean> | undefined;
  await page.route(/\/api\/resources\?/, async (route) => {
    const answer = await route.fetch();
    const body = await answer.json();
    await route.fulfill({ response: answer, json: swap ? { ...body, daemon: { ...body.daemon, swap } } : body });
  });
  await page.goto("/settings/resources");
  const panel = page.getByTestId("resources-panel");
  await expect(panel.getByTestId("tile-memory")).not.toContainText("none");
  if (!real.daemon.swap.process_bytes && !real.daemon.swap.unit_bytes) await expect(panel.getByTestId("resources-swap")).toHaveCount(0);

  // The daemon's own service has pages in swap and no limit on it: the panel says how much, and the setting that stops it.
  swap = { process_bytes: 0, unit_bytes: 73 * 1024 * 1024, unit: "keel-bun.service", own: true };
  await page.reload();
  const line = panel.getByTestId("resources-swap");
  await expect(line).toContainText("73 MB of the daemon's unit (keel-bun.service) is in swap");
  await expect(line).toContainText("add MemorySwapMax=0 under [Service] of the unit (systemctl --user edit keel-bun.service)");
  await expect(line).not.toContainText("keel service install");
  await shoot(page, "resources-03-swap");
  // The daemon's own pages: named as the daemon's. A unit that may not swap is not told to set what it has.
  swap = { process_bytes: 12 * 1024 * 1024, unit_bytes: 73 * 1024 * 1024, unit_limit_bytes: 0, unit: "keel-bun.service", own: true };
  await page.reload();
  await expect(line).toContainText("12 MB of the daemon is in swap");
  await expect(line).not.toContainText("MemorySwapMax");
  // Started from a terminal: the scope's swap is other programs' too, and is not shown as the daemon's.
  swap = { process_bytes: 0, unit_bytes: 900 * 1024 * 1024, unit: "vte-spawn-1.scope", own: false };
  await page.reload();
  await expect(panel.getByTestId("tile-memory")).not.toContainText("none");
  await expect(line).toHaveCount(0);
  // Its own pages there are, with why nothing keeps them in memory.
  swap = { process_bytes: 12 * 1024 * 1024, unit_bytes: 900 * 1024 * 1024, unit: "vte-spawn-1.scope", own: false };
  await page.reload();
  await expect(line).toContainText("12 MB of the daemon is in swap");
  await expect(line).toContainText("started from a terminal (it runs in vte-spawn-1.scope)");
  await shoot(page, "resources-04-swap-terminal");
});
