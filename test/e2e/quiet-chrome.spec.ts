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

test("the list's top rows say their shortcut only where the pointer or the keyboard is", async ({ page }) => {
  await page.goto("/");
  const key = (id: string) => page.getByTestId(id).locator(".k-act-key");
  await expect(key("open-palette")).toBeAttached();
  await page.mouse.move(1100, 900);
  for (const id of ["new-session", "open-palette", "open-helper"]) await settles(key(id), 0);
  await page.getByTestId("open-palette").hover();
  await settles(key("open-palette"), 1);
  await settles(key("open-helper"), 0);
  await page.mouse.move(1100, 900);
  await page.getByTestId("open-helper").focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await settles(key("open-helper"), 1);
  await shoot(page, "quiet-03-rail-keys");
});

test("an agent's line names its type only when the call picked one", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:claude-stand-in", title: "Agent lines" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
  const agent = (description: string, subagent_type?: string) => ({ name: "Agent", input: { description, prompt: "script:say Looked.", ...(subagent_type ? { subagent_type } : {}) } });
  await request.post(`/api/sessions/${session.id}/messages`, { data: { text: `script:calls ${JSON.stringify([agent("Plain look"), agent("Default look", "general-purpose"), agent("Search look", "Explore")])}` } });
  await page.goto(`/s/${session.id}`);
  const line = (t: string) => page.getByTestId("agent-call").filter({ hasText: t });
  // A finished turn's agents fold into one line: opened, it lists each.
  await page.getByRole("button", { name: /^Started 3 agents/ }).click({ timeout: 60_000 });
  await expect(line("Search look").getByTestId("agent-call-status")).toBeAttached();
  await expect(line("Search look").getByTestId("agent-call-type")).toHaveText("Explore");
  await expect(line("Plain look").getByTestId("agent-call-type")).toHaveCount(0);
  await expect(line("Default look").getByTestId("agent-call-type")).toHaveCount(0);
  await expect(page.getByTestId("agent-call").filter({ hasText: "general-purpose" })).toHaveCount(0);
  await shoot(page, "quiet-04-agent-lines");
});
