import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SCRIPTED, shoot } from "./shots.ts";

const FIXTURE = `${import.meta.dirname}/fixtures/bulk-mcp.ts`;
const STAND_IN = "scripted:claude-stand-in";

test.afterEach(async ({ request }) => {
  await request.delete("/api/mcp/servers/bulk").catch(() => {});
});

// Feature: the context popup shows what the next request carries: the system
// prompt by its blocks, the tool definitions by source (an MCP server of forty
// tools is a row of its own, with how many are loaded and how to save them),
// and the messages by origin. The parts are scaled to add up to the tokens the
// provider counted, and the popup says they are estimates.
test("context popup: system prompt, tools by server and messages by origin", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!SCRIPTED || !models.some((m) => m.id === STAND_IN), "needs the scripted Claude stand-in: run on the scripted provider (KEEL_SCRIPTED_PROVIDER=1)");
  await request.delete("/api/mcp/servers/bulk").catch(() => {});
  expect((await request.post("/api/mcp/servers", { data: { name: "bulk", command: "bun", args: [FIXTURE] } })).ok()).toBe(true);
  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `context-parts-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: STAND_IN, title: "Context parts" } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
  const context = async () => (await (await request.get(`/api/sessions/${session.id}/context`)).json());
  try {
    // The server's forty tools are listed and none is loaded yet: its row costs nothing.
    await expect.poll(async () => (await context()).parts?.tools.groups.find((g: any) => g.key === "mcp:bulk")?.tools, { timeout: 30_000 }).toBe(40);

    // The model loads three of them by search; its reply is measured by the provider.
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "ToolSearch", input: { query: "select:mcp__bulk__item_01,mcp__bulk__item_02,mcp__bulk__item_03" } }])}`);
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const r = await (await request.get(`/api/sessions/${session.id}`)).json();
      return !r.running && r.events.filter((e: any) => e.kind === "turn_end").length;
    }, { timeout: 60_000 }).toBe(1);

    const c = await context();
    const bulk = c.parts.tools.groups.find((g: any) => g.key === "mcp:bulk");
    expect(bulk).toMatchObject({ kind: "mcp", tools: 40, carried: 3 });
    expect(bulk.tokens).toBeGreaterThan(0);
    expect(bulk.save).toContain("Customize > MCP servers");
    // Every part is a share of what the provider counted: together they are exactly that count.
    expect(c.parts.measured).toBe(true);
    const sum = (list: { tokens: number }[]) => list.reduce((n, x) => n + x.tokens, 0);
    expect(c.parts.system.blocks.length).toBeGreaterThan(1);
    expect(sum(c.parts.tools.groups)).toBe(c.parts.tools.tokens);
    expect(c.parts.tools.tokens).toBeLessThanOrEqual(c.context_used_tokens);
    expect(bulk.tokens).toBeLessThanOrEqual(c.context_used_tokens);
    expect(c.parts.system.tokens + c.parts.tools.tokens + c.parts.messages.tokens).toBe(c.context_used_tokens);
    expect(c.parts.messages.rows.map((r: any) => r.key)).toContain("owner");

    // The popup: the server's row, how many are loaded, how to save them, and the estimate marked as such.
    await page.getByTestId("context-meter").click();
    const popup = page.getByTestId("context-popup");
    const row = popup.locator('[data-testid="tools-group"][data-group="mcp:bulk"]');
    await expect(row).toContainText("bulk");
    await expect(row).toContainText("3 of 40");
    await expect(popup.getByTestId("tools-save").filter({ hasText: "Customize > MCP servers" })).toHaveCount(1);
    // The sources with nothing in the request are one line, not a row each with the same sentence.
    await expect(popup.getByTestId("tools-deferred")).toHaveText(/^Deferred: \d+ groups?, none in the request$/);
    await expect(popup.getByTestId("tools-group").filter({ hasText: " 0 of " })).toHaveCount(0);
    await expect(popup.getByTestId("tools-save").filter({ hasText: "Reached through" })).toHaveCount(0);
    await expect(popup.locator('[data-testid="context-part"][data-part="system"]')).toBeVisible();
    await expect(popup.locator('[data-testid="context-part"][data-part="tools"] [data-testid="context-part-tokens"]')).toContainText("~");
    await expect(popup.locator('[data-testid="context-row"][data-row="message:owner"]')).toBeVisible();
    await expect(popup.getByTestId("context-parts-note")).toContainText("Estimates");
    await popup.locator('[data-testid="context-part"][data-part="system"]').locator("summary").click();
    await expect(popup.locator('[data-testid="context-part"][data-part="system"]')).toHaveAttribute("open", "");
    await shoot(page, "context-parts-1920");

    // A phone: the popup fits the screen and its rows read.
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    // (A tap on the resting box raises the tools, where the ring is.)
    await page.reload();
    await page.getByTestId("composer").click();
    await page.getByTestId("context-meter").click({ timeout: 10_000 });
    await expect(popup).toBeVisible();
    await popup.locator('[data-testid="context-part"][data-part="system"]').evaluate((d) => ((d as HTMLDetailsElement).open = true));
    const box = await popup.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    await expect(popup.locator('[data-testid="tools-group"][data-group="mcp:bulk"]')).toBeVisible();
    await shoot(page, "context-parts-390");
  } finally {
    await request.delete(`/api/sessions/${session.id}`).catch(() => {});
  }
});
