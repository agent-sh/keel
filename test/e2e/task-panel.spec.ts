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

test("tasks: a task whose session was deleted can be started again, once", async ({ page, request }) => {
  const model = await standIn(request);
  test.skip(!model, "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Task source" } })).json();
  const made: string[] = [session.id];
  try {
    const tasks = `/api/sessions/${session.id}/tasks`;
    const add = async (text: string) => (await (await request.post(tasks, { data: { text } })).json()).task as { id: string };
    const start = async (id: string) => {
      const r = await (await request.post(`${tasks}/${id}/start`)).json();
      made.push(r.session_id);
      return r as { session_id: string; existing?: boolean };
    };
    const idle = (id: string) => expect.poll(async () => {
      const d = await (await request.get(`/api/sessions/${id}`)).json();
      return !d.running && d.events.at(-1)?.kind === "turn_end";
    }, { timeout: 30_000 }).toBe(true);
    const [hello, kept, finished] = [await add("Say hello"), await add("Keep me"), await add("Done one")];
    const dests = { hello: (await start(hello.id)).session_id, kept: (await start(kept.id)).session_id, finished: (await start(finished.id)).session_id };
    for (const d of Object.values(dests)) await idle(d);
    // One destination per task, each with the task as its one stored first prompt.
    const prompts = (await (await request.get(`/api/sessions/${dests.hello}`)).json()).events.filter((e: any) => e.kind === "user");
    expect(prompts.map((e: any) => [e.data.kind, e.data.task_id])).toEqual([["task_start", hello.id]]);
    await request.patch(`${tasks}/${finished.id}`, { data: { status: "completed" } });

    await page.goto(`/s/${session.id}`);
    await openPanel(page, "tasks");
    const row = (id: string) => page.locator(`[data-task-id="${id}"]`);
    for (const t of [hello, kept, finished]) await expect(row(t.id).getByTestId("task-open")).toBeVisible();

    // Deleted while the page is open: the row says so instead of keeping a dead link.
    expect((await request.delete(`/api/sessions/${dests.hello}`)).ok()).toBe(true);
    await expect(row(hello.id).getByTestId("task-dest-gone")).toContainText("Its session was deleted.");
    await expect(row(hello.id).getByTestId("task-open")).toHaveCount(0);

    // After a reload the daemon says which destinations it no longer has. One
    // that is only out of the page's list (archived) is still the row's link.
    expect((await request.delete(`/api/sessions/${dests.finished}`)).ok()).toBe(true);
    expect((await request.patch(`/api/sessions/${dests.kept}`, { data: { archived: true } })).ok()).toBe(true);
    await page.reload();
    await openPanel(page, "tasks");
    await expect(row(hello.id).getByTestId("task-dest-gone")).toBeVisible();
    await expect(row(hello.id).getByTestId("task-restart")).toBeVisible();
    await expect(row(hello.id).getByTestId("task-open")).toHaveCount(0);
    await expect(row(kept.id).getByTestId("task-open")).toBeVisible();
    await expect(row(kept.id).getByTestId("task-dest-gone")).toHaveCount(0);
    // A finished task is not started again: the row only says where its session went.
    await expect(row(finished.id).getByTestId("task-dest-gone")).toBeVisible();
    await expect(row(finished.id).getByTestId("task-restart")).toHaveCount(0);
    await expect(row(finished.id).getByTestId("task-open")).toHaveCount(0);
    await shoot(page, "tasks-dest-01-deleted");

    // Started again from the row: one new session, and the row links to it.
    await row(hello.id).getByTestId("task-restart").click();
    await expect(page).not.toHaveURL(new RegExp(`/s/${session.id}$`));
    await expect(page.getByTestId("composer")).toBeVisible();
    const again = page.url().split("/s/")[1]!;
    made.push(again);
    expect(again).not.toBe(dests.hello);
    expect(await start(hello.id)).toMatchObject({ session_id: again, existing: true });
    const all = (await (await request.get("/api/sessions")).json()).sessions as { id: string; title: string }[];
    expect(all.filter((s) => s.title === "Say hello").map((s) => s.id)).toEqual([again]);
    await page.goto(`/s/${session.id}`);
    await openPanel(page, "tasks");
    await expect(row(hello.id).getByTestId("task-open")).toBeVisible();
    await expect(row(hello.id).getByTestId("task-dest-gone")).toHaveCount(0);
    await shoot(page, "tasks-dest-02-started-again");
  } finally {
    for (const id of made) await request.delete(`/api/sessions/${id}`);
  }
});
