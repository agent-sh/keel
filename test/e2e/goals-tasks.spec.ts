import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot } from "./shots.ts";

const DEV = process.env.KEEL_DEV_DIR ?? `${process.env.HOME}/.cache/keel-work/bun/dev-automation2`;

// Feature: /goal sets a finish line; after each turn a judge reads the
// conversation and the goal ends when it is met. The task list is shared: the
// owner adds and ticks items in the panel, the model is told and keeps them
// with its own plan tool, and an item can go to a session of its own.
test("goals and the shared task list", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const dir = join(DEV, `goal-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, workspace: dir } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  await page.goto(`/s/${session.id}`);
  const idle = async () => {
    const d = await (await request.get(`/api/sessions/${session.id}`)).json();
    return !d.running && d.events.at(-1)?.kind === "turn_end";
  };

  // A goal from the composer: the panel opens, the session works, the judge says met.
  await page.getByTestId("composer").fill("/goal Create goal.txt in the working directory holding the word ready, then show it with cat goal.txt.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("tasks-panel")).toBeVisible();
  await expect(page.getByTestId("goal-card")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("goal-notice").first()).toBeVisible();
  await shoot(page, "goals-01-pursuing");
  await expect(page.getByTestId("goal-status")).toHaveText("Met", { timeout: 200_000 });
  await expect(page.getByTestId("goal-reason")).not.toBeEmpty();
  await expect.poll(idle, { timeout: 60_000 }).toBe(true);
  await shoot(page, "goals-02-met");

  // The shared list: the owner's item reaches the model, which keeps it in its plan.
  await page.getByTestId("task-add").fill("Write a one-line summary of goal.txt");
  await page.getByTestId("task-add").press("Enter");
  await expect(page.getByTestId("task-row")).toHaveCount(1);
  await expect(page.getByTestId("task-row").first()).toContainText("you");
  await page.getByTestId("composer").fill("Update the shared task list with your plan tool: keep every item already on it, and add the item Check goal.txt marked completed. Then reply with one word: done.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("task-row")).toHaveCount(2, { timeout: 90_000 });
  await expect(page.getByTestId("task-list")).toContainText("Write a one-line summary of goal.txt");
  await expect(page.getByTestId("task-row").filter({ hasText: "Check goal.txt" })).toHaveAttribute("data-status", "completed");
  await expect.poll(idle, { timeout: 60_000 }).toBe(true);
  const evs = (await (await request.get(`/api/sessions/${session.id}`)).json()).events;
  expect(evs.some((e: any) => e.kind === "note" && e.data.kind === "tasks")).toBe(true);

  // Tick the owner's item, then take the other out into its own session.
  const mine = page.getByTestId("task-row").filter({ hasText: "one-line summary" });
  await mine.getByTestId("task-check").click();
  await expect(mine).toHaveAttribute("data-status", "completed");
  await shoot(page, "goals-03-tasks");
  await page.getByTestId("task-add").fill("Say hello");
  await page.getByTestId("task-add").press("Enter");
  const hello = page.getByTestId("task-row").filter({ hasText: "Say hello" });
  await hello.hover();
  await hello.getByTestId("task-start").click();
  await expect(page).not.toHaveURL(new RegExp(`/s/${session.id}$`));
  await expect(page.getByTestId("composer")).toBeVisible();
  const dest = page.url().split("/s/")[1];

  // Taken out once: the row keeps its words and opens that session; a retry
  // answers with it instead of starting the task again.
  await page.goto(`/s/${session.id}`);
  await expect(hello).toContainText("Say hello");
  await expect(hello).not.toContainText("in its own session");
  await expect(hello.getByTestId("task-open")).toBeVisible();
  const helloId = (await (await request.get(`/api/sessions/${session.id}/tasks`)).json()).tasks.find((t: any) => t.text === "Say hello").id;
  const again = await request.post(`/api/sessions/${session.id}/tasks/${helloId}/start`);
  expect(await again.json()).toMatchObject({ session_id: dest, existing: true });

  // A rename from elsewhere is what the editor opens with, and leaving it
  // without typing sends nothing.
  const review = (await (await request.post(`/api/sessions/${session.id}/tasks`, { data: { text: "Review A" } })).json()).task;
  await expect(page.getByTestId("task-row").filter({ hasText: "Review A" })).toHaveCount(1);
  await request.patch(`/api/sessions/${session.id}/tasks/${review.id}`, { data: { text: "Review B" } });
  const row = page.getByTestId("task-row").filter({ hasText: "Review B" });
  await expect(row).toHaveCount(1);
  const edits: string[] = [];
  page.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes(`/tasks/${review.id}`)) edits.push(r.postData() ?? ""); });
  await row.getByTestId("task-text").dblclick();
  await expect(row.getByTestId("task-edit")).toHaveValue("Review B");
  await row.getByTestId("task-edit").blur();
  await expect(row.getByTestId("task-text")).toHaveText("Review B");
  expect(edits).toEqual([]);
  // A task cancelled meanwhile is not started from a stale button.
  await request.patch(`/api/sessions/${session.id}/tasks/${review.id}`, { data: { status: "cancelled" } });
  const stale = await request.post(`/api/sessions/${session.id}/tasks/${review.id}/start`);
  expect(stale.status()).toBe(409);
  expect((await (await request.get(`/api/sessions/${session.id}/tasks`)).json()).tasks.find((t: any) => t.id === review.id)).toMatchObject({ status: "cancelled", dest_session: null });
  await shoot(page, "goals-04-taken-out");

  await request.delete(`/api/sessions/${session.id}/goal`);
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
