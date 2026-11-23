import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a confirmation is answered by a key the owner meant. A dialog
// that deletes, writes outside Keel, cannot be undone or costs something to
// take back opens with the keyboard on Cancel, so an Enter on its way to
// whatever was under the hand cancels; and its action takes no key press for
// the settle time after the dialog opened, so Tab and Enter typed ahead do
// not answer it either: the refused press is shown on the button. A key that
// is held answers nothing, neither the action once the settle time passed
// nor Cancel, so a held Enter does not open and close the dialog over and
// over. A pointer press on the action is aimed and acts at once. Shown on
// the dialog that deletes a session and on the one that asks before a model
// switch; every dialog drawn as danger, and the ones marked careful (a
// restart, a move of uncommitted work, a build taken by every session, a
// correction sent to the memory store), share it.
const STAND_IN = "scripted:stand-in";

test("a confirmation that cannot be undone opens on Cancel and takes no key that was typed ahead or held", async ({ page, request }) => {
  const title = `Confirm keys ${Date.now().toString(36)}`;
  const { session } = await (await request.post("/api/sessions", { data: { title } })).json();
  const kept = async () => (await request.get(`/api/sessions/${session.id}`)).status();
  await page.goto(`/s/${session.id}`);
  const confirm = page.getByTestId("confirm");
  const action = confirm.getByTestId("confirm-action");
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

  // Tab and Enter typed ahead reach the action before the dialog has stood: nothing happens, and the button says so.
  // (The keys follow the opening at once: the settle time is counted from it.)
  await open();
  await page.keyboard.press("Tab");
  await page.keyboard.down("Enter");
  await expect(action).toHaveAttribute("data-nudge", "true");
  await expect(confirm.getByTestId("confirm-refused")).toHaveText("Not yet: the dialog has only just opened");
  await expect(action).toBeFocused();
  await shoot(page, "confirm-keys-02-refused");
  // The Enter stays held: it answers nothing, however long it is held, the settle time long past.
  await page.waitForTimeout(1200);
  for (let i = 0; i < 5; i++) { await page.keyboard.down("Enter"); await page.waitForTimeout(40); }
  await expect(confirm).toBeVisible();
  expect(await kept()).toBe(200);
  await page.keyboard.up("Enter");
  await expect(action).not.toHaveAttribute("data-nudge", "true");
  // Let go and pressed again, after the dialog has stood: the key is an answer.
  await page.keyboard.press("Enter");
  await expect(confirm).toBeHidden();
  await expect.poll(kept).toBe(404);

  // An Enter held on the way in does not cancel the dialog it opened, and so does not open it again and again.
  const second = (await (await request.post("/api/sessions", { data: { title: `${title} two` } })).json()).session;
  await page.goto(`/s/${second.id}`);
  await page.getByTestId("session-menu").click();
  await page.getByTestId("menu-delete").focus();
  await page.keyboard.down("Enter");
  await expect(confirm).toBeVisible();
  for (let i = 0; i < 8; i++) { await page.keyboard.down("Enter"); await page.waitForTimeout(40); }
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.up("Enter");
  expect((await request.get(`/api/sessions/${second.id}`)).status()).toBe(200);
  // A pointer press is aimed: it acts at once.
  await action.click();
  await expect.poll(async () => (await request.get(`/api/sessions/${second.id}`)).status()).toBe(404);
});

test("the question before a model switch is not answered by words typed on after the command", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string; name: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: "Confirm keys, switch", text: "Hello there." } })).json();
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).events.filter((e: any) => e.kind === "turn_end").length, { timeout: 60_000 }).toBe(1);
  await page.goto(`/s/${session.id}`);
  await expect(page.getByTestId("turn-end")).toHaveCount(1);
  const model = async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.model;
  const confirm = page.getByTestId("confirm");
  // The stand-in's cache is worth a tenth of a cent: asked about only when the owner asks about every lost cache.
  const kept = (await (await request.get("/api/settings")).json()).settings.model_switch ?? null;
  expect((await request.patch("/api/settings", { data: { model_switch: { ask_usd: 0 } } })).ok()).toBe(true);

  // The cache is warm, so the switch asks. The owner types on: the first Space lands on Cancel, not on Switch.
  const composer = page.getByTestId("composer");
  await composer.click();
  await page.keyboard.type("/model Scripted backup");
  // The command is whole (a name follows it), so no list of commands is open to take the Enter: one
  // Enter runs it, and the question comes once the daemon said what the switch costs. A second
  // Enter sent while waiting for it would be an Enter typed ahead: it lands on Cancel.
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(confirm).toContainText("Switch to Scripted backup?");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await shoot(page, "confirm-keys-03-switch-on-cancel");
  await page.keyboard.type("now fix the parser", { delay: 40 });
  await expect(confirm).toBeHidden();
  await page.waitForTimeout(500);
  expect(await model()).toBe(STAND_IN);
  // Asked again and answered by a press that was aimed: it switches.
  await composer.fill("/model Scripted backup");
  await expect(page.getByTestId("slash-menu")).toHaveCount(0);
  await composer.press("Enter");
  await confirm.getByRole("button", { name: "Switch" }).click();
  await expect.poll(model).not.toBe(STAND_IN);
  await request.patch("/api/settings", { data: { model_switch: kept } });
  await request.delete(`/api/sessions/${session.id}`);
});
