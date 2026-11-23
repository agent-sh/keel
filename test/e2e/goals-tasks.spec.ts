import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, openPanel, shoot, SCRIPTED } from "./shots.ts";

const DEV = process.env.KEEL_DEV_DIR ?? `${process.env.HOME}/.cache/keel-work/bun/dev-automation2`;

// Feature: /goal sets a finish line; after each turn a judge reads the
// conversation, and when it says met an independent verifier checks the work
// on disk; the goal ends when the verifier agrees, and a claim the files do
// not back sends the next turn what is missing. The task list is shared: the
// owner adds and ticks items in the panel, the model is told and keeps them
// with its own plan tool, and an item can go to a session of its own.
test("goals and the shared task list", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs a real model: it has to work toward a goal and keep the task list");
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
  // Met only after an independent verifier (a read-only child session) checked the work.
  await expect(page.getByTestId("goal-verify")).toHaveAttribute("data-state", "met");
  const met = (await (await request.get(`/api/sessions/${session.id}/goal`)).json()).goal;
  expect(met.verified).toBe(true);
  expect(met.evidence.length).toBeGreaterThan(0);
  expect((await (await request.get(`/api/sessions/${met.verifier_session}`)).json()).session.parent_id).toBe(session.id);
  await expect.poll(idle, { timeout: 60_000 }).toBe(true);
  await shoot(page, "goals-02-met");

  // The verifier's model is the session's until the owner picks one on the card, from the listing.
  const verifier = page.getByTestId("goal-verifier-model");
  const goalNow = async () => (await (await request.get(`/api/sessions/${session.id}/goal`)).json()).goal;
  await expect(verifier).toContainText("Same as the session");
  await verifier.getByTestId("model-picker").click();
  await page.getByPlaceholder("Search models").fill(HAIKU);
  await page.getByTestId("model-popup").locator(`[data-testid="model-option"][data-model="${HAIKU}"]`).first().click();
  await expect.poll(async () => (await goalNow()).verifier_model).toBe(HAIKU);
  await expect(verifier).not.toContainText("Same as the session");
  await shoot(page, "goals-02b-verifier-model");
  await verifier.getByTestId("goal-verifier-reset").click();
  await expect.poll(async () => (await goalNow()).verifier_model).toBeNull();
  await expect(verifier).toContainText("Same as the session");

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
  const row = page.locator(`[data-task-id="${review.id}"]`);
  await expect(row.getByTestId("task-text")).toHaveText("Review B");
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

test("goal: a claim the files do not back is not met", async ({ page, request }) => {
  test.skip(SCRIPTED, "needs a real model: the goal's verifier is a model that has to read the files");
  const ids = ((await (await request.get("/api/models")).json()).models as any[]).map((m) => m.id);
  test.skip(!ids.includes("scripted:stand-in"), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const dir = join(DEV, `goal-liar-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  // The worker and its judge are a stand-in that says done without doing it; the verifier is a real model.
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", workspace: dir } })).json();
  await request.put(`/api/sessions/${session.id}/goal`, { data: { objective: "script:liar goal.txt in the working directory holds the word ready.", verifier_model: HAIKU } });
  await page.goto(`/s/${session.id}`);
  await openPanel(page, "tasks");
  await expect(page.getByTestId("goal-verify")).toHaveAttribute("data-state", "not_met", { timeout: 200_000 });
  const g = (await (await request.get(`/api/sessions/${session.id}/goal`)).json()).goal;
  expect(g.verified).not.toBe(true);
  expect(g.status).not.toBe("achieved");
  expect(g.last_verdict).toBe("not_met");
  // The next turn was told what the check found.
  const evs = (await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[];
  expect(evs.some((e) => e.kind === "user" && String(e.data.text).includes("an independent check of the work found this"))).toBe(true);
  await expect(page.getByTestId("goal-evidence")).toBeVisible();
  await shoot(page, "goals-05-refuted");
  await request.delete(`/api/sessions/${session.id}/goal`);
});

// A goal typed in the start box, where no session exists yet, starts a session as a
// first message does and is that session's goal. A session's own command typed
// there says in place what it needs and is not a failure.
test("goal: typed in the start box it starts its session", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  await page.goto("/");
  const box = page.getByTestId("new-composer").getByTestId("composer");
  await box.fill("/pin");
  await box.press("Enter");
  await expect(page.getByTestId("new-composer").getByTestId("composer-notice")).toContainText("session");
  await expect(box).toHaveValue("/pin");
  const objective = "script:say done. Reply done once.";
  await box.fill(`/goal ${objective}`);
  await box.press("Enter");
  await expect(page).toHaveURL(/\/s\/[^/]+$/);
  const id = page.url().split("/s/")[1]!;
  await expect(page.getByTestId("tasks-panel")).toBeVisible();
  await expect(page.getByTestId("goal-card")).toBeVisible();
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}/goal`)).json()).goal?.objective).toBe(objective);
  await shoot(page, "goals-06-from-start");
  await request.delete(`/api/sessions/${id}/goal`);
  const errors = (await (await request.get("/api/errors")).json()).errors;
  expect(errors.length, JSON.stringify(errors.slice(0, 3))).toBe(errorsBefore);
});
