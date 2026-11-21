import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the Claude tool profile in the UI. A plan checklist, a file
// written and edited (shown as a diff), a background command with its job in
// the dock and its end reported to the model, and a question the turn waits
// on until the owner answers it in the transcript.
test("claude tools: plan, edit diff, background job, question", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  // This feature is the tools, not the approval cards: run them without asking.
  const prev = (await (await request.get("/api/permissions/settings")).json()).default_mode;
  await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
  const name = `notes-${Date.now()}.txt`;
  // Its own scratch folder: the files the model writes never land in a checkout.
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `tools-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);

  await page.getByTestId("composer").fill(
    `Do exactly these steps with your tools, one call each, in order: ` +
    `1) TodoWrite a 3-item plan: "write file", "edit file", "start job" (first in_progress). ` +
    `2) Write ${name} in the working directory with the two lines "alpha" and "beta". ` +
    `3) Edit ${name}: replace "beta" with "gamma". ` +
    `4) Bash with run_in_background true: echo step-1-of-3; sleep 4; echo job-finished. ` +
    `5) TodoWrite the same plan with all three completed. Then reply "ok".`,
  );
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 150_000 });
  await expect(page.getByTestId("plan").first()).toBeVisible();
  await expect(page.locator('[data-tool="Edit"] [data-testid="diff"]')).toBeVisible();
  await expect(page.locator('[data-tool="Edit"]')).toContainText("+1");
  await expect(page.locator('[data-tool="Bash"]').getByTestId("tool-background")).toBeVisible();
  await expect(page.getByTestId("dock-job").first()).toBeVisible();
  // The dock shows the job's last printed line, so progress needs no question.
  await expect(page.getByTestId("dock-job-last").first()).toHaveText(/step-1-of-3|job-finished/);
  await shoot(page, "tools-01-plan-diff-job");

  await page.locator('[data-tool="Write"]').click();
  await expect(page.locator('[data-tool="Write"]')).toContainText("alpha");
  await shoot(page, "tools-02-write-open");

  // The job's end reaches the model with the next request.
  await page.getByTestId("composer").fill(
    "Use AskUserQuestion once: ask which color to use, header \"Color\", options Teal and Amber. " +
    "After my answer, say the background job's status and my color in one sentence.",
  );
  await page.keyboard.press("Enter");
  const q = page.locator('[data-testid="question"][data-state="open"]');
  await expect(q).toBeVisible({ timeout: 90_000 });
  await shoot(page, "tools-03-question-open");
  await q.getByTestId("question-option").filter({ hasText: "Amber" }).click();
  await shoot(page, "tools-04-question-picked");
  await q.getByTestId("question-submit").click();
  await expect(page.locator('[data-testid="question"][data-state="answered"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 120_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(/amber/i);
  await expect(page.getByTestId("note").first()).toContainText("job");
  await shoot(page, "tools-05-answered");

  await request.put("/api/permissions/settings", { data: { default_mode: prev } });
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// The Bash tool says a command still running at its timeout moves to the
// background. That holds for every command, one that starts with sleep too:
// what comes after the sleep still runs, and its output is in the job's log.
test("a command that outlives its timeout moves to the background, whatever it starts with", async ({ page, request }) => {
  test.skip(!HAIKU.startsWith("scripted:"), "needs the scripted stand-in: the exact call is the test");
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Timeout to the background" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "Bash", input: { command: "sleep 4; echo slept-th''rough", timeout: 1500 } }])}`);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
  const tool = page.getByTestId("tool-call").first();
  await expect(tool.getByTestId("tool-background")).toBeVisible();
  await tool.click();
  await expect(tool).toContainText("did not complete within its 2s timeout and was moved to the background");
  await expect(tool).not.toContainText("was killed");
  await shoot(page, "tools-06-timeout-to-background");
  // The rest of the command ran: the job ends by itself with the echo in its log.
  const job = async () => (await (await request.get(`/api/sessions/${session.id}/jobs`)).json()).jobs[0];
  await expect.poll(async () => { const j = await job(); return [j.running, j.exit_code, j.last]; }, { timeout: 20_000 }).toEqual([false, 0, "slept-through"]);
});
