import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the folded rail tells sessions apart at a glance. Marks are banded
// by what each session needs (Need, Work, Fail, Done), each band headed by its
// count; a failed session is in the Fail band on a fresh page, before any of
// its events are loaded (the daemon keeps the mark); hovering a mark shows its
// card with the title and where it runs. The station head shows the whole
// title in the text face.
const MODEL = "scripted:stand-in";
test.use({ storageState: { cookies: [], origins: [] } });

test("rail bands, the failed mark and the hover card", async ({ page, request }) => {
  const tag = Date.now().toString(36);
  const mk = async (title: string, text: string) => {
    const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json()).session;
    await request.post(`/api/sessions/${s.id}/messages`, { data: { text } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.some((e: any) => e.kind === "turn_end" || e.kind === "error"), { timeout: 30_000 }).toBe(true);
    return s.id as string;
  };
  const failed = await mk(`Charge the card on file ${tag}`, "Charge it. script:billing");
  const done = await mk(`Why the nightly export job times out on large tenants and what to change in the batch size ${tag}`, "Look into it.");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${failed}`)).json()).session.settings.failed_ms).toBeGreaterThan(0);

  await page.goto("/");
  const rail = page.getByTestId("session-list");
  const tick = (id: string) => rail.locator(`[data-session="${id}"]`);
  await expect(tick(failed)).toHaveAttribute("data-watch", "fail");
  await expect(tick(done)).toHaveAttribute("data-watch", "done");
  const failBand = rail.getByTestId("rail-band").filter({ has: page.locator(`[data-session="${failed}"]`) });
  await expect(failBand).toHaveAttribute("data-watch", "fail");
  await expect(failBand.locator(".k-marks-head")).toContainText(/Fail\s*\d+/i);

  await tick(done).hover();
  const card = page.getByTestId("rail-card");
  await expect(card).toContainText(`batch size ${tag}`);
  await expect(card).toContainText("Done");
  await shoot(page, "rail-01-card");
  await tick(failed).hover();
  await expect(card).toHaveAttribute("data-watch", "fail");
  await expect(card).toContainText(`Charge the card on file ${tag}`);
  await shoot(page, "rail-02-failed-card");

  // The station of a long title shows it whole, over two lines at most.
  await tick(done).click();
  const head = page.locator(`section.k-station[data-station="${done}"]`).getByTestId("station-head");
  const title = head.getByRole("heading");
  await expect(title).toContainText(`batch size ${tag}`);
  expect(await title.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Plex Sans");
  await shoot(page, "rail-03-station-title");

  // A new turn that works clears the failed mark.
  await request.post(`/api/sessions/${failed}/messages`, { data: { text: "Try again." } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${failed}`)).json()).session.settings.failed_ms ?? null, { timeout: 30_000 }).toBe(null);
  await expect(tick(failed)).toHaveAttribute("data-watch", "done");

  for (const id of [failed, done]) await request.delete(`/api/sessions/${id}`);
  for (const e of (await (await request.get("/api/errors?resolved=0")).json()).errors) if (e.message.includes("credit balance")) await request.patch(`/api/errors/${e.id}`, { data: { resolved: true } });
});
