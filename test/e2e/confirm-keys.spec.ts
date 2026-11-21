import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a confirmation is answered by a key the owner meant. A dialog
// that deletes, writes outside Keel or cannot be undone opens with the
// keyboard on Cancel, so an Enter on its way to whatever was under the hand
// cancels; and its action takes no key press for the settle time after the
// dialog opened, so Tab and Enter typed ahead do not answer it either. A
// pointer press on the action is aimed and acts at once. Shown on the dialog
// that deletes a session; every dialog drawn as danger, and the ones marked
// careful (a restart, a move of uncommitted work, a build taken by every
// session, a correction sent to the memory store), share it.
test("a confirmation that cannot be undone opens on Cancel and takes no key that was typed ahead", async ({ page, request }) => {
  const title = `Confirm keys ${Date.now().toString(36)}`;
  const { session } = await (await request.post("/api/sessions", { data: { title } })).json();
  const kept = async () => (await request.get(`/api/sessions/${session.id}`)).status();
  await page.goto(`/s/${session.id}`);
  const confirm = page.getByTestId("confirm");
  const open = async () => {
    await page.getByTestId("session-menu").click();
    await page.getByTestId("menu-delete").click();
    await expect(confirm).toBeVisible();
  };

  // It opens on Cancel: Enter cancels, and the session is still there.
  await open();
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await shoot(page, "confirm-keys-01-on-cancel");
  await page.keyboard.press("Enter");
  await expect(confirm).toBeHidden();
  expect(await kept()).toBe(200);

  // Tab and Enter typed ahead reach the action before the dialog has stood: nothing happens.
  await open();
  await page.keyboard.press("Tab");
  await expect(confirm.getByTestId("confirm-action")).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await expect(confirm).toBeVisible();
  expect(await kept()).toBe(200);
  // Once it has stood for the settle time, the key is an answer.
  await page.waitForTimeout(1100);
  await page.keyboard.press("Enter");
  await expect(confirm).toBeHidden();
  await expect.poll(kept).toBe(404);

  // A pointer press is aimed: it acts at once.
  const second = (await (await request.post("/api/sessions", { data: { title: `${title} two` } })).json()).session;
  await page.goto(`/s/${second.id}`);
  await open();
  await confirm.getByTestId("confirm-action").click();
  await expect.poll(async () => (await request.get(`/api/sessions/${second.id}`)).status()).toBe(404);
});
