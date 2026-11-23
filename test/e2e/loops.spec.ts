import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, scriptBash, shoot } from "./shots.ts";

// Feature: `/loop 10m <prompt>` in the composer makes a loop that runs now and
// again on its interval; the Loops panel lists it with its run history; it can
// be paused, run by hand and deleted. A calendar loop shows its next times.
test("loops: /loop, history, pause, run now, calendar", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);

  await page.getByTestId("composer").fill("/loop 10m say only the word tick");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("loop-notice")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId("background-button")).toContainText("1 in background");
  await shoot(page, "loops-01-first-run");

  await page.getByTestId("background-button").click();
  await expect(page.getByTestId("bg-loop")).toContainText("every 10 minutes");
  await shoot(page, "loops-02-background");
  await page.keyboard.press("Escape");

  await page.getByTestId("loops-button").click();
  await expect(page.getByTestId("loops-panel")).toBeVisible();
  const item = page.getByTestId("loop-item").filter({ hasText: "say only the word tick" }).first();
  await item.click();
  await expect(page.getByTestId("loop-run")).toHaveCount(1);
  await shoot(page, "loops-03-panel");

  // Run by hand: a second run in the history.
  await item.hover();
  await item.getByTitle("Run now").click();
  await expect(page.getByTestId("loop-run")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId("loop-run").first()).not.toContainText("running", { timeout: 60_000 });

  // Pause.
  await item.hover();
  await item.getByTitle("Turn off").click();
  await expect(item).toContainText("paused");
  await shoot(page, "loops-04-paused");

  // A calendar loop made in the panel, in a session of its own.
  await page.getByTestId("new-loop-button").click();
  await page.getByTestId("new-loop-schedule").fill("weekdays 09:30");
  await page.getByTestId("new-loop-prompt").fill("Summarize yesterday's commits in this repository.");
  await page.getByRole("button", { name: "Create loop" }).click();
  await expect(page.getByTestId("loop-history")).toContainText("weekdays at 09:30");
  // Its times are in a named zone kept with it, shown beside them.
  await expect(page.getByTestId("loop-zone")).toHaveText(/\(\w+(\/[\w+-]+)*\)/);
  // Its next runs are on the 24-hour clock: no AM or PM after the time.
  await expect(page.getByTestId("loop-history")).toContainText(/next \w{3} 09:30,/);
  await expect(page.getByTestId("loop-history")).not.toContainText(/\d (AM|PM)\b/);
  await shoot(page, "loops-05-calendar");

  // Clean up: the loops end with the test.
  const { loops } = await (await request.get("/api/loops")).json();
  for (const l of loops) await request.delete(`/api/loops/${l.id}`);
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

const STAND_IN = "scripted:stand-in";

// A calendar loop made with a time zone of its own keeps it: its times are
// that zone's wall clock, whatever zone the daemon runs in.
test("loops: a calendar loop keeps the time zone it is made with", async ({ page, request }) => {
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === STAND_IN), "requires the scripted provider");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Zoned loop" } })).json();
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tz = here === "Pacific/Auckland" ? "America/New_York" : "Pacific/Auckland";
  const made = await request.post("/api/loops", { data: { session_id: session.id, schedule: "every day at 09:30", prompt: "Report the plan for the day.", tz } });
  expect(made.status()).toBe(201);
  const loop = await made.json();
  expect(loop.tz).toBe(tz);
  const wall = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
  expect([loop.next_ms, ...loop.next_runs].map(wall)).toEqual(["09:30", "09:30", "09:30", "09:30"]);

  const bad = await request.post("/api/loops", { data: { session_id: session.id, schedule: "every day at 09:30", prompt: "Never made.", tz: "Mars/Olympus" } });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).error).toContain("is not a time zone");
  expect((await (await request.get("/api/loops")).json()).loops.some((l: any) => l.prompt === "Never made.")).toBe(false);

  await page.goto(`/s/${session.id}`);
  await page.getByTestId("loops-button").click();
  await page.getByTestId("loop-item").filter({ hasText: "Report the plan for the day" }).first().click();
  await expect(page.getByTestId("loop-zone")).toContainText(`(${tz})`);
  await shoot(page, "loops-06-zone");
  await request.delete(`/api/loops/${loop.id}`);
});

