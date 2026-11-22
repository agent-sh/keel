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

// Where a choice does something that must be meant, an arrow key does not make it. In the
// permission menu the arrows, Home and End only move the focus, for the modes and for the
// sandbox, and stop at the ends; Space, Enter or a click chooses. Tabs in a row take Left
// and Right only, a click on the option already chosen saves nothing, and every set of
// tabs names the panel it switches.
test("an arrow key never loosens permissions, and tabs keep to their own keys", async ({ page, request }) => {
  const model = process.env.KEEL_TEST_MODEL ?? "scripted:stand-in";
  const { session } = await (await request.post("/api/sessions", { data: { model, title: "Choices that must be meant" } })).json();
  await page.setViewportSize({ width: 1920, height: 1040 });
  const writes: string[] = [];
  page.on("request", (r) => { if (["PUT", "PATCH", "POST"].includes(r.method()) && /\/api\/(sessions\/[^/]+\/permissions|settings|alerts\/settings)/.test(r.url())) writes.push(`${r.method()} ${new URL(r.url()).pathname.replace(session.id, ":id")}`); });
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").first().waitFor();

  await page.getByTestId("permission-menu").first().click();
  const modes = page.getByRole("radiogroup", { name: "Permission mode" });
  await modes.waitFor();
  const checked = (group: typeof modes) => group.locator('[aria-checked="true"]');
  const was = await checked(modes).getAttribute("data-testid");
  // The menu opens with the keyboard on the mode in force.
  await expect(checked(modes)).toBeFocused();
  for (const key of ["ArrowDown", "ArrowDown", "ArrowDown", "End", "ArrowDown", "Home", "ArrowUp", "ArrowUp"]) await page.keyboard.press(key);
  // Home, then Up twice: still the first row, not wrapped to the last.
  await expect(modes.getByRole("radio").first()).toBeFocused();
  expect(await checked(modes).getAttribute("data-testid")).toBe(was);
  // The sandbox's choices take the keys the same way where the machine can build a sandbox;
  // where it cannot, the daemon says why and they are disabled: nothing to walk, and the test says so.
  const can = (await (await request.get("/api/permissions/settings")).json()).sandbox;
  if (can.available) {
    const sandbox = page.getByRole("radiogroup", { name: "Sandbox" });
    const box = await checked(sandbox).getAttribute("data-testid");
    await checked(sandbox).focus();
    for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "Home", "ArrowLeft", "End"]) await page.keyboard.press(key);
    await expect(sandbox.getByRole("radio").last()).toBeFocused();
    expect(await checked(sandbox).getAttribute("data-testid")).toBe(box);
  } else test.info().annotations.push({ type: "skipped: no sandbox on this machine", description: `the arrow keys on the sandbox's choices were not checked (${can.reason})` });
  expect(writes).toEqual([]);
  // Space on a mode chooses it, once.
  const other = modes.getByRole("radio").filter({ hasNot: page.locator('[aria-checked="true"]') }).and(page.locator('[aria-checked="false"]')).first();
  const want = await other.getAttribute("data-testid");
  await other.focus();
  await page.keyboard.press("Space");
  await expect(checked(modes)).toHaveAttribute("data-testid", want!);
  expect(writes).toEqual(["PUT /api/sessions/:id/permissions"]);
  await shoot(page, "seg-03-permission-menu");
  await page.keyboard.press("Escape");

  // Tabs in a row: Up and Down are not theirs.
  const list = page.getByRole("tablist", { name: "Session list" });
  await list.getByRole("tab", { selected: true }).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(list.getByRole("tab", { selected: true })).toHaveText("Sessions");
  // Each set of tabs names its panel, and the panel names its tab.
  const tied = async (tabs: typeof list) => {
    const tab = tabs.getByRole("tab", { selected: true });
    const panel = page.locator(`[id="${await tab.getAttribute("aria-controls")}"]`);
    await expect(panel).toHaveAttribute("role", "tabpanel");
    await expect(panel).toHaveAttribute("aria-labelledby", (await tab.getAttribute("id"))!);
  };
  await tied(list);
  await page.getByTestId("errors-button").first().click();
  await tied(page.getByRole("tablist", { name: "Which errors" }));
  await page.keyboard.press("Escape");

  // A click on the option already chosen saves nothing; a click on another saves once.
  await page.goto("/settings/daemon");
  const awake = page.getByRole("radiogroup", { name: "Keep awake" });
  await awake.waitFor();
  writes.length = 0;
  await checked(awake).click();
  await page.waitForTimeout(300);
  expect(writes).toEqual([]);

  // The MCP form's Kind: an arrow does not switch it, and the lines typed for a kind are kept
  // while the other kind is looked at.
  await page.goto("/settings/mcp");
  await page.getByTestId("toolkit-add-+add").click();
  const kind = page.getByRole("radiogroup", { name: "Kind" });
  const lines = page.getByTestId("mcp-add-extra");
  await lines.fill("LOG_LEVEL=warn");
  await checked(kind).focus();
  await page.keyboard.press("ArrowRight");
  await expect(checked(kind)).toHaveText("Local command");
  await expect(lines).toHaveValue("LOG_LEVEL=warn");
  await page.keyboard.press("Enter");
  await expect(checked(kind)).toHaveText("Remote URL");
  await expect(lines).toHaveValue("");
  await lines.fill("X-Team: tools");
  await kind.getByRole("radio", { name: "Local command" }).click();
  await expect(lines).toHaveValue("LOG_LEVEL=warn");
  await kind.getByRole("radio", { name: "Remote URL" }).click();
  await expect(lines).toHaveValue("X-Team: tools");
});
