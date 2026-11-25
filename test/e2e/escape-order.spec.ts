import { expect, test, type APIRequestContext, type Page } from "./isolate.ts";
import { create, drop, folder, scripted } from "./answering.ts";
import { shoot, openPanel } from "./shots.ts";

// Feature: Escape in the message box while a turn works closes what is open first, the topmost thing:
// a popup, then the pane's side panel. Only with nothing open does it stop the turn. The press that
// follows one that closed something is the double press: it stops nothing and says how to.
test.use({ storageState: { cookies: [], origins: [] } });

const phase = async (request: APIRequestContext, id: string) => ((await (await request.get("/api/sessions")).json()).sessions as { id: string; phase: string }[]).find((s) => s.id === id)?.phase;
async function works(request: APIRequestContext, id: string, ws: string) {
  await request.post(`/api/sessions/${id}/messages`, { data: { text: `script:hold ${ws}/never-${id.slice(-6)}` } });
  await expect.poll(() => phase(request, id), { timeout: 30_000 }).toBe("working");
}
const tip = (page: Page) => page.locator(".k-tip");
const SOON = "Esc stops the turn in a moment", AGAIN = "Esc again stops the turn";

test("Escape closes the side panel before it stops the turn", async ({ page, request }) => {
  await scripted(request);
  const ws = folder("escape-order-panel");
  const id = await create(request, "Escape order: panel", ws);
  await works(request, id, ws);
  await page.goto(`/s/${id}`);
  await openPanel(page, "files");
  const side = page.getByTestId("side-panel");
  await expect(side).toBeVisible();
  // (The panel takes the keyboard to its search box as it opens; the owner then goes back to the message box.)
  await expect(page.getByTestId("files-search")).toBeFocused();
  const box = page.getByTestId("composer");
  await box.click();
  await expect(box).toBeFocused();
  await shoot(page, "escape-order-01-panel-open");

  // The first Escape closes the panel and leaves the turn alone.
  await page.keyboard.press("Escape");
  await expect(side).toHaveCount(0);
  // The next one, at once, is the double press: it says how to stop and stops nothing.
  await page.keyboard.press("Escape");
  await expect(tip(page)).toHaveText(SOON);
  expect(await phase(request, id)).toBe("working");
  await shoot(page, "escape-order-02-panel-closed-turn-works");
  // Once the settle time has passed the tip says so, and the next Escape stops the turn.
  await expect(tip(page)).toHaveText(AGAIN, { timeout: 5000 });
  await page.keyboard.press("Escape");
  await expect.poll(() => phase(request, id), { timeout: 15_000 }).not.toBe("working");
  await drop(request, id);
});

test("Escape closes an open popup before it stops the turn", async ({ page, request }) => {
  await scripted(request);
  const ws = folder("escape-order-popup");
  const id = await create(request, "Escape order: popup", ws);
  await works(request, id, ws);
  await page.goto(`/s/${id}`);
  // The voice card stays open over the page while the keyboard is in the message box.
  // (Its button is in the header, or in the menu of the actions the header has no room for.)
  const voice = page.getByTestId("header-action-voice");
  if (!(await voice.isVisible())) await page.getByRole("button", { name: "Session actions" }).click();
  await voice.click();
  const card = page.getByTestId("voice-card");
  await expect(card).toBeVisible();
  await page.getByTestId("composer").click();
  await shoot(page, "escape-order-03-popup-open");

  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(tip(page)).toHaveText(SOON);
  expect(await phase(request, id)).toBe("working");
  await expect(tip(page)).toHaveText(AGAIN, { timeout: 5000 });
  await page.keyboard.press("Escape");
  await expect.poll(() => phase(request, id), { timeout: 15_000 }).not.toBe("working");
  await drop(request, id);
});
