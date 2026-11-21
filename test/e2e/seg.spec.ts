import { expect, test } from "./isolate.ts";
import type { Locator, Page } from "./isolate.ts";
import { shoot } from "./shots.ts";

// Feature: one segmented control with one keyboard. The session list's tabs,
// the Errors tabs and a Settings choice are the same component: one Tab stop
// on the chosen option, the arrow keys move and choose and wrap at the ends,
// Home and End choose the first and the last. Its track holds buttons only.
test("tabs and segmented choices share one keyboard", async ({ page, request }) => {
  const model = process.env.KEEL_TEST_MODEL ?? "scripted:stand-in";
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "One keyboard for every choice" } })).json();
  await page.setViewportSize({ width: 1920, height: 1040 });
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").first().waitFor();

  // What a track says about itself: one Tab stop, on the chosen option, and no child but its options.
  const shape = (track: Locator) => track.evaluate((el) => {
    const kids = [...el.children] as HTMLElement[];
    const on = (k: HTMLElement) => k.getAttribute("aria-selected") === "true" || k.getAttribute("aria-checked") === "true";
    return { buttons: kids.every((k) => k.tagName === "BUTTON"), stops: kids.filter((k) => k.tabIndex === 0).length, stopChosen: kids.filter((k) => k.tabIndex === 0).every(on), chosen: kids.filter(on).length, inputs: el.querySelectorAll("input").length };
  });
  const sound = { buttons: true, stops: 1, stopChosen: true, chosen: 1, inputs: 0 };
  const chosen = (track: Locator) => track.locator('[aria-selected="true"], [aria-checked="true"]');
  const walk = async (p: Page, track: Locator, names: string[]) => {
    expect(await shape(track)).toEqual(sound);
    await chosen(track).focus();
    const start = names.indexOf((await chosen(track).textContent())!.replace(/\d+$/, "").trim());
    expect(start).toBeGreaterThanOrEqual(0);
    // Right moves and chooses, and wraps after the last.
    for (let i = 1; i <= names.length; i++) {
      await p.keyboard.press("ArrowRight");
      await expect(chosen(track)).toContainText(names[(start + i) % names.length]!);
      await expect(chosen(track)).toBeFocused();
      expect(await shape(track)).toEqual(sound);
    }
    await p.keyboard.press("End");
    await expect(chosen(track)).toContainText(names.at(-1)!);
    await expect(chosen(track)).toBeFocused();
    await p.keyboard.press("ArrowLeft");
    await expect(chosen(track)).toContainText(names.at(-2)!);
    await p.keyboard.press("Home");
    await expect(chosen(track)).toContainText(names[0]!);
    await expect(chosen(track)).toBeFocused();
    // Left from the first wraps to the last, and back.
    await p.keyboard.press("ArrowLeft");
    await expect(chosen(track)).toContainText(names.at(-1)!);
    await p.keyboard.press("Home");
  };

  // The pane count is the same control with glyphs for options: each is square, so the
  // track stays narrow and the rail's fold toggle keeps its place inside the rail.
  const count = await page.getByTestId("pane-count").evaluate((el) => {
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const kids = [...el.children].map((k) => k.getBoundingClientRect());
    const rail = el.closest(".k-rail")!.getBoundingClientRect(), fold = el.closest(".k-rail")!.querySelector(".k-fold")!.getBoundingClientRect();
    return { n: kids.length, widest: Math.max(...kids.map((k) => k.width)) / rem, tall: kids[0]!.height / rem, track: el.getBoundingClientRect().width / rem, room: rail.right - fold.right };
  });
  console.log(`pane count: ${JSON.stringify(count)}`);
  expect(count.widest).toBeCloseTo(count.tall, 1);
  expect(count.track).toBeLessThanOrEqual(count.n * 1.5 + 0.6);
  expect(count.room).toBeGreaterThanOrEqual(6);

  await walk(page, page.getByRole("tablist", { name: "Session list" }), ["Sessions", "Archived"]);
  await shoot(page, "seg-01-session-list");
  await page.getByTestId("errors-button").first().click();
  await walk(page, page.getByRole("tablist", { name: "Which errors" }), ["Open", "Resolved"]);
  await page.keyboard.press("Escape");
  await page.getByTestId("inbox-button").first().click();
  await walk(page, page.getByRole("tablist", { name: "Inbox views" }), ["Alerts", "Activity"]);
  await page.keyboard.press("Escape");

  await page.goto("/settings/general");
  const theme = page.getByRole("radiogroup", { name: "Theme" });
  const before = (await chosen(theme).textContent())!;
  await walk(page, theme, ["System", "Light", "Dark"]);
  await theme.getByRole("radio", { name: before }).click();
  await shoot(page, "seg-02-settings");
  // Every track on the page is that one control.
  for (const track of await page.locator(".k-seg").all()) expect(await shape(track)).toEqual(sound);
});
