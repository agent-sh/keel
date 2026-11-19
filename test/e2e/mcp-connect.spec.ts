import { expect, test } from "./isolate.ts";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { shoot } from "./shots.ts";

// Feature: connect an app. The suggested apps (their makers' own servers)
// each say what they need to sign in, read from the server; a server found in
// the MCP registry is added with the header it asks for, and signs in with
// the server's own page.
test("mcp connect an app", async ({ page, request }) => {
  const info = await (await request.get("/api/mcp/connectors")).json();
  test.skip(!String(info.registry).startsWith("file://"), "needs a saved registry listing (KEEL_MCP_REGISTRY=file://...)");
  const fx = spawn("bun", [join(import.meta.dirname, "fixtures/oauth-mcp.ts")], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const port = await new Promise<string>((res) => createInterface({ input: fx.stdout! }).once("line", res));
    await request.delete("/api/mcp/servers/team-tools").catch(() => {});
    const errorsBefore = (await (await request.get("/api/errors")).json()).errors.length;
    const entry = (name: string, server: Record<string, unknown>, status = "active") => ({ server: { name, version: "1.0.0", description: `${name} for tests`, ...server }, _meta: { "io.modelcontextprotocol.registry/official": { status, isLatest: true } } });
    writeFileSync(new URL(info.registry).pathname, JSON.stringify({
      servers: [
        entry("io.example/team-tools", { title: "Team tools", remotes: [{ type: "streamable-http", url: `http://127.0.0.1:${port}/mcp`, headers: [{ name: "X-Team", isRequired: true, description: "Your team" }] }] }),
        // Neither of these is offered: a URL with a placeholder, and a deleted entry.
        entry("io.example/per-tenant", { remotes: [{ type: "streamable-http", url: "https://{tenant}.example.com/mcp" }] }),
        entry("io.example/gone", { remotes: [{ type: "streamable-http", url: "https://gone.example.com/mcp" }] }, "deleted"),
      ],
    }));

    await page.goto("/");
    await page.getByTestId("composer").fill("/mcp");
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("mcp-panel");
    await panel.getByTestId("toolkit-add-+connect").click();
    // Every suggested app says what it takes, from its own server's answer.
    const cards = panel.getByTestId("mcp-connector");
    await expect(cards).toHaveCount(info.connectors.length);
    for (const c of info.connectors) await expect(panel.locator(`[data-testid="mcp-connector"][data-id="${c.id}"]`)).toHaveAttribute("data-access", /^(open|sign_in|client_id|unreachable)$/);
    // An app whose provider registers no clients on the fly asks for the owner's own, naming the redirect to allow.
    const needsClient = info.connectors.find((c: any) => c.access.kind === "client_id" && !c.gh);
    if (needsClient) {
      const card = panel.locator(`[data-testid="mcp-connector"][data-id="${needsClient.id}"]`);
      await card.getByTestId("mcp-connector-setup").click();
      await expect(card.getByTestId("mcp-connector-form")).toContainText(info.redirect_uri);
    }
    await shoot(page, "mcp-connect-01-apps");

    await panel.getByTestId("mcp-registry-q").fill("io.example");
    await panel.getByTestId("mcp-registry-q").press("Enter");
    const hits = panel.getByTestId("mcp-registry-hit");
    await expect(hits).toHaveCount(1);
    const hit = hits.first();
    await expect(hit).toContainText("Team tools");
    // The header it requires is asked for before anything is added.
    await hit.getByTestId("mcp-registry-add").click();
    await expect(hit).toContainText("needs X-Team");
    await hit.getByLabel(/X-Team/).fill("tools");
    await shoot(page, "mcp-connect-02-registry");
    await hit.getByTestId("mcp-registry-add").click();
    await expect(hit).toContainText("In Keel");
    const server = async () => (await (await request.get("/api/mcp/servers")).json()).servers.find((s: any) => s.name === "team-tools");
    await expect.poll(async () => (await server())?.state, { timeout: 20_000 }).toBe("needs_auth");

    // Signing in is the server's own page.
    await panel.locator('[data-testid="mcp-entry"]').filter({ hasText: "team-tools" }).first().click();
    const row = panel.locator('[data-testid="mcp-server"][data-name="team-tools"]');
    const [popup] = await Promise.all([page.context().waitForEvent("page"), row.getByTestId("mcp-sign-in").click()]);
    await popup.waitForLoadState();
    await popup.getByRole("button", { name: "Allow" }).click();
    await expect(popup.locator("body")).toContainText("team-tools is connected");
    await popup.close();
    await expect(row).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
    await shoot(page, "mcp-connect-03-ready");

    await request.delete("/api/mcp/servers/team-tools");
    const errorsAfter = (await (await request.get("/api/errors")).json()).errors.length;
    expect(errorsAfter).toBe(errorsBefore);
  } finally {
    fx.kill();
  }
});
