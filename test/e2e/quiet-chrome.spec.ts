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

test("the head says what the session cost, once, and opens Usage", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Head cost" } })).json();
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: "script:say Done." } });
  await expect.poll(async () => (await (await request.get(`/api/sessions/${session.id}`)).json()).session.usage.output, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.goto(`/s/${session.id}`);
  const usage = page.getByTestId("session-header").getByTestId("session-usage");
  // One figure: the cost, no token counts beside it (they are in its title).
  await expect(usage).toHaveText(/^\$\d+\.\d+$/);
  await expect(usage).toHaveAttribute("title", /in \(\d+% cached\), .* out/);
  await usage.click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "usage");
  await shoot(page, "quiet-02-head-cost");
});
