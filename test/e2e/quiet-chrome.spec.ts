import { expect, test, type Locator } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the shell shows a control where it is needed and keeps the rest out
// of sight until it is pointed at or the keyboard reaches it. A control that
// stays quiet is still in the page (its place does not move when it shows), so
// these read its opacity: Playwright counts a transparent control as visible.
const opacity = (l: Locator) => l.evaluate((el) => Number(getComputedStyle(el).opacity));
// Opacity is eased (a short transition): poll until it settles.
const settles = (l: Locator, to: number) => expect.poll(() => opacity(l)).toBe(to);

test("a pane's head shows its tools when it is pointed at or focused", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Quiet pane head" } })).json();
  await page.goto(`/s/${session.id}`);
  const head = page.getByTestId("station-head");
  const tools = head.locator(".k-station-tools");
  await expect(head.getByTestId("station-close")).toBeAttached();
  // One pane: nowhere to move it, so no arrows.
  await expect(head.locator(".k-tool-move")).toHaveCount(0);
  // Pointer away from the head: its tools are quiet.
  await page.mouse.move(5, 900);
  await settles(tools, 0);
  await shoot(page, "quiet-01-head");
  await head.hover();
  await settles(tools, 1);
  await page.mouse.move(5, 900);
  await settles(tools, 0);
  // The keyboard reaches them as before, and they show while it is there.
  await head.getByTestId("station-pin").focus();
  await settles(tools, 1);
});
