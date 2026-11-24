import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: a session's row menu can mark it unread, to come back to it. It sets the mark the row's dot
// reads (the same one the command and the session menu set), a row that is already unread does not offer
// it, and going to the session reads the mark again. On the scripted stand-in.
const STAND_IN = "scripted:stand-in";

test("a row's menu marks the session unread, and opening it reads the mark", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === STAND_IN), "needs the scripted stand-in: the daemon runs without KEEL_SCRIPTED_PROVIDER=1");
  const tag = Date.now().toString(36);
  const { session } = await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `Mark unread ${tag}`, text: "script:say Done." } })).json();
  const id = session.id as string;
  const unread = async () => ((await (await request.get("/api/alerts?with_unread")).json()).unread.sessions[id] ?? 0) as number;
  await expect.poll(async () => (await (await request.get(`/api/sessions/${id}?events=0`)).json()).session.phase, { timeout: 60_000 }).not.toBe("working");
  // Read what the finish raised, so the row is at rest.
  await request.post("/api/alerts/read", { data: { session_id: id } });
  // The owner is in another session, so the row is not the one on screen.
  const other = (await (await request.post("/api/sessions", { data: { model: STAND_IN, title: `Elsewhere ${tag}` } })).json()).session.id as string;
  await page.goto(`/s/${other}`);
  const row = page.getByTestId("session-list").locator(`[data-testid="session-row"][data-session="${id}"]`);
  await expect(row).toBeVisible();
  await expect(row).not.toHaveAttribute("data-unread", "true");

  await row.click({ button: "right" });
  const item = page.getByTestId("row-menu-unread");
  await expect(item).toHaveText("Mark as unread");
  await shoot(page, "row-unread-01-menu");
  await item.click();
  await expect(row).toHaveAttribute("data-unread", "true");
  // A press in the menu does not open the session as a press on the row does.
  await expect(page).toHaveURL(new RegExp(`/s/${other}`));
  expect(await unread()).toBeGreaterThan(0);
  await shoot(page, "row-unread-02-marked");

  // Marked already: the menu does not offer it again.
  await row.click({ button: "right" });
  await expect(page.getByTestId("row-menu")).toBeVisible();
  await expect(page.getByTestId("row-menu-unread")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Going to the session reads the mark.
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/s/${id}`));
  await expect(row).not.toHaveAttribute("data-unread", "true", { timeout: 15_000 });
  expect(await unread()).toBe(0);
});
