import { expect, test } from "./isolate.ts";
import type { APIRequestContext } from "@playwright/test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { shoot } from "./shots.ts";

// Feature: a legacy Streamable HTTP MCP server, the kind with a session. The
// stand-in is such a server on this machine; no model is asked anything (the
// calls come from the scripted provider).
async function standIn(request: APIRequestContext, name: string) {
  const fx = spawn("bun", [join(import.meta.dirname, "fixtures/legacy-http-mcp.ts")], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((res) => createInterface({ input: fx.stdout! }).once("line", res));
  const base = `http://127.0.0.1:${port}`;
  await request.delete(`/api/mcp/servers/${name}`).catch(() => {});
  await request.post("/api/mcp/servers", { data: { name, url: `${base}/mcp` } });
  const row = async () => ((await (await request.get("/api/mcp/servers")).json()).servers as any[]).find((s) => s.name === name);
  const stop = async () => {
    await request.delete(`/api/mcp/servers/${name}`).catch(() => {});
    fx.kill();
  };
  await expect.poll(async () => (await row())?.state, { timeout: 20_000 }).toBe("ready").catch(async (e) => { await stop(); throw e; });
  return {
    row,
    stats: async () => (await request.get(`${base}/stats`)).json(),
    control: async (data: Record<string, unknown>) => (await request.post(`${base}/control`, { data })).json(),
    stop,
  };
}

// The server ends the session (it restarted, or it expires sessions). The call
// that finds out is refused by the server and reported once; Keel starts a new
// session by itself and the next call the model makes runs there. The refused
// call reaches the server once: nothing sends it again.
test("mcp http: a session the server ended", async ({ page, request }) => {
  const s = await standIn(request, "legacy");
  try {
    await request.put("/api/permissions/settings", { data: { default_mode: "full-auto" } });
    const session = (await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", title: "MCP session ended" } })).json()).session;
    const call = (text: string) => ({ name: "mcp_call", input: { tool: "legacy__echo", arguments: { text } } });
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([call("before")])}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("assistant-text").last()).toContainText("echo: before");
    const connected = (await s.row()).last_connected;

    await s.control({ expire: true });
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([call("refused"), call("after")])}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId("assistant-text").last()).toContainText("echo: after");

    // One refusal, then the call on the new session; the refused one arrived once.
    const st = await s.stats();
    expect(st.calls.map((c: any) => c.status)).toEqual([200, 404, 200]);
    expect(st.initializes).toBe(2);
    expect(st.calls[2].session).not.toBe(st.calls[1].session);
    const row = await s.row();
    expect(row.state).toBe("ready");
    expect(row.last_connected).toBeGreaterThan(connected);
    const results = ((await (await request.get(`/api/sessions/${session.id}`)).json()).events as any[]).filter((e) => e.kind === "tool_result").map((e) => JSON.stringify(e.data));
    expect(results.filter((r) => r.includes("was not sent again"))).toHaveLength(1);

    const calls = page.getByTestId("tool-call");
    await calls.nth(1).click();
    await expect(calls.nth(1)).toContainText("was not sent again");
    await shoot(page, "mcp-http-01-session-ended");
    await request.delete(`/api/sessions/${session.id}`);
  } finally {
    await s.stop();
  }
});

// What the server sends on its own, with no request open: a changed tool
// list, a changed resource list, a changed resource. They come on the stream
// Keel holds open with GET; the panel lists again and marks an open body.
test("mcp http: updates the server sends on its own", async ({ page, request }) => {
  const s = await standIn(request, "legacy");
  try {
    await expect.poll(async () => (await s.stats()).streams_open).toBe(1);
    await page.goto("/");
    await page.getByTestId("composer").fill("/mcp");
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("mcp-panel");
    await panel.locator('[data-testid="mcp-entry"]').filter({ hasText: "legacy" }).first().click();
    const row = panel.locator('[data-testid="mcp-server"][data-name="legacy"]');
    await expect(row.getByTestId("mcp-tool-count")).toHaveText("2 tools");
    await row.getByTestId("mcp-contents-toggle").click();
    await expect(row.getByTestId("mcp-resource")).toHaveText(["legacy://one", "legacy://two"]);
    await row.getByTestId("mcp-resource").filter({ hasText: "legacy://one" }).click();
    await expect(row.getByTestId("mcp-content-text")).toContainText("legacy://one version 1");
    await expect(row.getByTestId("mcp-resource-stale")).toHaveCount(0);

    expect((await s.control({ emit: "tools/list_changed" })).sent).toBe(1);
    await expect(row.getByTestId("mcp-tool-count")).toHaveText("3 tools");
    await s.control({ emit: "resources/list_changed" });
    await expect(row.getByTestId("mcp-resource")).toHaveText(["legacy://one", "legacy://two", "legacy://three"]);
    await s.control({ emit: "resources/updated" });
    await expect(row.getByTestId("mcp-resource-stale")).toBeVisible();
    await shoot(page, "mcp-http-02-updates");
    await row.getByTestId("mcp-resource-stale").click();
    await expect(row.getByTestId("mcp-content-text")).toContainText("legacy://one version 2");
    await expect(row.getByTestId("mcp-resource-stale")).toHaveCount(0);

    // Reconnect replaces the connection: one stream stays open, the old one closed by Keel.
    await row.getByTestId("mcp-reconnect").click();
    await expect.poll(async () => (await s.stats()).streams_closed).toBe(1);
    await expect.poll(async () => (await s.stats()).streams_open).toBe(1);
  } finally {
    await s.stop();
  }
});
