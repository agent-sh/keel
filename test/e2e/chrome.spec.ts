import { expect, test } from "./isolate.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { HAIKU, shoot, openMcp } from "./shots.ts";

// Feature: the Chrome bridge built in. Every session has it with no setup: the
// MCP panel lists it as built in and idle (its tools ship with Keel, so nothing
// started yet). In ask mode a read (the tab list) runs without a card, and an
// action (a new tab) asks; a denied one never reaches the bridge.
// Run the daemon with KEEL_CHROME_BRIDGE at test/e2e/fixtures/chrome-bridge-standin.ts
// so no real browser is driven; against the real bridge only the tab list is read.
test("chrome bridge", async ({ page, request }) => {
  const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
  const servers = (await (await request.get("/api/mcp/servers")).json()).servers;
  const chrome = servers.find((s: any) => s.name === "chrome");
  expect(chrome?.bundled).toBeTruthy();
  test.skip(chrome.state === "missing", "the Chrome bridge is not installed here");
  expect((await request.delete("/api/mcp/servers/chrome")).status()).toBe(409);

  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("MCP servers");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/settings\/mcp$/);
  const row = await openMcp(page, "chrome");
  await expect(row.getByTestId("mcp-bundled")).toContainText("Chrome bridge");
  await expect(row.getByTestId("mcp-tool-count")).toHaveText(/\d+ tools/);
  await shoot(page, "chrome-01-panel");

  const ws = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `chrome-${Date.now()}`);
  mkdirSync(ws, { recursive: true });
  const { session } = await (await request.post("/api/sessions", { data: { workspace: ws, model: HAIKU } })).json();
  await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "ask", sandbox: "off" } });
  await page.goto(`/s/${session.id}`);
  await page.getByTestId("composer").fill(
    "Find the Chrome tools with search_tools (query: chrome tabs). Run chrome__chrome_tabs with mcp_call and note the tab titles. " +
      "Then run chrome__chrome_new_tab with mcp_call with url https://example.test/new. Finally reply with the tab titles you saw, comma separated.",
  );
  await page.keyboard.press("Enter");

  const card = page.getByTestId("approval");
  await expect(card).toBeVisible({ timeout: 120_000 });
  await expect(card).toContainText("chrome__chrome_new_tab");
  await shoot(page, "chrome-02-card");
  await card.getByTestId("deny").click();
  await page.getByTestId("deny-reason").fill("no new tabs in this test");
  await page.getByTestId("deny-send").click();

  await expect(page.getByTestId("turn-end")).toBeVisible({ timeout: 120_000 });
  const calls = page.getByTestId("tool-call").filter({ hasText: "mcp_call" });
  await expect(calls.first()).toBeVisible();
  // The read ran with no card: exactly one card was raised, for the action.
  const approvals = (await (await request.get(`/api/sessions/${session.id}/approvals?all`)).json()).approvals ?? [];
  expect(approvals.map((a: any) => a.tool)).toEqual(["chrome__chrome_new_tab"]);
  if (chrome.target.includes("chrome-bridge-standin")) await expect(page.getByTestId("assistant-text").last()).toContainText("Stand-in page");
  await shoot(page, "chrome-03-chat");

  const after = (await (await request.get("/api/mcp/servers")).json()).servers.find((s: any) => s.name === "chrome");
  expect(after.state).toBe("ready");
  const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
  expect(errorsAfter).toBe(errorsBefore);
});
