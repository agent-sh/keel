import { expect, test, type Page } from "./isolate.ts";
import { boxTools, HAIKU, shoot } from "./shots.ts";

// Feature: Point. A key (Alt .) or a row in the message box's + turns the page into a picker; the element
// clicked goes to the box as a chip that names it (its test id, the file and component that write it, its
// tokens and its size) with a picture of it attached, and the message carries both. Escape leaves the picker.
const workbench = (page: Page) => page.addInitScript(() => { localStorage.setItem("keel.focus", "false"); localStorage.setItem("keel.workbench", "true"); });
const middle = async (page: Page, id: string) => {
  const b = (await page.getByTestId(id).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
// A PNG's width and height, from its header.
const pngSize = (b64: string) => { const b = Buffer.from(b64, "base64"); return b.toString("latin1", 1, 4) === "PNG" ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null; };

test("the Point key picks an element: the box gets a chip that names it and its picture, and the message carries both", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Point at this" } })).json();
  await workbench(page);
  await page.goto(`/s/${session.id}`);
  const box = page.getByTestId("composer-box");
  await box.getByTestId("composer").click();
  const sheet = page.getByTestId("point-sheet"), tag = page.locator(".k-point-tag");

  // The key opens the picker; the element under the pointer is outlined and named. Escape leaves, and nothing is in the box.
  await page.keyboard.press("Alt+.");
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId("point-hint")).toHaveText(/Esc leaves/);
  const menu = await middle(page, "session-menu");
  await page.mouse.move(menu.x, menu.y);
  await expect(tag).toHaveAttribute("data-name", "session-menu");
  // Up takes what is around it, Down goes back.
  await page.keyboard.press("ArrowUp");
  await expect(tag).not.toHaveAttribute("data-name", "session-menu");
  await page.keyboard.press("ArrowDown");
  await expect(tag).toHaveAttribute("data-name", "session-menu");
  await shoot(page, "point-01-picking");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(box.getByTestId("point-chip")).toHaveCount(0);
  await expect(page.getByTestId("composer")).toBeFocused();

  // The row in the box's + does the same. The click names the element and does not press it: its menu stays shut.
  await (await boxTools(page)).getByTestId("point").click();
  await expect(sheet).toBeVisible();
  await page.mouse.move(menu.x, menu.y);
  await expect(tag).toHaveAttribute("data-name", "session-menu");
  await page.mouse.click(menu.x, menu.y);
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("session-menu")).not.toHaveAttribute("data-popup-open");
  const chip = box.getByTestId("point-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip.getByTestId("point-name")).toHaveText("session-menu");
  // Where it is written: the file and the line of its test id, from the table the build makes.
  await expect(chip.getByTestId("point-from")).toHaveText(/^SessionHeader\.tsx:\d+ \(\w+\)$/);
  // Its picture is in the chip, a real image of the element's own shape.
  const crop = chip.getByTestId("point-crop");
  await expect(crop).toBeVisible();
  await expect.poll(() => crop.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(8);
  await expect(page.getByTestId("composer")).toBeFocused();
  await shoot(page, "point-02-chip");

  // The message: the owner's words, the note under them, and the picture as its image.
  await page.getByTestId("composer").fill("script:say Noted.");
  await page.keyboard.press("Enter");
  await expect(box.getByTestId("point-chip")).toHaveCount(0);
  const sent = page.getByTestId("user-message").last();
  await expect(sent.getByTestId("user-point")).toContainText("session-menu");
  await expect(sent.getByTestId("user-point")).toHaveAttribute("title", /source: ui\/src\/components\/SessionHeader\.tsx:\d+/);
  const events = async () => ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[]);
  await expect.poll(async () => (await events()).some((e) => e.kind === "user")).toBe(true);
  const user = (await events()).find((e) => e.kind === "user")!.data;
  const text = String(user.text);
  expect(text.startsWith('script:say Noted.\n\n[Pointed at "session-menu"]\n')).toBe(true);
  expect(text).toMatch(/\n  where: .*session-menu\n/);
  expect(text).toMatch(/\n  element: <button class="[^"]+".* aria-label="Session actions"/);
  expect(text).toMatch(/\n  source: ui\/src\/components\/SessionHeader\.tsx:\d+ \(\w+\)\n/);
  expect(text).toMatch(/\n  box: [\d.]+ x [\d.]+ px at \d+, \d+\n/);
  // Its tokens by name: the type step, the colour, the ground it lies on.
  expect(text).toMatch(/\n  type: [\d.]+px.*weight \d+.*--text-/);
  expect(text).toMatch(/\n  color: --[a-z-]+/);
  expect(text).toMatch(/\n  ground: .*--[a-z-]+/);
  expect(text).toMatch(/\n  page: \/s\/:id, (light|dark) theme, window \d+ x \d+, text scale [\d.]+, a browser tab/);
  expect(text).toMatch(/\n  picture: the image of this message$/);
  expect(user.images).toHaveLength(1);
  expect(user.images[0].media_type).toBe("image/png");
  // The picture is the element, at twice its size or more.
  const size = pngSize(user.images[0].data)!, shape = (await page.getByTestId("session-menu").boundingBox())!;
  expect(size.w).toBeGreaterThanOrEqual(Math.floor(shape.width * 2));
  expect(Math.abs(size.w / size.h - shape.width / shape.height)).toBeLessThan(0.1);
  await shoot(page, "point-03-sent");
});

test("a phone has no Point: no key, no row in the box's +", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "No pointer here" } })).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").click();
  await page.keyboard.press("Alt+.");
  await expect(page.getByTestId("composer-box")).toBeVisible();
  await expect(page.getByTestId("point-sheet")).toHaveCount(0);
  await expect(page.getByTestId("point")).toHaveCount(0);
});
