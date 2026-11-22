import { expect, test } from "./isolate.ts";
import { ask, HAIKU, shoot, SCRIPTED } from "./shots.ts";

// Feature: zero-token waits. The model schedules a timer wait and a monitor;
// the session is parked (no model calls) until they fire, then woken with the
// result. The page lists what the session waits on. (A real model sets the
// wait and the monitor from words and answers the wake as its note says; the
// stand-in sets them from its script, and what it says after a wake is not
// read: that the wake came, once, with the line that matched, is.)
test("waits and monitors wake the session", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  // Commands run without cards here: the gate has its own e2e.
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);

  await page.getByTestId("composer").fill(ask(
    "Use the WaitFor tool for a timer of 8 seconds with the note 'say only the word ready', then end your turn without other tools.",
    `script:calls ${JSON.stringify([{ name: "wait_for", input: { kind: "timer", seconds: 8, note: "say only the word ready" } }])}`,
  ));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId("background-button").click();
  await expect(page.getByTestId("bg-wait")).toContainText("Timer");
  // A timer fires at its time: it never says it gives up.
  await expect(page.getByTestId("bg-wait")).toContainText("fires on the next check");
  await shoot(page, "waits-01-parked");
  await page.keyboard.press("Escape");
  const calls = (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "assistant").length;

  await expect(page.getByTestId("wake-notice")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 60_000 });
  if (!SCRIPTED) await expect(page.getByTestId("assistant-text").last()).toContainText(/ready/i);
  await shoot(page, "waits-02-woken");
  // Nothing was asked of the model while it waited: one more call, after the wake.
  const after = (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "assistant").length;
  expect(after).toBe(calls + 1);

  await page.getByTestId("composer").fill(ask(
    "Use the Monitor tool with the command `for i in 1 2 3; do echo build step $i; sleep 1; done; echo BUILD OK` and the match `BUILD`. End your turn right after starting it. When the event arrives, reply with only the matched line.",
    `script:calls ${JSON.stringify([{ name: "monitor", input: { command: "for i in 1 2 3; do echo build step $i; sleep 1; done; echo BUILD OK", match: "BUILD" } }])}`,
  ));
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("wake-notice").nth(1)).toBeVisible({ timeout: 60_000 });
  if (!SCRIPTED) await expect(page.getByTestId("assistant-text").last()).toContainText("BUILD OK", { timeout: 60_000 });
  await page.getByTestId("wake-notice").last().click();
  if (SCRIPTED) await expect(page.getByTestId("wake-notice").last()).toContainText("BUILD OK");
  await shoot(page, "waits-03-monitor");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
