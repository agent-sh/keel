import { expect, test } from "./isolate.ts";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { HAIKU, shoot } from "./shots.ts";

// Feature: an HTTP MCP server behind OAuth. Added by its URL it needs sign-in;
// Sign in opens the server's own page (discovery, client registration, PKCE),
// the approval comes back to the daemon, the server is ready, its tool works
// with tokens refreshed as they expire, and sign-out puts it back.
test("mcp oauth sign-in", async ({ page, request }) => {
  const fx = spawn("bun", [join(import.meta.dirname, "fixtures/oauth-mcp.ts")], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise<string>((res) => createInterface({ input: fx.stdout! }).once("line", res));
    const stats = async () => (await (await request.get(`http://127.0.0.1:${port}/stats`)).json());
    await request.delete("/api/mcp/servers/signed").catch(() => {});
    const start = Date.now();

    await page.goto("/");
    await page.getByTestId("composer").fill("/mcp");
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("mcp-panel");
    await panel.getByTestId("mcp-add-url-tab").click();
    await panel.getByTestId("mcp-add-name").fill("signed");
    await panel.getByTestId("mcp-add-target").fill(`http://127.0.0.1:${port}/mcp`);
    await panel.getByTestId("mcp-add-submit").click();
    const row = panel.locator('[data-testid="mcp-server"][data-name="signed"]');
    await expect(row).toHaveAttribute("data-state", "needs_auth", { timeout: 20_000 });
    await shoot(page, "mcp-oauth-01-needs-sign-in");

    // The server's page opens in a new tab; Allow sends the browser back to the daemon.
    const [popup] = await Promise.all([page.context().waitForEvent("page"), row.getByTestId("mcp-sign-in").click()]);
    await popup.waitForLoadState();
    await expect(popup.getByRole("heading")).toContainText("Allow Keel to use oauth-mcp?");
    await popup.getByRole("button", { name: "Allow" }).click();
    await expect(popup.locator("body")).toContainText("signed is connected");
    await popup.close();
    await expect(row).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
    await expect(row.getByTestId("mcp-tool-count")).toHaveText("1 tool");
    expect(await stats()).toMatchObject({ registrations: 1, authorized: 1, codes_redeemed: 1 });
    await shoot(page, "mcp-oauth-02-signed-in");

    // A model uses the tool; the 30 s token is refreshed before it is sent.
    const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU, title: "OAuth MCP" } })).json();
    await request.put(`/api/sessions/${session.id}/permissions`, { data: { mode: "full-auto" } });
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("composer").fill("Find the whoami tool of the signed MCP server with search_tools and run it with mcp_call. Reply with only what it answered.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId("assistant-text").last()).toContainText("fixture-owner");
    const s = await stats();
    expect(s.calls).toBeGreaterThan(0);
    expect(s.refreshes).toBeGreaterThan(0);
    expect(s.bad_tokens).toBe(0);
    await shoot(page, "mcp-oauth-03-tool");

    // Sign out: the server needs sign-in again.
    const out = await (await request.post("/api/mcp/servers/signed/sign-out")).json();
    expect(out.servers.find((x: any) => x.name === "signed").state).toBe("needs_auth");

    const mine = ((await (await request.get("/api/errors")).json()).errors as any[]).filter((e) => e.ts >= start && /mcp/i.test(JSON.stringify(e.context ?? {}) + e.message));
    expect(mine.map((e) => e.message)).toEqual([]);
    await request.delete("/api/mcp/servers/signed");
    await request.delete(`/api/sessions/${session.id}`);
  } finally {
    fx.kill();
  }
});
