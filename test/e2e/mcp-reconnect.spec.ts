import { expect, test } from "./isolate.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shoot } from "./shots.ts";

// Feature: a call that failed because its MCP server is down offers Reconnect on its own row. The press
// starts the server again and never runs the call again; the model is told the server is back with the
// next message.
test("a failed call's row reconnects its MCP server", async ({ page, request }) => {
  const models = (await (await request.get("/api/models")).json()).models as { id: string }[];
  test.skip(!models.some((m) => m.id === "scripted:stand-in"), "needs a scripted scratch daemon: the calls are scripted");
  const dir = join(process.env.HOME!, ".cache/keel-work/bun/e2e-ws", `reconnect-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const up = join(dir, "up");
  const fixture = join(import.meta.dirname, "fixtures/echo-mcp.ts");
  const state = async () => ((await (await request.get("/api/mcp/servers")).json()).servers as { name: string; state: string }[]).find((s) => s.name === "flaky")?.state;
  let id = "";
  try {
    await request.post("/api/mcp/servers", { data: { name: "flaky", command: "bun", args: [fixture, `--down-unless=${up}`] } });
    await expect.poll(state, { timeout: 30_000 }).toMatch(/^(error|unreachable)$/);
    const { session } = await (await request.post("/api/sessions", { data: { model: "scripted:stand-in", workspace: dir, title: "A server that is down" } })).json();
    id = session.id;
    await request.put(`/api/sessions/${id}/permissions`, { data: { mode: "full-auto", sandbox: "off" } });
    await page.goto(`/s/${id}`);
    await page.getByTestId("composer").fill(`script:calls ${JSON.stringify([{ name: "mcp_call", input: { tool: "flaky__echo", arguments: { text: "hello" } } }])}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 60_000 });

    const row = page.getByTestId("mcp-reconnect");
    await expect(row).toHaveAttribute("data-state", "down");
    await expect(row).toContainText("flaky is not connected");
    await shoot(page, "mcp-reconnect-01-down");

    // The owner fixes what kept it down and presses Reconnect: the server is ready, the call is not run again.
    writeFileSync(up, "");
    await row.getByTestId("mcp-reconnect-act").click();
    await expect(row).toHaveAttribute("data-state", "back", { timeout: 30_000 });
    expect(await state()).toBe("ready");
    await shoot(page, "mcp-reconnect-02-back");
    // The owner's window: 1320x860 at the small text size.
    await page.setViewportSize({ width: 1320, height: 860 });
    await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "0.9"));
    await shoot(page, "mcp-reconnect-03-1320x860-small");
    await page.evaluate(() => document.documentElement.style.setProperty("--ui-scale", "1"));
    await page.setViewportSize({ width: 1920, height: 1040 });

    // The next message carries the note; the model reads it there.
    await page.getByTestId("composer").fill("script:find brought");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 60_000 });
    await expect(page.getByTestId("assistant-text").last()).toContainText("The MCP server flaky is connected again");
    const events = ((await (await request.get(`/api/sessions/${id}`)).json()).events as { kind: string; data: any }[]);
    const calls = events.filter((e) => e.kind === "assistant").flatMap((e) => (e.data.blocks ?? []) as { type: string; name?: string }[]).filter((b) => b.type === "tool_use");
    expect(calls).toHaveLength(1);
  } finally {
    if (id) await request.delete(`/api/sessions/${id}`);
    await request.delete("/api/mcp/servers/flaky").catch(() => {});
  }
});
