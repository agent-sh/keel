import { expect, test } from "@playwright/test";
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
  await page.goto("/");
  await page.getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill("haiku 5.5");
  await page.getByRole("option").first().click();

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
