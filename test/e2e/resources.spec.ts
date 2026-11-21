import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: Settings > Resources shows the daemon and the processes it started,
// a command a session's tool runs in the background is booked to that session,
// and the memory and CPU of the last hour are charted. A command's descendant
// that called setsid and lost its parent is still counted, from the job's cgroup.
test("resources view", async ({ page, request }) => {
  const cmd = `sleep ${100 + Math.floor(Math.random() * 800)}`;
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const s = (await (await request.post("/api/sessions", {
    data: { model: HAIKU, title: "Resources check", text: `Start \`${cmd}\` in the background with your shell tool (run_in_background), then reply with the word started.` },
  })).json()).session;
  await expect.poll(async () => {
    const r = await (await request.get(`/api/resources?session_id=${s.id}&refresh=1`)).json();
    return r.processes.some((p: any) => p.command.includes(cmd) && p.kind === "tool");
  }, { timeout: 120_000 }).toBe(true);
  const orphan = `sleep ${1000 + Math.floor(Math.random() * 800)}`;
  await request.post(`/api/sessions/${s.id}/terminal/run`, { data: { command: `(setsid ${orphan} &); sleep 900` } });
  await expect.poll(async () => {
    const r = await (await request.get(`/api/resources?session_id=${s.id}&refresh=1`)).json();
    const p = r.processes.find((x: any) => x.name === "sleep" && x.command === orphan);
    return !!p && r.jobs.some((j: any) => j.contain === "cgroup" && j.pids.includes(p.pid) && j.memory_bytes > 0);
  }, { timeout: 20_000 }).toBe(true);

  await page.goto("/settings/resources");
  const panel = page.getByTestId("resources-panel");
  await expect(panel.getByTestId("tile-memory")).not.toContainText("none");
  const row = panel.getByTestId("process-row").filter({ hasText: cmd }).first();
  await expect(row).toContainText("Resources check");
  await expect(panel.getByTestId("resources-sessions")).toContainText("Resources check");
  await shoot(page, "resources-01");
  await panel.getByTestId("resources-processes").scrollIntoViewIfNeeded();
  await shoot(page, "resources-02-processes");

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
