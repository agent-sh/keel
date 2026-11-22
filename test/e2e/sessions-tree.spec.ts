import { expect, test } from "./isolate.ts";
import { ask, HAIKU, shoot } from "./shots.ts";

// Feature: edit-and-resend makes a branch and the arrows move between the
// versions; fork from a message opens a new session; rename, archive, restore,
// search across what sessions said, and delete.
test("branches, fork, rename, archive, search, delete", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const tag = `zq${Date.now().toString(36)}`;
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  await page.goto(`/s/${session.id}`);
  const composer = page.getByTestId("composer");

  await composer.fill(ask(`Reply with only the word apple. (${tag})`, `script:say apple (${tag})`));
  await composer.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 90_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(/apple/i);

  // Edit and resend: a second version, shown as 2/2.
  await page.getByTestId("user-message").hover();
  await page.getByTestId("edit-message").click();
  await page.getByTestId("edit-box").fill(ask(`Reply with only the word banana. (${tag})`, `script:say banana (${tag})`));
  await page.getByTestId("edit-send").click();
  await expect(page.getByTestId("branch-pos")).toHaveText("2/2", { timeout: 30_000 });
  await expect(page.getByTestId("assistant-text").last()).toContainText(/banana/i, { timeout: 90_000 });
  await expect(page.getByTestId("turn-end")).toHaveCount(1);
  await shoot(page, "tree-01-second-version");

  await page.getByRole("button", { name: "Previous version" }).click();
  await expect(page.getByTestId("branch-pos")).toHaveText("1/2");
  await expect(page.getByTestId("assistant-text").last()).toContainText(/apple/i);
  await shoot(page, "tree-02-first-version");

  // Fork from the reply: a new session with this branch.
  await page.getByRole("button", { name: "Fork a new session from here" }).last().click();
  await expect(page).not.toHaveURL(new RegExp(session.id));
  await expect(page.getByTestId("session-title")).toContainText("(fork)");
  await expect(page.getByTestId("assistant-text").last()).toContainText(/apple/i);
  const forkUrl = page.url();

  // Rename the fork from the header menu.
  await page.getByTestId("session-menu").click();
  await page.getByTestId("menu-rename").click();
  await page.getByLabel("Session title").fill(`Fruit fork ${tag}`);
  await page.getByLabel("Session title").press("Enter");
  await expect(page.getByTestId("session-title")).toHaveText(`Fruit fork ${tag}`);

  // Archive it, find it among the archived, restore it.
  await page.getByTestId("session-menu").click();
  await page.getByTestId("menu-archive").click();
  await expect(page.getByTestId("session-list")).not.toContainText(`Fruit fork ${tag}`);
  await page.getByTestId("tab-archived").click();
  await expect(page.getByTestId("session-list")).toContainText(`Fruit fork ${tag}`);
  await shoot(page, "tree-03-archived");
  await page.getByTestId("session-menu").click();
  await page.getByTestId("menu-restore").click();
  await expect(page.getByTestId("session-list")).not.toContainText(`Fruit fork ${tag}`);
  await page.getByTestId("tab-active").click();
  await expect(page.getByTestId("session-list")).toContainText(`Fruit fork ${tag}`);

  // Search what was said: the edited prompt of the first session opens on its
  // branch as a preview; the session's own branch moves only on Continue.
  const headBefore = (await (await request.get(`/api/sessions/${session.id}`)).json()).session.head;
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill(`banana ${tag}`);
  const hit = page.getByRole("option").filter({ hasText: "banana" }).first();
  await expect(hit).toBeVisible();
  await shoot(page, "tree-04-search");
  await hit.click();
  await expect(page).toHaveURL(new RegExp(session.id));
  await expect(page.getByTestId("branch-pos")).toHaveText("2/2");
  await expect(page.getByTestId("branch-preview")).toBeVisible();
  expect((await (await request.get(`/api/sessions/${session.id}`)).json()).session.head).toBe(headBefore);
  await shoot(page, "tree-05-search-preview");
  await page.getByTestId("preview-continue").click();
  await expect(page.getByTestId("branch-preview")).toHaveCount(0);
  await expect(page.getByTestId("branch-pos")).toHaveText("2/2");
  expect((await (await request.get(`/api/sessions/${session.id}`)).json()).session.head).not.toBe(headBefore);

  // Delete the fork.
  await page.goto(forkUrl);
  await page.getByTestId("session-menu").click();
  await page.getByTestId("menu-delete").click();
  await page.getByTestId("confirm").getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("session-list")).not.toContainText(`Fruit fork ${tag}`);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});

// A fork made before a prompt puts the prompt back in the new box with its
// picture; the fork keeps its clear undoable (its marker names the fork's own
// event), says where it came from, and a fork can be named at once. A rename
// is not new work: the session keeps its place among the newest.
test("fork before a prompt, named fork, clear undo in a fork", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const tag = `fb${Date.now().toString(36)}`;
  const M = "scripted:stand-in";
  const idle = (id: string) => expect.poll(async () => (await (await request.get(`/api/sessions/${id}`)).json()).session.phase, { timeout: 30_000 }).toBe("idle");
  // 1x1 PNG
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const { session } = await (await request.post("/api/sessions", { data: { model: M, text: `first ${tag}` } })).json();
  await idle(session.id);
  await request.post(`/api/sessions/${session.id}/clear`);
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `second ${tag}`, images: [{ type: "image", media_type: "image/png", data: png }] } });
  await idle(session.id);

  await page.goto(`/s/${session.id}`);
  const second = page.getByTestId("user-message").filter({ hasText: `second ${tag}` });
  await second.hover();
  await second.getByRole("button", { name: "Fork before this prompt and edit it there" }).click();
  await expect(page).not.toHaveURL(new RegExp(session.id));
  await expect(page.getByTestId("composer")).toHaveValue(`second ${tag}`);
  await expect(page.getByTestId("attachments").locator("img")).toHaveCount(1);
  await expect(page.getByTestId("fork-note")).toBeVisible();
  // The fork's clear: Undo shows and moves the fork back before it, the source stays.
  const sourceHead = (await (await request.get(`/api/sessions/${session.id}`)).json()).session.head;
  await shoot(page, "tree-06-fork-before");
  await page.getByTestId("undo-clear").click();
  await expect(page.getByTestId("cleared")).toHaveCount(0);
  await expect(page.getByTestId("user-message").filter({ hasText: `first ${tag}` })).toBeVisible();
  expect((await (await request.get(`/api/sessions/${session.id}`)).json()).session.head).toBe(sourceHead);

  // A named fork from the source: its title at once; the source keeps its own.
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").fill("/fork Docs");
  await page.getByTestId("composer").press("Enter");
  await expect(page.getByTestId("session-title")).toHaveText("Docs");
  expect((await (await request.get(`/api/sessions/${session.id}`)).json()).session.title).not.toBe("Docs");

  // A rename keeps the session's last activity (its place in the lists).
  const before = (await (await request.get(`/api/sessions/${session.id}`)).json()).session;
  await request.patch(`/api/sessions/${session.id}`, { data: { title: `Renamed ${tag}` } });
  const after = (await (await request.get(`/api/sessions/${session.id}`)).json()).session;
  expect(after.updated).toBe(before.updated);
  expect(after.rev).toBeGreaterThan(before.rev);

  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
