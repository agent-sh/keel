import { expect, test } from "@playwright/test";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the model starts two background subagents in one step; they run as
// child sessions shown under the parent, live; their reports come back to the
// parent as one message; a running agent can be stopped from the page.
test("subagents run in parallel, report back, and stop", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const r = await request.post("/api/sessions", { data: { model: HAIKU } });
  const { session } = await r.json();
  // Commands run without cards here: the gate has its own e2e.
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);

  await page.getByTestId("composer").fill(
    "Call the Agent tool twice in one message, both with run_in_background true: one agent counts the files in the working directory with Bash, the other prints the date with Bash. Then end your turn with one short line. When both reports arrive, answer in one sentence with both results.",
  );
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("agent-call")).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId("child-session")).toHaveCount(2);
  await expect(page.getByTestId("background-button")).toBeVisible();
  await shoot(page, "agents-01-started");

  await expect(page.getByTestId("agent-report")).toHaveCount(2, { timeout: 120_000 });
  // The reports may come in one message or two: wait until the parent is done with them.
  const idle = async () => {
    const d = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !d.running && d.events.at(-1)?.kind === "turn_end";
  };
  await expect.poll(idle, { timeout: 120_000 }).toBe(true);
  await expect(page.getByTestId("agent-call-status").first()).toHaveText("Done");
  await page.getByTestId("agent-report").first().click();
  await shoot(page, "agents-02-reported");

  await page.getByTestId("background-button").click();
  await expect(page.getByTestId("bg-agent")).toHaveCount(2);
  await shoot(page, "agents-03-background");
  await page.keyboard.press("Escape");

  await page.getByTestId("child-session").first().click();
  await expect(page.getByTestId("task-notice")).toBeVisible();
  await expect(page.getByTestId("turn-end")).toHaveCount(1);
  await shoot(page, "agents-04-child");

  // A long agent, stopped by the owner from the agent card.
  await page.goto(`/s/${session.id}`);
  await expect.poll(idle, { timeout: 60_000 }).toBe(true);
  await page.getByTestId("composer").fill("Call the Agent tool once with run_in_background true: the agent runs `sleep 120` with Bash, then reports. End your turn right after starting it.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("agent-call")).toHaveCount(3, { timeout: 60_000 });
  const card = page.getByTestId("agent-call").nth(2);
  await expect(card.getByTestId("agent-call-status")).toHaveText("Running in background", { timeout: 30_000 });
  await shoot(page, "agents-05-running");
  await card.getByTestId("agent-call-stop").click();
  await expect(card.getByTestId("agent-call-status")).toHaveText("Stopped", { timeout: 30_000 });
  await expect(page.getByTestId("agent-report").last()).toContainText("Stopped", { timeout: 60_000 });
  await shoot(page, "agents-06-stopped");

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
