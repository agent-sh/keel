import { expect, test } from "./isolate.ts";
import { HAIKU, openPanel, shoot } from "./shots.ts";

// Feature: a plan the session left alone while it went on is one quiet line, not a list that reads as
// true for days. Folded on the dock and in the panel after twelve turns or six idle hours; a plan with
// every step done folds in the panel; a session marked finished drops it from the dock.
test("a plan left alone folds to one quiet line", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { session } = await (await request.post("/api/sessions", { data: { title: "Release notes", model: HAIKU } })).json();
  const id = session.id as string;
  const idle = () => expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).session.phase, { timeout: 30_000 }).toBe("idle");
  const todos = (...status: string[]) => ["Read the release notes", "Check the changelog against the tags", "Write the summary"].map((content, i) => ({ content, activeForm: `${content} (now)`, status: status[i] }));
  const write = async (list: object[]) => {
    await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "TodoWrite", input: { todos: list } }])}` } });
    await idle();
  };
  try {
    await write(todos("completed", "in_progress", "pending"));
    // The page's own clock runs from here, so six hours pass without waiting for them.
    await page.clock.install({ time: Date.now() });
    await page.goto(`/s/${id}`);
    const plan = page.getByTestId("dock-plan");
    await expect(plan).toContainText("1/3");
    await expect(page.getByTestId("dock-plan-stale")).toHaveCount(0);
    await shoot(page, "plan-stale-01-fresh");

    // Seven hours later, the session idle: one quiet line, which still opens to the list.
    await page.clock.fastForward("07:00:00");
    await expect(page.getByTestId("dock-plan-stale")).toHaveText(/^Plan from 7 h ago, not updated since$/);
    await expect(plan).not.toContainText("1/3");
    await shoot(page, "plan-stale-02-dock-folded");
    await plan.click();
    await expect(page.getByTestId("plan").getByText("Check the changelog against the tags")).toBeVisible();
    await shoot(page, "plan-stale-03-dock-opened");
    await plan.click();

    // Marked finished: the plan leaves the dock; marked open again, it is the same quiet line.
    await request.patch(`/api/sessions/${id}`, { data: { done: true } });
    await expect(plan).toHaveCount(0);
    await request.patch(`/api/sessions/${id}`, { data: { done: false } });
    await expect(page.getByTestId("dock-plan-stale")).toBeVisible();

    // The panel folds the same list, and opens it on request.
    await openPanel(page, "tasks");
    const fold = page.getByTestId("task-fold");
    await expect(fold).toHaveAttribute("data-state", "stale");
    await expect(fold).toContainText("Plan from 7 h ago, not updated since");
    await expect(page.getByTestId("task-row")).toHaveCount(0);
    await shoot(page, "plan-stale-04-panel-folded");
    await fold.click();
    await expect(page.getByTestId("task-row")).toHaveCount(3);
    await shoot(page, "plan-stale-05-panel-opened");

    // A plan with every step done folds, whatever its age.
    await write(todos("completed", "completed", "completed"));
    await expect(page.getByTestId("task-fold")).toHaveAttribute("data-state", "settled");
    await expect(page.getByTestId("task-fold")).toContainText("all 3 done");
    await shoot(page, "plan-stale-06-panel-done");
  } finally {
    await request.delete(`/api/sessions/${id}`);
  }
  expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
});

// Twelve turns without a rewrite fold a plan at any hour (its own page: the first test moved the clock).
test("a plan folds after twelve turns without a rewrite", async ({ page, request }) => {
  const todos = (...status: string[]) => ["Read the release notes", "Check the changelog against the tags", "Write the summary"].map((content, i) => ({ content, activeForm: `${content} (now)`, status: status[i] }));
  const { session: busy } = await (await request.post("/api/sessions", { data: { title: "Many turns", model: HAIKU } })).json();
  try {
    await request.post(`/api/sessions/${busy.id}/messages`, { data: { text: `script:calls ${JSON.stringify([{ name: "TodoWrite", input: { todos: todos("in_progress", "pending", "pending") } }])}` } });
    await page.goto(`/s/${busy.id}`);
    await expect(page.getByTestId("dock-plan")).toContainText("0/3");
    for (let i = 0; i < 12; i++) {
      await expect.poll(async () => (await (await request.get(`/api/sessions/${busy.id}`)).json()).session.phase, { timeout: 30_000 }).toBe("idle");
      await request.post(`/api/sessions/${busy.id}/messages`, { data: { text: `script:say turn ${i}` } });
    }
    await expect(page.getByTestId("dock-plan-stale")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("dock-plan-stale")).toContainText("not updated since");
  } finally {
    await request.delete(`/api/sessions/${busy.id}`);
  }
});