// An edit is held to the limits a new loop is: a run cap that is not a whole
// number of at least 1, or a prompt over 8,000 characters, changes nothing.
test("loops: an edit keeps the limits of a new loop", async ({ request }) => {
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === STAND_IN), "requires the scripted provider");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Edited loop" } })).json();
  const loop = await (await request.post("/api/loops", { data: { session_id: session.id, schedule: "every day at 09:30", prompt: "Report the plan for the day.", max_runs: 5 } })).json();
  const read = async () => (await (await request.get(`/api/loops/${loop.id}/runs`)).json()).loop;
  const patch = (data: unknown) => request.patch(`/api/loops/${loop.id}`, { data });
  const before = await read();
  for (const data of [{ max_runs: 0 }, { max_runs: -2 }, { max_runs: 1.5 }, { prompt: "x".repeat(8001) }, { name: "Renamed", max_runs: 0 }]) {
    const r = await patch(data);
    expect(r.status(), JSON.stringify(data).slice(0, 40)).toBe(400);
    expect(await read()).toEqual(before);
  }
  expect((await (await patch({ max_runs: 3 })).json()).max_runs).toBe(3);
  expect((await (await patch({ max_runs: null })).json()).max_runs).toBeNull();
  expect((await (await patch({ prompt: "y".repeat(8000) })).json()).prompt).toHaveLength(8000);
  await request.delete(`/api/loops/${loop.id}`);
});

// A loop made in the panel says where its runs work and in what permission mode, the owner's
// default mode unless another is picked. A run that waits on the owner (an approval) says so on
// its row and in its history, the owner is alerted, and a run due meanwhile says why it was skipped.
test("loops: a panel loop names its folder and mode, and a run waiting on you says so", async ({ page, request }) => {
  test.setTimeout(180_000);
  const { models } = await (await request.get("/api/models")).json();
  test.skip(!models.some((m: { id: string }) => m.id === STAND_IN), "requires the scripted provider");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `loop-where-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  expect((await request.put("/api/permissions/settings", { data: { default_mode: "plan" } })).ok()).toBe(true);
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Loop host" } })).json();
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("loops-button").click();
  await page.getByTestId("new-loop-button").click();
  // The owner's default mode is the one offered.
  await expect(page.getByTestId("new-loop-mode")).toHaveText("Plan");
  await page.getByTestId("new-loop-where").getByTestId("workspace-picker").click();
  await page.getByPlaceholder(/Type a path/).fill(ws);
  await page.getByPlaceholder(/Type a path/).press("Enter");
  await page.getByTestId("use-folder").click();
  await expect(page.getByTestId("new-loop")).toBeVisible();
  await page.getByTestId("new-loop-mode").click();
  await page.getByRole("option", { name: "Ask", exact: true }).click();
  await expect(page.getByTestId("new-loop-asks")).toBeVisible();
  await page.getByTestId("new-loop-schedule").fill("1m");
  await page.getByTestId("new-loop-prompt").fill(`Touch a file.\n${scriptBash("touch loop-ran.txt")}`);
  await shoot(page, "loops-06-new-where");
  await page.getByRole("button", { name: "Create loop" }).click();
  await expect(page.getByTestId("loop-mode")).toHaveText("Ask");
  await expect(page.getByTestId("loop-where")).toContainText(ws);
  const loop = (await (await request.get("/api/loops")).json()).loops.find((l: any) => l.prompt.startsWith("Touch a file."));
  expect((await (await request.get(`/api/sessions/${loop.session_id}`)).json()).session.workspace).toBe(ws);
  expect((await (await request.get(`/api/sessions/${loop.session_id}/permissions`)).json()).perm.mode).toBe("ask");

  // Its first run asks for the command: the row says it waits for the owner, who is alerted.
  const item = page.getByTestId("loop-item").filter({ hasText: "Touch a file." });
  await item.hover();
  await item.getByTitle("Run now").click();
  await expect(item.getByTestId("loop-item-state")).toContainText("waits for an approval from you", { timeout: 30_000 });
  await expect(page.locator('[data-testid="loop-run"][data-waits]')).toContainText("waits for an approval from you");
  await expect.poll(async () => (await (await request.get("/api/alerts")).json()).alerts.some((a: any) => a.kind === "approval" && a.session_id === loop.session_id)).toBe(true);
  // Another run by hand is not offered; the run due meanwhile (a minute after the loop was made)
  // is skipped, and says what the run before it waits on.
  await item.hover();
  await expect(item.getByTitle("Run now")).toHaveCount(0);
  await expect(page.getByTestId("loop-run-detail").first()).toHaveText("the previous run was still waiting for an approval from you", { timeout: 100_000 });
  await shoot(page, "loops-07-waits-on-you");

  for (const l of (await (await request.get("/api/loops")).json()).loops) await request.delete(`/api/loops/${l.id}`);
  const errors = (await (await request.get("/api/errors")).json()).errors;
  expect(errors.length, JSON.stringify(errors.slice(0, 3))).toBe(errorsBefore);
});
