import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

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
