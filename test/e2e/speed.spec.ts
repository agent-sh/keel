import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the speed setting. A model whose listing sells a speed besides
// standard (the ChatGPT plan's Fast and Ultrafast, a catalog's Priority or
// Fast) gets a speed menu with what each costs; the session runs its next
// request at that speed and the call records the tier that served it. A model
// that sells none shows no menu.
test("speed: offered where the listing sells it, sent and recorded", async ({ page, request }) => {
  const { models } = await (await request.get("/api/models")).json();
  // Prefer the plan's Ultrafast (no per-token spend), else any offer on a plan.
  const withSpeed = (id: string) => models.find((m: any) => !m.hidden && m.billing === "subscription" && m.speeds?.some((o: any) => o.id === id));
  const model = withSpeed("ultrafast") ?? withSpeed("priority");
  test.skip(!model, "no plan model with a speed offer is listed");
  const offer = model.speeds.find((o: any) => o.id === "ultrafast") ?? model.speeds[0];

  // A model without offers: no speed menu.
  const plain = (await (await request.post("/api/sessions", { data: { model: HAIKU } })).json()).session;
  await page.goto(`/s/${plain.id}`);
  await expect(page.getByTestId("composer")).toBeVisible();
  await expect(page.getByTestId("speed-picker")).toHaveCount(0);
  // The daemon refuses a speed the model does not sell.
  expect((await request.patch(`/api/sessions/${plain.id}`, { data: { settings: { speed: offer.id } } })).status()).toBe(400);

  const s = (await (await request.post("/api/sessions", { data: { model: model.id } })).json()).session;
  await page.goto(`/s/${s.id}`);
  await page.getByTestId("speed-picker").click();
  const menu = page.getByTestId("speed-menu");
  await expect(menu.locator('[data-speed="standard"]')).toBeVisible();
  if (offer.note) await expect(menu.locator(`[data-speed="${offer.id}"]`)).toContainText(offer.note);
  await shoot(page, "speed-01-menu");
  await menu.locator(`[data-speed="${offer.id}"]`).click();
  await expect(page.getByTestId("speed-picker")).toContainText(offer.label);

  await page.getByTestId("composer").fill("Reply with the word ok only.");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
  await shoot(page, "speed-02-after-turn");

  // The call went at the chosen speed: its usage names the tier that served it.
  const events = (await (await request.get(`/api/sessions/${s.id}`)).json()).events;
  const step = events.filter((e: any) => e.kind === "assistant").at(-1);
  expect(step.data.stop).not.toBe("error");
  expect(step.data.usage.speed).toBeTruthy();
  expect(["default", "standard"]).not.toContain(step.data.usage.speed);

  // Back to standard: the setting is cleared.
  await page.getByTestId("speed-picker").click();
  await page.getByTestId("speed-menu").locator('[data-speed="standard"]').click();
  await expect(page.getByTestId("speed-picker")).toContainText("Standard");
  for (const id of [plain.id, s.id]) await request.delete(`/api/sessions/${id}`);
});
