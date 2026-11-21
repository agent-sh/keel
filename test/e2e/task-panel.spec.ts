import { expect, test } from "./isolate.ts";
import type { APIRequestContext, Page } from "@playwright/test";
import { openPanel, shoot } from "./shots.ts";

// Feature: the task panel when something else moved first. A rename the page
// has not heard of yet is refused by the daemon, and the owner chooses between
// the two texts; a task whose own session was deleted says so and can be
// started again, once.

const standIn = async (request: APIRequestContext) =>
  ((await (await request.get("/api/models")).json()).models as { id: string; provider: string; context: number }[])
    .filter((m) => m.provider === "scripted").sort((a, b) => b.context - a.context)[0]?.id;

// The page's socket, with the task list's frames held back on demand: another
// page's rename reaches this one late.
async function heldTasks(page: Page) {
  const late: (() => void)[] = [];
  const state = { hold: false };
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      if (state.hold && typeof m === "string" && m.includes('"kind":"tasks"')) late.push(() => ws.send(m));
      else ws.send(m);
    });
  });
  return { hold: () => void (state.hold = true), release: () => { state.hold = false; for (const send of late.splice(0)) send(); } };
}

test("tasks: a rename the daemon refused opens the chooser with its text", async ({ page, request }) => {
  const model = await standIn(request);
  test.skip(!model, "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Rename race" } })).json();
  try {
    const tasks = `/api/sessions/${session.id}/tasks`;
    const { task } = await (await request.post(tasks, { data: { text: "Review A" } })).json();
    const frames = await heldTasks(page);
    const sent: { body: any; status: number }[] = [];
    page.on("response", (r) => {
      if (r.request().method() === "PATCH" && r.url().endsWith(`/tasks/${task.id}`)) sent.push({ body: r.request().postDataJSON(), status: r.status() });
    });
    await page.goto(`/s/${session.id}`);
    await openPanel(page, "tasks");
    const row = page.locator(`[data-task-id="${task.id}"]`);
    const text = row.getByTestId("task-text");
    const chooser = row.getByTestId("task-conflict");
    const stored = async () => (await (await request.get(tasks)).json()).tasks[0].text;

    // Another page renames the row; its frame is still on the way when this page saves.
    await text.dblclick();
    await row.getByTestId("task-edit").fill("Review A, with notes");
    frames.hold();
    await request.patch(`${tasks}/${task.id}`, { data: { text: "Review B" } });
    await row.getByTestId("task-edit").press("Enter");
    await expect(chooser).toContainText('It was changed to "Review B" while you edited.');
    await expect(row.getByTestId("task-keep-mine")).toHaveText('Use "Review A, with notes"');
    expect(sent).toEqual([{ body: { text: "Review A, with notes", was: "Review A" }, status: 409 }]);
    await shoot(page, "tasks-race-01-chooser");

    // Keeping the daemon's text writes nothing.
    await row.getByTestId("task-keep-theirs").click();
    await expect(chooser).toHaveCount(0);
    expect(sent).toHaveLength(1);
    expect(await stored()).toBe("Review B");
    frames.release();
    await expect(text).toHaveText("Review B");

    // The same race again: choosing the draft sends it against the text the daemon answered with.
    await text.dblclick();
    await row.getByTestId("task-edit").fill("Review C");
    frames.hold();
    await request.patch(`${tasks}/${task.id}`, { data: { text: "Review D" } });
    await row.getByTestId("task-edit").press("Enter");
    await expect(chooser).toContainText('It was changed to "Review D" while you edited.');
    await row.getByTestId("task-keep-mine").click();
    await expect(chooser).toHaveCount(0);
    expect(sent.slice(1)).toEqual([{ body: { text: "Review C", was: "Review B" }, status: 409 }, { body: { text: "Review C", was: "Review D" }, status: 200 }]);
    expect(await stored()).toBe("Review C");
    frames.release();
    await expect(text).toHaveText("Review C");
    // A refused rename is a choice, not an error.
    expect((await (await request.get("/api/errors")).json()).errors.length).toBe(errorsBefore);
  } finally {
    await request.delete(`/api/sessions/${session.id}`);
  }
});
