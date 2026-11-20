import { expect, test } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: the rail always says which session is which. With room it is the
// list (title, state, time, by folder), with one pane, two or three open at
// this width. It folds to marks only by choice (the toggle or Ctrl B,
// remembered) or when the panes leave no room (three in a narrower window); a
// mark is the state's shape and a short code of the title, no two alike, and
// the card beside the entry under the pointer or the focus gives the title,
// the state, the folder and the last activity. Without room the toggle lays
// the list over the panes until a session is picked. A failed session is
// marked failed on a fresh page, before any of its events are loaded (the
// daemon keeps the mark). The pane head shows the whole title in the text
// face.
const MODEL = "scripted:stand-in";
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1700, height: 980 } });

test("the list with room, marks without, the card and the toggle", async ({ page, request }) => {
  const tag = Date.now().toString(36);
  const mk = async (title: string, text: string) => {
    const s = (await (await request.post("/api/sessions", { data: { model: MODEL, title } })).json()).session;
    await request.post(`/api/sessions/${s.id}/messages`, { data: { text } });
    await expect.poll(async () => (await (await request.get(`/api/sessions/${s.id}`)).json()).events.some((e: any) => e.kind === "turn_end" || e.kind === "error"), { timeout: 30_000 }).toBe(true);
    return s.id as string;
  };
  const failed = await mk(`Charge the card on file ${tag}`, "Charge it. script:billing");
  const twin = await mk(`Check the cache headers on the asset host ${tag}`, "Check them.");
  const done = await mk(`Why the nightly export job times out on large tenants and what to change in the batch size ${tag}`, "Look into it.");
  await expect.poll(async () => (await (await request.get(`/api/sessions/${failed}`)).json()).session.settings.failed_ms).toBeGreaterThan(0);
  const folder = (await (await request.get(`/api/sessions/${done}`)).json()).session.workspace.split("/").pop() as string;

  const side = page.getByTestId("sidebar");
  const rail = page.getByTestId("session-list");
  const entry = (id: string) => rail.locator(`[data-testid="session-row"][data-session="${id}"]`);
  const card = page.getByTestId("rail-card");
  const stations = page.locator("section.k-station[data-station]");
  const stored = (k: string) => page.evaluate((k) => localStorage.getItem(k), k);
  // Writes a stored choice and reloads in one step, so the page cannot write its own value back in between.
  const reloadWith = async (k: string, v: string) => {
    await Promise.all([page.waitForEvent("load"), page.evaluate(([k, v]) => { localStorage.setItem(k!, v!); location.reload(); }, [k, v]).catch(() => {})]);
  };

  // One station (the helm at full width): the list, nothing chosen yet.
  await page.addInitScript(() => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("keel.focus", "true"); sessionStorage.setItem("seeded", "1"); } });
  await page.goto(`/s/${done}`);
  await expect(stations).toHaveCount(1);
  await expect(side).toHaveAttribute("data-open", "true");
  await expect(entry(done).locator(".k-row-title")).toBeVisible();
  await expect(entry(done)).toContainText(`batch size ${tag}`);
  await expect(entry(done)).toHaveAttribute("data-watch", "done");
  await expect(entry(failed)).toHaveAttribute("data-watch", "fail");
  await expect(entry(failed).getByTestId("row-state")).toHaveText("Failed");
  await expect(page.getByTestId("rail-toggle")).toHaveAttribute("aria-expanded", "true");
  await shoot(page, "rail-01-one-station-list");

  // The card beside a row: title, state, folder, last activity.
  await entry(failed).hover();
  await expect(card).toHaveAttribute("data-watch", "fail");
  await expect(card).toContainText(`Charge the card on file ${tag}`);
  await expect(card).toContainText("Failed");
  await expect(card).toContainText(folder);
  await expect(card.locator("dl")).toContainText("Active");
  await shoot(page, "rail-02-list-card");

  // Two stations (asked for: one pane is the default): still the list. The keyboard walks it, and the focus brings the card.
  await Promise.all([page.waitForEvent("load"), page.evaluate((ids) => {
    localStorage.setItem("keel.focus", "false");
    localStorage.setItem("keel.panes", JSON.stringify({ count: 2, slots: ids, sizes: {}, active: 0 }));
    location.reload();
  }, [done, failed]).catch(() => {})]);
  await expect(stations).toHaveCount(2);
  await expect(side).toHaveAttribute("data-open", "true");
  await entry(done).focus();
  await expect(card).toContainText(`batch size ${tag}`);
  await page.keyboard.press("ArrowDown");
  await expect(entry(done)).not.toBeFocused();
  await expect(rail.locator('[data-testid="session-row"]:focus')).toHaveCount(1);
  await page.keyboard.press("ArrowUp");
  await expect(entry(done)).toBeFocused();
  await shoot(page, "rail-03-two-stations-list");

  // Folded by choice (Ctrl B): marks, banded by state, each with its own code; the choice holds over a reload.
  await page.keyboard.press("Control+b");
  await expect(side).not.toHaveAttribute("data-open", "true");
  expect(await stored("keel.list")).toBe("false");
  await page.reload();
  await expect(side).not.toHaveAttribute("data-open", "true");
  await expect(entry(failed)).toHaveAttribute("data-watch", "fail");
  const failBand = rail.getByTestId("rail-band").filter({ has: page.locator(`[data-session="${failed}"]`) });
  await expect(failBand).toHaveAttribute("data-watch", "fail");
  await expect(failBand.locator(".k-marks-head")).toContainText(/Fail\s*\d+/i);
  const codes = await rail.getByTestId("rail-code").allTextContents();
  expect(codes.length).toBeGreaterThanOrEqual(3);
  expect(codes.every((c) => c.length >= 2)).toBe(true);
  expect(new Set(codes).size).toBe(codes.length);
  // Same initials (Charge the card, Check the cache), told apart.
  const [c1, c2] = [await entry(failed).getByTestId("rail-code").textContent(), await entry(twin).getByTestId("rail-code").textContent()];
  expect(c1![0]).toBe("C");
  expect(c2![0]).toBe("C");
  expect(c1).not.toBe(c2);
  await entry(done).hover();
  await expect(card).toContainText(`batch size ${tag}`);
  await expect(card).toContainText("Done");
  await expect(card).toContainText(folder);
  await shoot(page, "rail-04-two-stations-folded-card");
  await entry(failed).focus();
  await expect(card).toHaveAttribute("data-watch", "fail");
  await expect(card).toContainText("credit balance");

  // The toggle brings the list back, and that is remembered too.
  await page.getByTestId("rail-toggle").click();
  await expect(side).toHaveAttribute("data-open", "true");
  expect(await stored("keel.list")).toBe("true");

  // Three panes (the owner's number) still leave room at this width: the list stays.
  await page.getByTestId("panes-3").click();
  await entry(twin).click(); // it takes the free pane
  await expect(stations).toHaveCount(3);
  await expect(side).toHaveAttribute("data-open", "true");
  await expect(entry(twin).locator(".k-row-title")).toBeVisible();
  await shoot(page, "rail-05-three-stations-list");
  // Folded by choice with three panes: the marks and the card.
  await page.getByTestId("rail-toggle").click();
  await expect(side).not.toHaveAttribute("data-open", "true");
  await entry(twin).hover();
  await expect(card).toContainText(`asset host ${tag}`);
  await shoot(page, "rail-06-three-stations-folded-card");
  await page.getByTestId("rail-toggle").click();
  await expect(side).toHaveAttribute("data-open", "true");

  // A narrower window has no room for the list beside three panes: marks, though the list is the choice.
  await page.setViewportSize({ width: 1500, height: 980 });
  await expect(side).not.toHaveAttribute("data-open", "true");
  await expect(stations).toHaveCount(3);
  await expect(entry(twin).getByTestId("rail-code")).toBeVisible();
  // The toggle lays the list over the panes; Escape puts it away; picking a session does too.
  await page.getByTestId("rail-toggle").click();
  await expect(side).toHaveAttribute("data-over", "true");
  await expect(entry(twin).locator(".k-row-title")).toBeVisible();
  await expect(stations).toHaveCount(3);
  await shoot(page, "rail-07-no-room-list-over");
  await page.keyboard.press("Escape");
  await expect(side).not.toHaveAttribute("data-open", "true");
  await page.keyboard.press("Control+b");
  await expect(side).toHaveAttribute("data-over", "true");
  await entry(failed).click();
  await expect(page).toHaveURL(new RegExp(`/s/${failed}`));
  await expect(side).not.toHaveAttribute("data-open", "true");
  expect(await stored("keel.list")).toBe("true");
  // With the room back the list is back by itself.
  await page.setViewportSize({ width: 1700, height: 980 });
  await expect(side).toHaveAttribute("data-open", "true");

  // The station of a long title shows it whole, over two lines at most.
  await entry(done).click();
  const head = page.locator(`section.k-station[data-station="${done}"]`).getByTestId("station-head");
  const title = head.getByRole("heading");
  await expect(title).toContainText(`batch size ${tag}`);
  expect(await title.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Plex Sans");
  await shoot(page, "rail-08-station-title");

  // A new turn that works clears the failed mark.
  await request.post(`/api/sessions/${failed}/messages`, { data: { text: "Try again." } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${failed}`)).json()).session.settings.failed_ms ?? null, { timeout: 30_000 }).toBe(null);
  await expect(entry(failed)).toHaveAttribute("data-watch", "done");

  for (const id of [failed, twin, done]) await request.delete(`/api/sessions/${id}`);
  for (const e of (await (await request.get("/api/errors?resolved=0")).json()).errors) if (e.message.includes("credit balance")) await request.patch(`/api/errors/${e.id}`, { data: { resolved: true } });
});
